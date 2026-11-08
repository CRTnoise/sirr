'use strict';
/**
 * Nearby — finding each other with no internet
 * ═══════════════════════════════════════════════════════════════════
 * When the DHT is unreachable (an internet shutdown, a ship, a basement),
 * Sirr can still find members of the same rooms through nearby devices:
 * the same Wi-Fi or hotspot (LAN carrier, lib/nearby-lan.js) and, where
 * the platform allows, Bluetooth LE (lib/nearby-ble.js).
 *
 * Carriers only provide *links*: reliable byte streams to a neighbour. On
 * top of them runs one small mesh that doesn't care what the link is:
 *
 *   beacon   every few seconds each node floods
 *              { origin, nonce, tags[], hops }
 *            tag = HMAC(rendezvous topic of a room for this hour, nonce)[0..16]
 *            — only a member of that room can recognise it, the nonce makes
 *            every beacon unlinkable to the last one, and tags are padded
 *            with random ones so their number says nothing. Every node
 *            re-floods what it hears (up to MAX_HOPS), so the beacon of a
 *            member three phones away still arrives: the more people run
 *            Sirr nearby, the further everyone reaches.
 *   circuit  a member who recognises a tag opens a circuit to the origin
 *            along the reverse path of the beacon. Relays forward opaque
 *            frames. The circuit carries a Noise (secret-stream) session
 *            between the two endpoints, and Sirr's normal handshake runs
 *            inside it, exactly as over the internet — relays see only
 *            ciphertext and learn neither the room nor who is talking.
 */
const EventEmitter = require('events');
const crypto = require('crypto');
const { Duplex } = require('stream');

const MAX_HOPS = 4;
const BEACON_MS = 5000;
const MAX_CIRCUITS = 48;
const MAX_FRAME = 64 * 1024;
const TAG_PAD = 4;

// ─── Framing over any byte stream ────────────────────────────────────
function framer(stream, onFrame) {
  let buf = Buffer.alloc(0);
  stream.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : Buffer.from(d);
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (n > MAX_FRAME) { try { stream.destroy(); } catch (e) {} return; }
      if (buf.length < 4 + n) break;
      const body = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n);
      let f; try { f = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
      if (f && typeof f === 'object') onFrame(f);
    }
  });
  return (f) => {
    const b = Buffer.from(JSON.stringify(f), 'utf8');
    const h = Buffer.alloc(4); h.writeUInt32BE(b.length, 0);
    try { stream.write(Buffer.concat([h, b])); } catch (e) {}
  };
}

// A circuit end, seen by the secret-stream as an ordinary duplex.
class CircuitStream extends Duplex {
  constructor(sendData, onClose) { super(); this._sendData = sendData; this._onClose = onClose; }
  _write(chunk, enc, cb) { for (let i = 0; i < chunk.length; i += 16384) this._sendData(chunk.subarray(i, i + 16384)); cb(); }
  _read() {}
  _destroy(err, cb) { try { this._onClose(); } catch (e) {} cb(err); }
  push_(b) { this.push(b); }
}

