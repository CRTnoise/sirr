'use strict';
/**
 * Sirr Vault — at-rest encryption
 * ═══════════════════════════════════════════════════════════════════
 * Everything on disk is encrypted: messages (SQLite + its WAL), spilled
 * images, received files and config.json, which holds every room code,
 * i.e. every join secret.
 *
 * One random 256-bit data key, itself sealed by the OS keystore
 * (DPAPI / Keychain / libsecret via Electron safeStorage — the same
 * protection the identity key already gets). Everything else is
 * encrypted under keys derived from it:
 *
 *   seal/open      XSalsa20-Poly1305 (tweetnacl secretbox), random nonce
 *   mac            HMAC-SHA256 — deterministic lookup keys (room / channel
 *                  columns) so SQLite indexes still work without the
 *                  plaintext ever touching disk
 *   file records   AES-256-GCM, one record per write, per-file key —
 *                  lets received files stream to disk encrypted and be
 *                  resumed, then decrypted only when the user saves them
 *
 * If the OS keystore is unavailable, the data key sits in a 0600 file
 * (same fallback, and same warning, as the identity key).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const SEAL_PREFIX = 'pv1:';
const FILE_MAGIC = Buffer.from('SRVF1\n');

class Vault {
  /**
   * @param {string} dir
   * @param {{isAvailable:()=>boolean, encrypt:(s:string)=>string, decrypt:(b:string)=>string}} [secretBox]
   */
  /**
   * @param {object} [opts]
   * @param {Buffer} [opts.externalKey]  32-byte key held by the platform
   *        (Sirr Mobile: generated + wrapped by the Android Keystore).
   *        Never written to disk; datakey.json only stores a check value.
   */
  constructor(dir, secretBox, opts = {}) {
    this.dir = dir;
    this.box = secretBox || null;
    this.externalKey = opts.externalKey && opts.externalKey.length === 32 ? Buffer.from(opts.externalKey) : null;
    this.keyPath = path.join(dir, 'datakey.json');
    this.key = null;
    this.protectedByKeystore = false;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.externalKey) return this._initExternal();
    if (fs.existsSync(this.keyPath)) {
      const j = JSON.parse(fs.readFileSync(this.keyPath, 'utf8'));
      if (j.v === 2 && j.sealed) {
        if (!this.box || !this.box.isAvailable()) throw new Error('data key is keystore-sealed but the OS keystore is unavailable');
        this.key = Buffer.from(this.box.decrypt(j.sealed), 'base64');
        this.protectedByKeystore = true;
      } else {
        this.key = Buffer.from(j.key, 'base64');
        // Upgrade to keystore protection as soon as it becomes available.
        if (this.box && this.box.isAvailable()) this._persist();
      }
    } else {
      this.key = crypto.randomBytes(32);
      this._persist();
    }
    if (this.key.length !== 32) throw new Error('bad data key');
    this._sealKey = this._sub('seal');
    this._macKey = this._sub('mac');
    this._fileKey = this._sub('file');
    return this;
  }

  _initExternal() {
    const check = (k) => crypto.createHmac('sha256', k).update('sirr/vault/check').digest('hex').slice(0, 32);
    if (fs.existsSync(this.keyPath)) {
      const j = JSON.parse(fs.readFileSync(this.keyPath, 'utf8'));
      if (j.v === 3) {
        if (j.check !== check(this.externalKey)) throw new Error('platform key does not match this data (keystore was reset?)');
        this.key = this.externalKey;
      } else {
        // Data from before the platform key existed: keep its own key.
        return (this.externalKey = null, this.init());
      }
    } else {
      this.key = this.externalKey;
      fs.writeFileSync(this.keyPath, JSON.stringify({ v: 3, external: true, check: check(this.key) }), { mode: 0o600 });
    }
    this.protectedByKeystore = true;
    this._sealKey = this._sub('seal');
    this._macKey = this._sub('mac');
    this._fileKey = this._sub('file');
    return this;
  }

  _persist() {
    const b64 = this.key.toString('base64');
    let body;
    if (this.box && this.box.isAvailable()) {
      body = { v: 2, sealed: this.box.encrypt(b64) };
      this.protectedByKeystore = true;
    } else {
      body = { v: 1, key: b64 };
      this.protectedByKeystore = false;
    }
    const tmp = this.keyPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, this.keyPath);
    try { fs.chmodSync(this.keyPath, 0o600); } catch (e) {}
  }

  /** Re-seal the data key through the (possibly changed) adapter. */
  reseal() { if (!this.externalKey) this._persist(); }

  _sub(label) { return crypto.createHmac('sha256', this.key).update('sirr/vault/1|' + label).digest(); }

  // ─── strings / small blobs ─────────────────────────────────────────
  isSealed(s) { return typeof s === 'string' && s.startsWith(SEAL_PREFIX); }

  seal(data) {
    const pt = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const nonce = crypto.randomBytes(24);
    const ct = nacl.secretbox(new Uint8Array(pt), new Uint8Array(nonce), new Uint8Array(this._sealKey));
    return SEAL_PREFIX + Buffer.concat([nonce, Buffer.from(ct)]).toString('base64');
  }

  /** @returns {Buffer} */
  openBuf(s) {
    if (!this.isSealed(s)) throw new Error('not sealed');
    const raw = Buffer.from(s.slice(SEAL_PREFIX.length), 'base64');
    const pt = nacl.secretbox.open(new Uint8Array(raw.subarray(24)), new Uint8Array(raw.subarray(0, 24)), new Uint8Array(this._sealKey));
    if (!pt) throw new Error('vault: authentication failed');
    return Buffer.from(pt);
  }
  open(s) { return this.openBuf(s).toString('utf8'); }

  /** Deterministic keyed hash for index columns. */
  mac(s) { return crypto.createHmac('sha256', this._macKey).update(String(s)).digest('hex').slice(0, 40); }

  // ─── files: append-only encrypted records ──────────────────────────
  // Layout: "SRVF1\n" ‖ salt(16) ‖ { len u32 ‖ ciphertext ‖ tag(16) }*
  // Record i uses nonce = i (u64 LE) ‖ 0000 under key HMAC(fileKey, salt).
  // Plaintext offsets are implied by record order, so a writer that only
  // appends in order (as BOLT and legacy receives do) can resume by
  // counting records.
  fileWriter(fh) { return new EncWriter(this, fh); }
  _fileKeyFor(salt) { return crypto.createHmac('sha256', this._fileKey).update(salt).digest(); }

  /** Decrypt a vault file fully into memory (≤ caller's limit). */
  async readFile(p, maxBytes = Infinity) {
    const chunks = [];
    let total = 0;
    for await (const c of this.iterFile(p)) {
      total += c.length;
      if (total > maxBytes) throw new Error('too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /** Stream-decrypt a vault file to a plaintext destination path. */
  async decryptFileTo(src, dest) {
    const out = await fs.promises.open(dest, 'w');
    try {
      for await (const c of this.iterFile(src)) {
        let off = 0;
        while (off < c.length) { const { bytesWritten } = await out.write(c, off, c.length - off); off += bytesWritten; }
      }
    } finally { await out.close(); }
  }

  async *iterFile(p) {
    const fh = await fs.promises.open(p, 'r');
    try {
      if ((await fh.stat()).size === 0) return;      // zero-byte file: nothing was ever appended
      const head = Buffer.alloc(FILE_MAGIC.length + 16);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      if (bytesRead !== head.length || !head.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) throw new Error('not a vault file');
      const key = this._fileKeyFor(head.subarray(FILE_MAGIC.length));
      let pos = head.length, idx = 0;
      const lenBuf = Buffer.alloc(4);
      for (;;) {
        const r = await fh.read(lenBuf, 0, 4, pos);
        if (r.bytesRead === 0) break;
        if (r.bytesRead !== 4) throw new Error('truncated vault file');
        const n = lenBuf.readUInt32LE(0);
        if (n > 64 * 1024 * 1024) throw new Error('corrupt vault record');
        const rec = Buffer.alloc(n + 16);
        const r2 = await fh.read(rec, 0, rec.length, pos + 4);
        if (r2.bytesRead !== rec.length) throw new Error('truncated vault record');
        const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(idx), { authTagLength: 16 });
        d.setAuthTag(rec.subarray(n));
        const pt = Buffer.concat([d.update(rec.subarray(0, n)), d.final()]);
        yield pt;
        pos += 4 + n + 16; idx++;
      }
    } finally { await fh.close(); }
  }

  /** Overwrite then unlink (best effort — SSDs may keep copies; still better than a plain unlink). */
  static shred(p) {
    try {
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r+');
      const zero = Buffer.alloc(Math.min(st.size, 1 << 20));
      for (let off = 0; off < st.size; off += zero.length) fs.writeSync(fd, zero, 0, Math.min(zero.length, st.size - off), off);
      fs.fsyncSync(fd); fs.closeSync(fd);
    } catch (e) {}
    try { fs.unlinkSync(p); } catch (e) {}
  }
}

function nonceFor(i) { const n = Buffer.alloc(12); n.writeBigUInt64LE(BigInt(i), 0); return n; }

class EncWriter {
  constructor(vault, fh) {
    this.v = vault; this.fh = fh; this.pos = 0; this.idx = 0; this.key = null;
  }
  async _head() {
    const salt = crypto.randomBytes(16);
    this.key = this.v._fileKeyFor(salt);
    const head = Buffer.concat([FILE_MAGIC, salt]);
    await writeAll(this.fh, head, 0);
    this.pos = head.length;
  }
  /** Append one plaintext chunk as an encrypted record. */
  async append(pt) {
    if (!this.key) await this._head();
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonceFor(this.idx), { authTagLength: 16 });
    const ct = Buffer.concat([c.update(pt), c.final()]);
    const rec = Buffer.allocUnsafe(4 + ct.length + 16);
    rec.writeUInt32LE(ct.length, 0);
    ct.copy(rec, 4);
    c.getAuthTag().copy(rec, 4 + ct.length);
    await writeAll(this.fh, rec, this.pos);
    this.pos += rec.length; this.idx++;
  }
}
async function writeAll(fh, buf, pos) {
  let off = 0;
  while (off < buf.length) { const { bytesWritten } = await fh.write(buf, off, buf.length - off, pos + off); off += bytesWritten; }
}

module.exports = Vault;
