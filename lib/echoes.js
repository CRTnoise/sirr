'use strict';
/**
 * Echoes — messages that wait for you inside the DHT itself
 * ═══════════════════════════════════════════════════════════════════
 * Peer-to-peer chat has a hole: if Ana writes while Bo is offline, and Ana
 * is gone by the time Bo comes back, the message waits on Ana's laptop.
 * The usual fixes put a server, or some member's always-on device, in the
 * middle. Echoes uses neither: the message is kept by the DHT's own
 * routing nodes, as a few hundred bytes of ciphertext under a key nobody
 * outside the room can find, and it stays alive only as long as members
 * keep listening for it.
 *
 * Slots. Every room member can derive, for any writer W and day d:
 *
 *   E          = HMAC(room secret, "sirr/echo/1")      (pairwise for DMs)
 *   head(W,d)  = Ed25519 key from HMAC(E, "head|" W "|" d)
 *   slot(W,d,i)= Ed25519 key from HMAC(E, "slot|" W "|" d "|" i)   i < SLOTS
 *
 * W writes message number k of the day as a signed mutable record under
 * slot(W,d,k mod SLOTS) with seq k, and the count under head(W,d). Values
 * are sealed with XSalsa20-Poly1305 under HMAC(E, "seal|" slot key) and
 * padded to one size, so DHT nodes store identical-looking blobs under
 * unrelated-looking keys, and cannot tell rooms, writers or lengths apart.
 *
 * Echo. HyperDHT drops a record 48 h after it was last put. A reader
 * fetching a slot re-puts the same signed record to the nodes it asked
 * (`refresh`) — it can do that without the writer's key. So each member
 * who reads keeps the message alive another 48 h: it fades only when
 * nobody is listening anymore. Nobody stores anything for anybody.
 *
 * Authorship is not taken from the DHT: every echoed message carries its
 * author's per-room signature (lib/msgsig.js) and is judged like any
 * relayed message — a member who could derive slot keys could overwrite a
 * slot (erase), never forge an author.
 *
 * Trade-off, stated plainly: an echo is encrypted under a key derived
 * from the room code, not from a forward-secret session. Someone who
 * records DHT traffic *and* later obtains the room code could read the
 * echoes of that window. That is why Echoes is opt-in.
 */
const EventEmitter = require('events');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const SLOTS = 32;
const PART = 480;          // message bytes per slot (base64 inside the sealed value)
const VALUE = 720;         // padded plaintext size
const MAX_PARTS = 8;
const day = (t = Date.now()) => Math.floor(t / 864e5);

function kpFrom(seed) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  return { publicKey: Buffer.from(kp.publicKey), secretKey: Buffer.from(kp.secretKey) };
}

