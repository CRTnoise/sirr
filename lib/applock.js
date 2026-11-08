'use strict';
/**
 * App lock, duress passphrase and panic wipe
 * ═══════════════════════════════════════════════════════════════════
 * The data key (vault.js) and the identity key (crypto-layer.js) are both
 * sealed through a `secretBox` adapter, normally the OS keystore. The
 * keystore opens with the OS login, so a laptop taken while logged in —
 * or an OS account someone else can open — would open Sirr too.
 *
 * With the lock on, everything that adapter seals is first wrapped under a
 * key-encryption key derived from a passphrase:
 *
 *   K   = scrypt(passphrase, salt, N=2^17, r=8, p=1)
 *   KEK = HMAC-SHA256(K, "sirr/lock/kek")
 *   sealed = keystore( "lk1:" ‖ base64(nonce ‖ secretbox(value, nonce, KEK)) )
 *
 * Nothing is decryptable before the passphrase is typed, and the main
 * window, the network and the IPC surface don't exist until then.
 *
 * lock.json holds { salt, check, duress }:
 *   check  = HMAC(K, "sirr/lock/check")    — recognises the passphrase
 *   duress = HMAC(K', "sirr/lock/duress")  — K' from the duress passphrase
 *            (random bytes when none is set, so its presence reveals nothing)
 *
 * Typing the duress passphrase crypto-shreds everything (wipe(), below) and
 * Sirr starts as a fresh install.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const KDF = { name: 'scrypt', N: 1 << 17, r: 8, p: 1 };
const PREFIX = 'lk1:';
const MIN = 8;

function _k(pass, salt, kdf = KDF) {
  const { N, r, p } = kdf;
  if (!(N >= 1 << 14 && N <= 1 << 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) throw new Error('bad lock parameters');
  return crypto.scryptSync(String(pass).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 160 * N * r });
}
const _h = (k, label) => crypto.createHmac('sha256', k).update(label).digest();
const _eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

class AppLock {
  /**
   * @param {string} dir   data directory (holds lock.json)
   * @param {object} inner the OS keystore adapter ({isAvailable, encrypt, decrypt}) or null
   */
  constructor(dir, inner) {
    this.dir = dir;
    this.inner = inner || null;
    this.file = path.join(dir, 'lock.json');
    this.kek = null;          // Buffer while unlocked with the lock on
    this.wrap = false;        // seal new values under the KEK
  }

  isEnabled() { return fs.existsSync(this.file); }
  isUnlocked() { return !this.isEnabled() || !!this.kek; }

  _read() {
    const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!j || j.v !== 1) throw new Error('unrecognised lock file');
    return j;
  }

  /** @returns {'ok'|'duress'|'bad'} */
  unlock(pass) {
    const j = this._read();
    const K = _k(pass, Buffer.from(j.salt, 'base64'), j.kdf || KDF);
    try {
      if (_eq(_h(K, 'sirr/lock/check'), Buffer.from(j.check, 'base64'))) {
        this.kek = _h(K, 'sirr/lock/kek');
        this.wrap = true;
        return 'ok';
      }
      if (_eq(_h(K, 'sirr/lock/duress'), Buffer.from(j.duress, 'base64'))) return 'duress';
      return 'bad';
    } finally { K.fill(0); }
  }

  /**
   * Turn the lock on (or change the passphrase). The caller re-seals the
   * data key and identity afterwards through box().
   */
  enable(pass, duressPass) {
    if ([...String(pass || '')].length < MIN) throw new Error('Use a passphrase of at least ' + MIN + ' characters.');
    if (duressPass && String(duressPass) === String(pass)) throw new Error('The duress passphrase must differ from the passphrase.');
    const salt = crypto.randomBytes(16);
    const K = _k(pass, salt);
    const body = {
      v: 1, kdf: KDF, salt: salt.toString('base64'),
      check: _h(K, 'sirr/lock/check').toString('base64'),
      duress: duressPass
        ? (() => { const D = _k(duressPass, salt); const d = _h(D, 'sirr/lock/duress'); D.fill(0); return d.toString('base64'); })()
        : crypto.randomBytes(32).toString('base64'),
    };
    const kek = _h(K, 'sirr/lock/kek');
    K.fill(0);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    // Values sealed under the previous KEK must still open until the
    // caller has re-sealed them; keep it as a fallback.
    this._oldKek = this.kek;
    this.kek = kek;
    this.wrap = true;
  }

  /** Stop wrapping new values. Call disableCommit() once re-sealed. */
  disableBegin() { this.wrap = false; }
  disableCommit() {
    this._shred(this.file);
    if (this.kek) this.kek.fill(0);
    this.kek = null; this._oldKek = null;
  }

  /** The adapter handed to Vault and SirrCrypto. */
  box() {
    const self = this;
    const innerOk = () => { try { return !!(self.inner && self.inner.isAvailable()); } catch (e) { return false; } };
    const openWith = (s) => {
      const raw = Buffer.from(s.slice(PREFIX.length), 'base64');
      for (const k of [self.kek, self._oldKek]) {
        if (!k) continue;
        const pt = nacl.secretbox.open(new Uint8Array(raw.subarray(24)), new Uint8Array(raw.subarray(0, 24)), new Uint8Array(k));
        if (pt) return Buffer.from(pt).toString('utf8');
      }
      throw new Error('locked');
    };
    return {
      isAvailable: () => (self.wrap && !!self.kek) || innerOk(),
      encrypt: (s) => {
        let v = String(s);
        if (self.wrap && self.kek) {
          const nonce = crypto.randomBytes(24);
          const ct = nacl.secretbox(new Uint8Array(Buffer.from(v, 'utf8')), new Uint8Array(nonce), new Uint8Array(self.kek));
          v = PREFIX + Buffer.concat([nonce, Buffer.from(ct)]).toString('base64');
          // No keystore: the passphrase layer alone, marked so decrypt knows.
          if (!innerOk()) return v;
        }
        return self.inner.encrypt(v);
      },
      decrypt: (b) => {
        const s = String(b);
        if (s.startsWith(PREFIX)) return openWith(s);
        const v = self.inner.decrypt(s);
        return v.startsWith(PREFIX) ? openWith(v) : v;
      },
    };
  }

  // ─── Panic wipe ──────────────────────────────────────────────────
  // Crypto-shredding: the data key and the identity key are tiny files.
  // Overwrite and delete them first — from that moment every message,
  // file and room code on disk is ciphertext under a key that no longer
  // exists. The rest of the directory is deleted after, best effort.
  // (Flash storage may keep old copies of the key files; with the lock on
  // those copies are still sealed under the passphrase.)
  _shred(p) {
    try {
      const st = fs.statSync(p);
      const fd = fs.openSync(p, 'r+');
      try { fs.writeSync(fd, crypto.randomBytes(Math.max(64, st.size)), 0, undefined, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) {}
    try { fs.unlinkSync(p); } catch (e) {}
  }

  wipe() {
    if (this.kek) this.kek.fill(0);
    this.kek = null; this._oldKek = null; this.wrap = false;
    for (const f of ['datakey.json', 'identity.json', 'identity.json.locked', 'lock.json', 'datakey.json.tmp', 'identity.json.tmp']) {
      this._shred(path.join(this.dir, f));
    }
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) {}
  }
}

AppLock.MIN = MIN;
module.exports = AppLock;
