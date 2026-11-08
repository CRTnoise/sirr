const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * SirrCrypto — identity + per-peer session keys.
 *
 * Identity-at-rest (v2): the long-term secret key is encrypted with the
 * OS keystore (Electron safeStorage → DPAPI / Keychain / libsecret) when a
 * `secretBox` adapter is provided and available. File layout:
 *
 *   v2: { version: 2, publicKey, secretKeyEnc, createdAt }   (encrypted)
 *   v1: { publicKey, secretKey, createdAt }                  (legacy plaintext)
 *
 * v1 files are migrated to v2 transparently on first launch where the OS
 * keystore is available. If it isn't (e.g. Linux without a keyring), we
 * fall back to plaintext but always clamp file permissions to 0600.
 */
class SirrCrypto {
  /**
   * @param {string} dir  config directory
   * @param {{isAvailable():boolean, encrypt(s:string):string, decrypt(b64:string):string}=} secretBox
   *        optional at-rest encryptor (main process passes a safeStorage adapter)
   */
  constructor(dir, secretBox) {
    this.configDir = dir;
    this.identityPath = path.join(dir, 'identity.json');
    this.identity = null;
    this.sessionKeys = new Map();
    this.secretBox = secretBox || null;
    this.atRestEncrypted = false;
  }

  _boxAvailable() {
    try { return !!(this.secretBox && this.secretBox.isAvailable()); }
    catch (e) { return false; }
  }

  _chmodSafe(p) {
    // 0600 on POSIX; harmless no-op effect on Windows (ACLs apply there).
    try { fs.chmodSync(p, 0o600); } catch (e) {}
  }

