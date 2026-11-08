const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SKIP = 2048;                 // records we'll step over in one go
const REKEY_MS = 10 * 60 * 1000;       // DH rekey at least this often…
const REKEY_MSGS = 5000;               // …or after this many records sent
const _kdf = (key, label) => crypto.createHmac('sha256', key).update(label).digest();
const _mix = (ck, dh) => crypto.createHmac('sha256', ck).update(Buffer.concat([Buffer.from('sirr/rk/1|'), dh])).digest();
function _step(ck) {
  return { mk: _kdf(ck, 'mk'), nonce: _kdf(ck, 'nonce').subarray(0, 24), next: _kdf(ck, 'ck') };
}

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
    if (this.temporaryIdentity) return;
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
          '\n[sirr] using a temporary identity for this session. Your saved identity is untouched and loads again once the OS keyring is available (unlock your login keyring, or install gnome-keyring/kwallet).');
        this.loadError = String(e && e.message || e);
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
        // Recovery path: a fresh identity that lives in memory only. The
        // saved file is never overwritten, so the next launch with a working
        // keyring is the real you again. The UI shows a permanent banner
        // while this is in effect (temporaryIdentity) — contacts will see a
        // different fingerprint, and the user has to know that.
        this.identity = nacl.box.keyPair();
        this.temporaryIdentity = true;
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
    this.temporaryIdentity = false;
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
  // the two ratchet chains and the transfer key base come from K (below).

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
    this._pendingK.set(peerId, { K, peerIdentPub64, myEph64: naclUtil.encodeBase64(eph.publicKey), peerEph64: String(peerEphPub64) });
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
    // One symmetric chain per direction, named by the ephemeral key of the
    // side that sends on it (ephemerals are unique per connection, so the
    // two chains always differ — even between two copies of one identity).
    const now = Date.now();
    const s = {
      peerPub64: peerIdentPub64, established: now, fs: true,
      send: { ck: _kdf(p.K, 'sirr/chain/1|' + p.myEph64), n: 0, epoch: 0 },
      recv: { ck: _kdf(p.K, 'sirr/chain/1|' + p.peerEph64), n: 0, epoch: 0, pending: null },
      boltBase: _kdf(p.K, 'sirr/bolt/1'),
      // Exactly one side starts DH rekeys, so two never cross.
      initiator: p.myEph64 < p.peerEph64,
      rekey: null, rekeyAt: 0, lastRekey: now, sentSinceRekey: 0,
    };
    p.K.fill(0);
    this._pendingK.delete(peerId);
    this.sessionKeys.set(peerId, s);
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
  // ── Session records (envelope v4) ───────────────────────────────
  // Every frame after the handshake travels as one sealed record:
  //
  //   record = epoch (u32 BE) ‖ n (u32 BE) ‖ XSalsa20-Poly1305(pad(frame))
  //
  // Keys come from a per-direction hash ratchet. For message n of the
  // current epoch, with chain key ck:
  //   mk = HMAC(ck, "mk")   nonce = HMAC(ck, "nonce")[0..24]   ck' = HMAC(ck, "ck")
  // and ck is wiped as soon as ck' exists, so a key stolen from memory
  // later opens nothing that was already sent or received. Counters only
  // move forward: a replayed, reordered or truncated record fails, and a
  // failure leaves the chain where it was. A forward gap (a record lost on
  // the way) is skipped up to MAX_SKIP without keeping the skipped keys.
  //
  // Every REKEY_MS (or REKEY_MSGS records) the initiator runs a fresh
  // X25519 exchange inside the session and both chains absorb the result
  // (ck = HMAC(ck, "sirr/rk/1|" ‖ dh)); the epoch counter tells the
  // receiver from which record on. Someone who copied the chain keys
  // without being on the wire is locked out again at the next rekey.
  _sess(peerId) { const s = this.sessionKeys.get(peerId); if (!s) throw new Error('No session'); return s; }

  seal(plaintext, peerId) {
    const s = this._sess(peerId);
    if (s.send.n >= 0xffffffff) throw new Error('send counter exhausted');
    const st = _step(s.send.ck);
    s.send.ck.fill(0); s.send.ck = st.next;
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(s.send.epoch >>> 0, 0); hdr.writeUInt32BE(s.send.n >>> 0, 4);
    s.send.n++; s.sentSinceRekey++;
    const ct = nacl.secretbox(SirrCrypto.pad(Buffer.from(String(plaintext), 'utf8')), st.nonce, st.mk);
    st.mk.fill(0);
    return Buffer.concat([hdr, Buffer.from(ct)]).toString('base64');
  }

  unseal(rec64, peerId) {
    const s = this._sess(peerId);
    const buf = Buffer.from(String(rec64 || ''), 'base64');
    if (buf.length < 8 + nacl.secretbox.overheadLength + 1) throw new Error('short record');
    const epoch = buf.readUInt32BE(0), n = buf.readUInt32BE(4);
    const temps = [];
    let ck = s.recv.ck, from = s.recv.n, rolls = false;
    if (epoch === s.recv.epoch + 1 && s.recv.pending) {
      ck = _mix(ck, s.recv.pending); temps.push(ck); from = 0; rolls = true;
    } else if (epoch !== s.recv.epoch) throw new Error('unexpected epoch');
    if (n < from) throw new Error('replayed or reordered record');
    if (n - from > MAX_SKIP) throw new Error('record gap too large');
    for (let i = from; i < n; i++) { ck = _kdf(ck, 'ck'); temps.push(ck); }
    const st = _step(ck);
    const pt = nacl.secretbox.open(buf.subarray(8), st.nonce, st.mk);
    st.mk.fill(0);
    if (!pt) { for (const t of temps) t.fill(0); st.next.fill(0); throw new Error('Decrypt failed'); }
    // Commit only now: a forged record can't move the chain.
    s.recv.ck.fill(0);
    for (const t of temps) t.fill(0);
    s.recv.ck = st.next; s.recv.n = n + 1;
    if (rolls) { s.recv.pending.fill(0); s.recv.pending = null; s.recv.epoch = epoch; }
    return Buffer.from(SirrCrypto.unpad(pt)).toString('utf8');
  }

  // Initiator: time for a DH rekey?
  needsRekey(peerId, now = Date.now()) {
    const s = this.sessionKeys.get(peerId);
    if (!s || !s.initiator) return false;
    if (s.rekey) {
      // An answer that never came: the link is broken anyway (records in the
      // next epoch would fail), so just allow another attempt later.
      if (now - s.rekeyAt > 5 * 60 * 1000) { s.rekey.secretKey.fill(0); s.rekey = null; }
      return false;
    }
    return now - s.lastRekey >= REKEY_MS || s.sentSinceRekey >= REKEY_MSGS;
  }
  rekeyStart(peerId) {
    const s = this._sess(peerId);
    if (!s.initiator || s.rekey) return null;
    s.rekey = nacl.box.keyPair(); s.rekeyAt = Date.now();
    return naclUtil.encodeBase64(s.rekey.publicKey);
  }
  // Responder: answer with our own ephemeral. The answer must still go out
  // under the old send chain, so the switch happens in commit(), which the
  // caller runs right after sealing the answer.
  rekeyRespond(peerId, peerEph64) {
    const s = this._sess(peerId);
    if (s.initiator) throw new Error('unexpected rekey');
    const pe = naclUtil.decodeBase64(String(peerEph64 || ''));
    if (pe.length !== 32) throw new Error('bad rekey key');
    const kp = nacl.box.keyPair();
    const dh = Buffer.from(nacl.scalarMult(kp.secretKey, pe));
    kp.secretKey.fill(0);
    if (dh.every(b => b === 0)) throw new Error('low-order key');
    return {
      pub: naclUtil.encodeBase64(kp.publicKey),
      commit: () => { this._roll(s, dh); dh.fill(0); },
    };
  }
  // Initiator: the answer arrived — switch our send chain now.
  rekeyFinish(peerId, peerEph64) {
    const s = this._sess(peerId);
    if (!s.rekey) throw new Error('no rekey in progress');
    const pe = naclUtil.decodeBase64(String(peerEph64 || ''));
    if (pe.length !== 32) throw new Error('bad rekey key');
    const dh = Buffer.from(nacl.scalarMult(s.rekey.secretKey, pe));
    s.rekey.secretKey.fill(0); s.rekey = null;
    if (dh.every(b => b === 0)) throw new Error('low-order key');
    this._roll(s, dh); dh.fill(0);
  }
  _roll(s, dh) {
    const next = _mix(s.send.ck, dh);
    s.send.ck.fill(0); s.send.ck = next; s.send.epoch++; s.send.n = 0;
    if (s.recv.pending) s.recv.pending.fill(0);
    s.recv.pending = Buffer.from(dh);       // the peer's next epoch starts with it
    s.lastRekey = Date.now(); s.sentSinceRekey = 0;
  }
  // Aliases kept for callers outside the network layer (tests, tools).
  encrypt(plaintext, peerId) { return this.seal(plaintext, peerId); }
  decrypt(rec64, peerId) { return this.unseal(rec64, peerId); }
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
  // Per-transfer BOLT key. `salt` is 32 random bytes the sender chose and
  // sent inside the (ratcheted) offer, so a transfer key can't be rebuilt
  // from anything that outlives the offer record.
  boltKey(peerId, label, salt) {
    const s = this._sess(peerId);
    const sb = Buffer.from(String(salt || ''), 'base64');
    if (sb.length !== 32) throw new Error('bad transfer salt');
    const k = crypto.createHmac('sha256', s.boltBase).update(Buffer.concat([Buffer.from('salt|'), sb])).digest();
    const out = crypto.createHmac('sha256', k).update(String(label)).digest();
    k.fill(0);
    return out;
  }
  hasSession(id) { return this.sessionKeys.has(id); }
  removeSession(id) {
    const x = this.sessionKeys.get(id);
    if (x) {
      for (const b of [x.send.ck, x.recv.ck, x.recv.pending, x.boltBase]) if (b) b.fill(0);
      if (x.rekey) x.rekey.secretKey.fill(0);
    }
    this.sessionKeys.delete(id);
  }
  getSessionInfo(id) {
    const s = this.sessionKeys.get(id);
    return s ? { fingerprint: this.getFingerprintFor(s.peerPub64), age: Date.now() - s.established,
                 epoch: Math.max(s.send.epoch, s.recv.epoch), lastRekey: s.lastRekey } : null;
  }
  getActiveSessionCount() { return this.sessionKeys.size; }
}
module.exports = SirrCrypto;