class Nearby extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.network   SirrNetwork (rooms, _rotatingTopic, peers, _onConn, swarm keyPair)
   * @param {{publicKey:Buffer, secretKey:Buffer}} o.keyPair  the swarm key pair
   */
  constructor({ network, keyPair }) {
    super();
    this.net = network;
    this.keyPair = keyPair;
    this.id = keyPair.publicKey.toString('hex');
    this.links = new Map();       // linkId -> { send, peerId, carrier, stream }
    this.routes = new Map();      // nodeId -> { linkId, hops, at }
    this.seen = new Map();        // origin|nonce -> at
    this.circuits = new Map();    // cid -> { stream, peer, linkId? }
    this._timer = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this._timer = setInterval(() => { this._beacon(); this._gc(); }, BEACON_MS);
    if (this._timer.unref) this._timer.unref();
    setTimeout(() => this._beacon(), 300);
  }
  stop() {
    this.started = false;
    clearInterval(this._timer);
    for (const c of this.circuits.values()) { try { c.stream.destroy(); } catch (e) {} }
    for (const l of this.links.values()) { try { l.stream.destroy(); } catch (e) {} }
    this.links.clear(); this.routes.clear(); this.circuits.clear();
  }

  // ─── Links ─────────────────────────────────────────────────────
  /** A carrier hands over a fresh link to a neighbour. */
  addLink(stream, carrier) {
    const linkId = crypto.randomBytes(6).toString('hex');
    const link = { stream, carrier, peerId: '', send: null };
    link.send = framer(stream, (f) => this._onFrame(linkId, f));
    this.links.set(linkId, link);
    const drop = () => {
      if (!this.links.delete(linkId)) return;
      for (const [k, r] of this.routes) if (r.linkId === linkId) this.routes.delete(k);
      for (const [cid, c] of this.circuits) if (c.linkId === linkId) { try { c.stream.destroy(); } catch (e) {} this.circuits.delete(cid); }
      this.emit('links', this.linkCount());
    };
    stream.on('close', drop); stream.on('error', drop); stream.on('end', drop);
    link.send({ t: 'hi', id: this.id });
    this.emit('links', this.linkCount());
    if (this.started) setTimeout(() => this._beacon(), 50);
    return linkId;
  }
  linkCount() { return this.links.size; }
  hasNeighbour(id) { for (const l of this.links.values()) if (l.peerId === id) return true; return false; }

  // ─── Beacons ───────────────────────────────────────────────────
  _myTags(nonce) {
    const e = Math.floor(Date.now() / 3600000);
    const tags = [];
    for (const name of this.net.rooms.keys()) {
      let topic = null;
      try { topic = this.net._rotatingTopic(name, e); } catch (x) {}
      if (topic) tags.push(crypto.createHmac('sha256', topic).update('sirr/near/1|' + nonce).digest('hex').slice(0, 32));
    }
    while (tags.length % TAG_PAD || tags.length === 0) tags.push(crypto.randomBytes(16).toString('hex'));
    return tags.sort();
  }
  _beacon() {
    if (!this.links.size) return;
    const nonce = crypto.randomBytes(12).toString('hex');
    this.seen.set(this.id + '|' + nonce, Date.now());
    const f = { t: 'b', o: this.id, n: nonce, g: this._myTags(nonce), h: 0 };
    for (const l of this.links.values()) l.send(f);
  }
  _matches(f) {
    const e = Math.floor(Date.now() / 3600000);
    const want = new Set(f.g);
    for (const name of this.net.rooms.keys()) {
      for (const ep of [e, e - 1, e + 1]) {
        let topic = null;
        try { topic = this.net._rotatingTopic(name, ep); } catch (x) {}
        if (!topic) continue;
        const t = crypto.createHmac('sha256', topic).update('sirr/near/1|' + f.n).digest('hex').slice(0, 32);
        if (want.has(t)) return true;
      }
    }
    return false;
  }
  _connected(id) {
    for (const p of this.net.peers.values()) if (p.remoteKeyHex === id) return true;
    for (const c of this.circuits.values()) if (c.peer === id) return true;
    return false;
  }

  // ─── Frames ────────────────────────────────────────────────────
  _onFrame(linkId, f) {
    const link = this.links.get(linkId);
    if (!link) return;
    switch (f.t) {
      case 'hi':
        if (typeof f.id === 'string' && /^[0-9a-f]{64}$/.test(f.id)) link.peerId = f.id;
        return;
      case 'b': {
        if (typeof f.o !== 'string' || !/^[0-9a-f]{64}$/.test(f.o) || f.o === this.id) return;
        if (typeof f.n !== 'string' || f.n.length > 32 || !Array.isArray(f.g) || f.g.length > 256) return;
        const k = f.o + '|' + f.n;
        if (this.seen.has(k)) return;
        this.seen.set(k, Date.now());
        const hops = (Number(f.h) || 0) + 1;
        const r = this.routes.get(f.o);
        if (!r || hops <= r.hops || Date.now() - r.at > 3 * BEACON_MS) this.routes.set(f.o, { linkId, hops, at: Date.now() });
        this.emit('heard', { origin: f.o, hops });
        // Re-flood: every node makes the beacon reach further.
        if (hops < MAX_HOPS) {
          const g = { ...f, h: hops };
          for (const [id, l] of this.links) if (id !== linkId) l.send(g);
        }
        // Lower id dials, so two members don't open two circuits.
        if (this.id < f.o && this._matches(f) && !this._connected(f.o)) this._dial(f.o);
        return;
      }
      case 'o': case 'd': case 'x': {
        if (typeof f.d !== 'string' || typeof f.s !== 'string' || typeof f.c !== 'string' || f.c.length > 24) return;
        // Learn the reverse path for replies.
        if (f.s !== this.id && !this.routes.has(f.s)) this.routes.set(f.s, { linkId, hops: (Number(f.h) || 0) + 1, at: Date.now() });
        if (f.d === this.id) return this._local(linkId, f);
        // Relay: forward blindly towards the destination.
        if ((Number(f.h) || 0) >= MAX_HOPS * 2) return;
        const r = this.routes.get(f.d);
        const out = r && this.links.get(r.linkId);
        if (out && r.linkId !== linkId) out.send({ ...f, h: (Number(f.h) || 0) + 1 });
        return;
      }
    }
  }

  _sendTo(dst, f) {
    const r = this.routes.get(dst);
    const l = r && this.links.get(r.linkId);
    if (l) l.send({ ...f, s: this.id, d: dst, h: 0 });
    return !!l;
  }

  _mkCircuit(cid, peer, initiator) {
    const SecretStream = require('@hyperswarm/secret-stream');
    let closed = false;
    const raw = new CircuitStream(
      (chunk) => this._sendTo(peer, { t: 'd', c: cid, x: Buffer.from(chunk).toString('base64') }),
      () => { if (closed) return; closed = true; this._sendTo(peer, { t: 'x', c: cid }); this.circuits.delete(cid); },
    );
    this.circuits.set(cid, { stream: raw, peer, linkId: this.routes.get(peer)?.linkId });
    const ss = new SecretStream(initiator, raw, { keyPair: this.keyPair });
    ss.on('error', () => {});
    ss.on('connect', () => {
      const rk = ss.remotePublicKey && Buffer.from(ss.remotePublicKey).toString('hex');
      if (rk !== peer) { ss.destroy(); return; }                 // not who the beacon said
      this.emit('connection', { peer, initiator });
      this.net._onConn(ss, { publicKey: ss.remotePublicKey, topics: [], nearby: true });
    });
    return raw;
  }

  _dial(peer) {
    if (this.circuits.size >= MAX_CIRCUITS) return;
    const cid = crypto.randomBytes(8).toString('hex');
    if (!this._sendTo(peer, { t: 'o', c: cid })) return;
    this._mkCircuit(cid, peer, true);
  }

  _local(linkId, f) {
    if (f.t === 'o') {
      if (this.circuits.has(f.c) || this.circuits.size >= MAX_CIRCUITS) return;
      if (this._connected(f.s)) { this._sendTo(f.s, { t: 'x', c: f.c }); return; }
      this._mkCircuit(f.c, f.s, false);
      return;
    }
    const c = this.circuits.get(f.c);
    if (!c || c.peer !== f.s) return;
    // Deliver on a later tick: never re-enter the Noise state machine from inside its own write.
    if (f.t === 'd' && typeof f.x === 'string') { const b = Buffer.from(f.x, 'base64'); queueMicrotask(() => c.stream.push_(b)); }
    else if (f.t === 'x') { this.circuits.delete(f.c); try { c.stream.push(null); c.stream.destroy(); } catch (e) {} }
  }

  _gc() {
    const now = Date.now();
    for (const [k, at] of this.seen) if (now - at > 60000) this.seen.delete(k);
    for (const [k, r] of this.routes) if (now - r.at > 6 * BEACON_MS && !this.hasNeighbour(k)) this.routes.delete(k);
  }

  stats() {
    let reach = 0;
    for (const r of this.routes.values()) if (Date.now() - r.at < 3 * BEACON_MS) reach++;
    return { links: this.links.size, reach, circuits: this.circuits.size };
  }
}

module.exports = { Nearby, framer, MAX_HOPS };