  _writeIdentityFile(pubB64, secB64) {
    let record;
    if (this._boxAvailable()) {
      try {
        record = {
          version: 2,
          publicKey: pubB64,
          secretKeyEnc: this.secretBox.encrypt(secB64),
          createdAt: new Date().toISOString(),
        };
        this.atRestEncrypted = true;
      } catch (e) { record = null; }
    }
    if (!record) {
      // Keystore unavailable — plaintext fallback, permissions clamped.
      record = { version: 1, publicKey: pubB64, secretKey: secB64, createdAt: new Date().toISOString() };
      this.atRestEncrypted = false;
    }
    const tmp = this.identityPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.identityPath);
    this._chmodSafe(this.identityPath);
  }

  /** Re-seal the identity key through the (possibly changed) adapter. */
  reseal() {
    this._writeIdentityFile(naclUtil.encodeBase64(this.identity.publicKey), naclUtil.encodeBase64(this.identity.secretKey));
  }

  _loadIdentityFile() {
    const d = JSON.parse(fs.readFileSync(this.identityPath, 'utf8'));
    if (d && d.secretKeyEnc) {
      if (!this._boxAvailable()) {
        throw new Error('Identity is keystore-encrypted but the OS keystore is unavailable');
      }
      const secB64 = this.secretBox.decrypt(d.secretKeyEnc);
      this.atRestEncrypted = true;
      return { publicKey: d.publicKey, secretKey: secB64, migrated: false };
    }
    if (d && d.secretKey) {
      // Legacy plaintext — flag for migration.
      return { publicKey: d.publicKey, secretKey: d.secretKey, migrated: this._boxAvailable() };
    }
    throw new Error('Unrecognized identity file format');
  }

  async init() {
    if (!fs.existsSync(this.configDir)) fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.identityPath)) {
      let d = null;
      try {
        d = this._loadIdentityFile();
      } catch (e) {
        // The identity file exists but couldn't be read — most likely it's
        // keystore-encrypted and the OS keyring is locked/unavailable this
        // session (common on a fresh Linux box with no unlocked keyring).
        // We must NOT hard-fail here: a blank identity bricks the whole app.
        // Surface the reason and fall through to generating a fresh identity
        // so the app is at least usable. (The old identity file is preserved
        // on disk; if the keyring comes back, a future launch recovers it.)
        console.error('[sirr] could not load existing identity:', e.message,
          '\n[sirr] generating a temporary identity for this session. Your previous identity is NOT lost — it is still on disk and will load once the OS keyring is available (try: unlock your login keyring, or install gnome-keyring/kwallet).');
        d = null;
      }
      if (d) {
        this.identity = {
          publicKey: naclUtil.decodeBase64(d.publicKey),
          secretKey: naclUtil.decodeBase64(d.secretKey),
        };
        if (d.migrated) {
          try { this._writeIdentityFile(d.publicKey, d.secretKey); } catch (e) {}
        } else {
          this._chmodSafe(this.identityPath);
        }
      } else {
        // Recovery path: keep the unreadable file as a backup, mint a fresh
        // identity so the user can still use the app this session.
        try { fs.copyFileSync(this.identityPath, this.identityPath + '.locked'); } catch (e) {}
        this.identity = nacl.box.keyPair();
        this._writeIdentityFile(
          naclUtil.encodeBase64(this.identity.publicKey),
          naclUtil.encodeBase64(this.identity.secretKey),
        );
      }
    } else {
      this.identity = nacl.box.keyPair();
      this._writeIdentityFile(
        naclUtil.encodeBase64(this.identity.publicKey),
        naclUtil.encodeBase64(this.identity.secretKey),
      );
    }
    return this.getFingerprint();
  }

  // ── Backup portability ─────────────────────────────────────────────
  // Backups must work across machines, so they carry the *plaintext* key
  // pair regardless of how the local file is stored. The export UI is
  // responsible for warning loudly. Import re-saves through the normal
  // at-rest path (so it lands keystore-encrypted on the new machine).
  exportIdentity() {
    if (!this.identity) return null;
    return {
      publicKey: naclUtil.encodeBase64(this.identity.publicKey),
      secretKey: naclUtil.encodeBase64(this.identity.secretKey),
    };
  }
  importIdentity(idObj) {
    if (!idObj || !idObj.publicKey || !idObj.secretKey) return false;
    // Validate before persisting — a corrupt backup must not brick the app.
    const pub = naclUtil.decodeBase64(String(idObj.publicKey));
    const sec = naclUtil.decodeBase64(String(idObj.secretKey));
    if (pub.length !== nacl.box.publicKeyLength || sec.length !== nacl.box.secretKeyLength) return false;
    this.identity = { publicKey: pub, secretKey: sec };
    this.sessionKeys.clear(); // sessions derived from the old key are invalid
    this._roomSign = new Map();
    this._writeIdentityFile(idObj.publicKey, idObj.secretKey);
    return true;
  }

  // Identity digests are asked for on nearly every message, so they're
  // computed once per identity key (importIdentity resets the cache).
  _ids() {
    if (!this._idCache || this._idCache.pub !== this.identity.publicKey) {
      const hex = crypto.createHash('sha256').update(this.identity.publicKey).digest('hex');
      this._idCache = {
        pub: this.identity.publicKey,
        pub64: naclUtil.encodeBase64(this.identity.publicKey),
        id: hex,
        fp: hex.toUpperCase().slice(0, 16).match(/.{4}/g).join(' '),
      };
    }
    return this._idCache;
  }
  getPublicKeyB64() { return this._ids().pub64; }
  getFingerprint() { return this._ids().fp; }
  // Full 256-bit identity. The 16-hex fingerprint above is for humans;
  // authorization pins this instead (see storage.pinIdentity).
  getIdentityId() { return this._ids().id; }
  identityIdFor(pub64) { return crypto.createHash('sha256').update(naclUtil.decodeBase64(pub64)).digest('hex'); }
  getFingerprintFor(pub64) { return crypto.createHash('sha256').update(naclUtil.decodeBase64(pub64)).digest('hex').toUpperCase().slice(0, 16).match(/.{4}/g).join(' '); }

  // ── Session handshake (kx v3) ────────────────────
  // Each connection gets fresh X25519 ephemerals. With s = identity and
  // e = ephemeral, and L/H the two parties ordered by identity key:
  //
  //   ikm = DH(eL,eH) ‖ DH(eL,sH) ‖ DH(sL,eH)
  //   K   = HMAC-SHA256(HMAC-SHA256("sirr/kx/3", ikm), transcript)
  //   transcript = "sirr/kx/3|" sL "|" sH "|" eL "|" eH "|" binding
  //
  // - DH(eL,eH) makes the session forward-secret: once both ephemerals are
  //   burnt, a later theft of either identity key decrypts nothing.
  // - The two mixed terms authenticate: only the holders of sL and sH can
  //   compute them. Neither involves sL and sH together, so a thief holding
  //   one party's identity key still can't impersonate *anyone else* to
  //   that party (no key-compromise impersonation) — they'd need the other
  //   side's ephemeral secret, which never leaves its process.
  // - `binding` is the pair of transport keys of this socket, so a session
  //   can't be spliced onto another connection.
  // Each side proves K with confirm = HMAC(K, "confirm|" own identity);
  // the session key is HMAC(K, "session").

  beginEphemeral(peerId) {
    // One ephemeral pair per connection (reused if KEY_EXCHANGE is resent).
    let eph = this._ephemeral && this._ephemeral.get(peerId);
    if (!eph) {
      eph = nacl.box.keyPair();
      if (!this._ephemeral) this._ephemeral = new Map();
      this._ephemeral.set(peerId, eph);
    }
    return { ephPub64: naclUtil.encodeBase64(eph.publicKey) };
  }

  _kxKey(eph, peerIdentPub64, peerEphPub64, binding) {
    const mine = this.getPublicKeyB64();
    if (peerIdentPub64 === mine) throw new Error('self handshake');
    const pI = naclUtil.decodeBase64(peerIdentPub64), pE = naclUtil.decodeBase64(peerEphPub64);
    if (pI.length !== 32 || pE.length !== 32) throw new Error('bad key length');
    const myEph64 = naclUtil.encodeBase64(eph.publicKey);
    const iAmL = mine < peerIdentPub64;
    const ee = nacl.scalarMult(eph.secretKey, pE);
    // DH(eL,sH) and DH(sL,eH), from whichever side we are.
    const eLsH = iAmL ? nacl.scalarMult(eph.secretKey, pI) : nacl.scalarMult(this.identity.secretKey, pE);
    const sLeH = iAmL ? nacl.scalarMult(this.identity.secretKey, pE) : nacl.scalarMult(eph.secretKey, pI);
    for (const d of [ee, eLsH, sLeH]) if (d.every(b => b === 0)) throw new Error('low-order key');
    const prk = crypto.createHmac('sha256', 'sirr/kx/3').update(Buffer.concat([ee, eLsH, sLeH])).digest();
    ee.fill(0); eLsH.fill(0); sLeH.fill(0);
    const t = ['sirr/kx/3', iAmL ? mine : peerIdentPub64, iAmL ? peerIdentPub64 : mine,
               iAmL ? myEph64 : peerEphPub64, iAmL ? peerEphPub64 : myEph64, String(binding || '')].join('|');
    const K = crypto.createHmac('sha256', prk).update(t).digest();
    prk.fill(0);
    return K;
  }

  // Our KEY_CONFIRM tag. Derives K and keeps it until the peer's confirm.
  ephemeralAuth(peerId, peerIdentPub64, peerEphPub64, binding = '') {
    const eph = this._ephemeral && this._ephemeral.get(peerId);
    if (!eph) throw new Error('no ephemeral for peer');
    const K = this._kxKey(eph, peerIdentPub64, peerEphPub64, binding);
    // The ephemeral secret is no longer needed: K holds everything.
    eph.secretKey.fill(0);
    this._ephemeral.delete(peerId);
    if (!this._pendingK) this._pendingK = new Map();
    this._pendingK.set(peerId, { K, peerIdentPub64 });
    return crypto.createHmac('sha256', K).update('confirm|' + this.getPublicKeyB64()).digest('base64');
  }

  // Verify the peer's confirm tag and install the session.
  completeEphemeral(peerId, peerIdentPub64, _peerEphPub64, peerTag) {
    const p = this._pendingK && this._pendingK.get(peerId);
    if (!p || p.peerIdentPub64 !== peerIdentPub64) throw new Error('no handshake for peer');
    const expect = crypto.createHmac('sha256', p.K).update('confirm|' + peerIdentPub64).digest();
    const a = Buffer.from(String(peerTag || ''), 'base64');
    if (a.length !== expect.length || !crypto.timingSafeEqual(a, expect)) {
      throw new Error('handshake auth failed');
    }
    const sharedKey = new Uint8Array(crypto.createHmac('sha256', p.K).update('session').digest());
    p.K.fill(0);
    this._pendingK.delete(peerId);
    this.sessionKeys.set(peerId, { sharedKey, peerPub64: peerIdentPub64, established: Date.now(), fs: true });
    return { fingerprint: this.getFingerprintFor(peerIdentPub64) };
  }

  /**
   * A secret only this identity and the holder of `peerPub64` can compute:
   * HMAC(static-static DH, label). Used for pairwise DM rendezvous.
   */
  pairSecret(peerPub64, label) {
    const ss = nacl.box.before(naclUtil.decodeBase64(String(peerPub64)), this.identity.secretKey);
    return crypto.createHmac('sha256', Buffer.from(ss)).update(String(label)).digest();
  }

  isForwardSecret(peerId) { const s = this.sessionKeys.get(peerId); return !!(s && s.fs); }
  clearEphemeral(peerId) { if (this._ephemeral) this._ephemeral.delete(peerId); if (this._pendingK) this._pendingK.delete(peerId); }
  // Every session payload is padded (ISO/IEC 7816-4: 0x80 then zeros) to
  // a bucket — 256 B, 1 KiB, 4 KiB, 16 KiB, then 16 KiB steps — so the
  // length of a record on the wire says little about what's in it.
  static pad(raw) {
    const need = raw.length + 1;
    let size = 256;
    while (size < need && size < 16384) size *= 4;
    if (size < need) size = Math.ceil(need / 16384) * 16384;
    const out = new Uint8Array(size);
    out.set(raw); out[raw.length] = 0x80;
    return out;
  }
  static unpad(buf) {
    let i = buf.length - 1;
    while (i >= 0 && buf[i] === 0) i--;
    if (i < 0 || buf[i] !== 0x80) throw new Error('bad padding');
    return buf.subarray(0, i);
  }
  encrypt(plaintext, peerId) {
    const s = this.sessionKeys.get(peerId); if (!s) throw new Error('No session');
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ct = nacl.box.after(SirrCrypto.pad(naclUtil.decodeUTF8(plaintext)), nonce, s.sharedKey);
    if (!ct) throw new Error('Encrypt failed');
    const pkt = new Uint8Array(nonce.length + ct.length); pkt.set(nonce); pkt.set(ct, nonce.length);
    return naclUtil.encodeBase64(pkt);
  }
  decrypt(enc64, peerId) {
    const s = this.sessionKeys.get(peerId); if (!s) throw new Error('No session');
    const pkt = naclUtil.decodeBase64(enc64);
    const pt = nacl.box.open.after(pkt.slice(nacl.box.nonceLength), pkt.slice(0, nacl.box.nonceLength), s.sharedKey);
    if (!pt) throw new Error('Decrypt failed');
    return naclUtil.encodeUTF8(SirrCrypto.unpad(pt));
  }
  // ─── Per-room signing keys (see lib/msgsig.js) ──────────────
  _roomSignKP(room) {
    if (!this._roomSign) this._roomSign = new Map();
    let kp = this._roomSign.get(room);
    if (!kp) {
      const seed = crypto.createHmac('sha256', Buffer.from(this.identity.secretKey))
        .update('sirr/room-sign/1|' + String(room)).digest();
      kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
      this._roomSign.set(room, kp);
    }
    return kp;
  }
  roomSignPub(room) { return naclUtil.encodeBase64(this._roomSignKP(room).publicKey); }
  signForRoom(room, bytes) {
    return naclUtil.encodeBase64(nacl.sign.detached(new Uint8Array(bytes), this._roomSignKP(room).secretKey));
  }

  /**
   * HMAC-SHA256 of `label` under the session key with this peer — used to
   * derive per-transfer BOLT keys without the raw key leaving this module.
   * Both ends hold the same shared key, so both derive the same result.
   */
  sessionMac(peerId, label) {
    const s = this.sessionKeys.get(peerId); if (!s) throw new Error('No session');
    return crypto.createHmac('sha256', Buffer.from(s.sharedKey)).update(String(label)).digest();
  }
  hasSession(id) { return this.sessionKeys.has(id); }
  removeSession(id) { const x = this.sessionKeys.get(id); if (x) x.sharedKey.fill(0); this.sessionKeys.delete(id); }
  getSessionInfo(id) { const s = this.sessionKeys.get(id); return s ? { fingerprint: this.getFingerprintFor(s.peerPub64), age: Date.now() - s.established } : null; }
  getActiveSessionCount() { return this.sessionKeys.size; }
}
module.exports = SirrCrypto;