class Echoes extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => object} o.dht           returns the HyperDHT instance (or null)
   * @param {(room:string) => Buffer|null} o.secretFor  room secret (see network._echoSecret)
   * @param {() => string} o.myFp
   */
  constructor({ dht, secretFor, myFp }) {
    super();
    this.dht = dht; this.secretFor = secretFor; this.myFp = myFp;
    this.count = new Map();      // room|day -> next k (our own writes)
    this.seen = new Map();       // room|writer|day -> next k already read
    this.parts = new Map();      // msgId -> { n, got: Map }
    this._queue = Promise.resolve();
  }

  available() { const d = this.dht(); return !!(d && typeof d.mutablePut === 'function' && typeof d.mutableGet === 'function'); }

  _E(room) { const s = this.secretFor(room); return s ? crypto.createHmac('sha256', s).update('sirr/echo/1').digest() : null; }
  _key(E, label) { return kpFrom(crypto.createHmac('sha256', E).update(label).digest()); }
  _head(E, w, d) { return this._key(E, 'head|' + w + '|' + d); }
  _slot(E, w, d, i) { return this._key(E, 'slot|' + w + '|' + d + '|' + i); }
  _sealKey(E, pub) { return crypto.createHmac('sha256', E).update('seal|').update(pub).digest(); }

  _seal(E, pub, obj) {
    const raw = Buffer.from(JSON.stringify(obj), 'utf8');
    if (raw.length + 1 > VALUE) throw new Error('echo too large');
    const pt = Buffer.alloc(VALUE); raw.copy(pt); pt[raw.length] = 0x80;
    const nonce = crypto.randomBytes(24);
    const ct = nacl.secretbox(new Uint8Array(pt), new Uint8Array(nonce), new Uint8Array(this._sealKey(E, pub)));
    return Buffer.concat([nonce, Buffer.from(ct)]);
  }
  _open(E, pub, buf) {
    if (!buf || buf.length < 40) return null;
    const pt = nacl.secretbox.open(new Uint8Array(buf.subarray(24)), new Uint8Array(buf.subarray(0, 24)), new Uint8Array(this._sealKey(E, pub)));
    if (!pt) return null;
    let i = pt.length - 1; while (i >= 0 && pt[i] === 0) i--;
    if (i < 0 || pt[i] !== 0x80) return null;
    try { return JSON.parse(Buffer.from(pt.subarray(0, i)).toString('utf8')); } catch (e) { return null; }
  }

  /** Leave a message in the room's echo slots. `m` is the signed wire message. */
  write(room, m) {
    const run = async () => {
      const dht = this.dht(), E = this._E(room);
      if (!dht || !E || !this.available()) return false;
      const d = day(), w = this.myFp();
      const ck = room + '|' + d;
      if (!this.count.has(ck)) this.count.set(ck, await this._readCount(dht, E, w, d));
      const body = JSON.stringify({
        c: m.channel || 'default', i: m.msgId, t: m.timestamp, y: m.type || 'text', x: m.content,
        f: w, n: m.nickname || '', s: m.sig || '', e: m.expiresAt || 0,
        r: m.replyTo ? { i: m.replyTo.msgId, n: m.replyTo.nick, p: String(m.replyTo.preview || '').slice(0, 60) } : null,
        fn: m.fileName || '', fs: m.fileSize || 0,
      });
      const bytes = Buffer.from(body, 'utf8');
      const n = Math.ceil(bytes.length / PART);
      if (n > MAX_PARTS) return false;          // long ones wait for a normal sync
      for (let p = 0; p < n; p++) {
        const k = this.count.get(ck);
        this.count.set(ck, k + 1);
        const kp = this._slot(E, w, d, k % SLOTS);
        const val = this._seal(E, kp.publicKey, { m: m.msgId, p, n, d: bytes.subarray(p * PART, (p + 1) * PART).toString('base64') });
        await dht.mutablePut(kp, val, { seq: k });
      }
      const hk = this._head(E, w, d), k = this.count.get(ck);
      await dht.mutablePut(hk, this._seal(E, hk.publicKey, { k }), { seq: k });
      this.emit('wrote', { room, msgId: m.msgId, parts: n });
      return true;
    };
    const p = this._queue.then(run, run).catch((e) => { this.emit('fail', e); return false; });
    this._queue = p;
    return p;
  }

  async _readCount(dht, E, w, d) {
    try {
      const hk = this._head(E, w, d);
      const r = await dht.mutableGet(hk.publicKey, { latest: true });
      const v = r && this._open(E, hk.publicKey, r.value);
      return v && Number.isInteger(v.k) ? v.k : 0;
    } catch (e) { return 0; }
  }

  /**
   * Look for echoes from `writers` (fingerprints) in `room`, today and
   * yesterday. Every record read is re-put: that's the echo.
   */
  async poll(room, writers) {
    const dht = this.dht(), E = this._E(room);
    if (!dht || !E || !this.available()) return 0;
    const me = this.myFp();
    let found = 0;
    for (const w of writers) {
      if (!w || w === me) continue;
      for (const d of [day(), day() - 1]) {
        const sk = room + '|' + w + '|' + d;
        const hk = this._head(E, w, d);
        let head;
        try { head = await dht.mutableGet(hk.publicKey, { latest: true, refresh: () => true }); } catch (e) { continue; }
        const hv = head && this._open(E, hk.publicKey, head.value);
        if (!hv || !Number.isInteger(hv.k)) continue;
        const from = Math.max(this.seen.get(sk) || 0, hv.k - SLOTS);
        for (let k = from; k < hv.k; k++) {
          const kp = this._slot(E, w, d, k % SLOTS);
          let rec;
          try { rec = await dht.mutableGet(kp.publicKey, { seq: k, latest: true, refresh: () => true }); } catch (e) { continue; }
          if (!rec || rec.seq !== k) continue;      // overwritten by a newer lap of the ring
          const v = this._open(E, kp.publicKey, rec.value);
          if (v && this._part(room, w, v)) found++;
        }
        this.seen.set(sk, hv.k);
      }
    }
    return found;
  }

  _part(room, w, v) {
    if (typeof v.m !== 'string' || !Number.isInteger(v.p) || !Number.isInteger(v.n) || v.n < 1 || v.n > MAX_PARTS) return false;
    let e = this.parts.get(v.m);
    if (!e) { e = { n: v.n, got: new Map(), at: Date.now() }; this.parts.set(v.m, e); }
    e.got.set(v.p, Buffer.from(String(v.d || ''), 'base64'));
    if (e.got.size < e.n) return false;
    this.parts.delete(v.m);
    let o;
    try { o = JSON.parse(Buffer.concat([...Array(e.n).keys()].map(i => e.got.get(i) || Buffer.alloc(0))).toString('utf8')); } catch (x) { return false; }
    if (!o || o.i !== v.m || o.f !== w) return false;
    const m = {
      room, channel: o.c, msgId: o.i, timestamp: o.t, type: o.y, content: o.x, fingerprint: o.f,
      nickname: o.n, sig: o.s, expiresAt: o.e || 0, fileName: o.fn || '', fileSize: o.fs || 0,
      replyTo: o.r ? { msgId: o.r.i, nick: o.r.n, preview: o.r.p } : null,
    };
    this.emit('echo', { room, m });
    return true;
  }
}

module.exports = { Echoes, SLOTS, PART };
