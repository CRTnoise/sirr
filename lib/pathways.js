'use strict';
/**
 * Pathways — how Sirr reaches the swarm when the default way is blocked
 * ═══════════════════════════════════════════════════════════════════
 * Three independent fixes, all optional, none needing a server that Sirr
 * (or anyone in particular) runs:
 *
 * 1. Entry points. HyperDHT is entered through three well-known bootstrap
 *    nodes; a censor who blocks those three addresses stops new sessions.
 *    Sirr remembers DHT nodes it has seen (sealed in the config, up to
 *    MAX_REMEMBERED), tries them first, accepts entry points typed by the
 *    user, and picks up `via=` hints carried in invite links. Any one
 *    reachable DHT node is enough to get in.
 *
 * 2. Volunteer relays (blind relays). Peers behind symmetric NAT / CGNAT
 *    can't hole-punch to each other. Any Sirr user can volunteer to relay:
 *    the app runs a blind-relay server under a fresh key every launch and
 *    announces it on a topic that rotates daily. A relay pairs two
 *    encrypted UDX streams it cannot read (the Noise session runs end to
 *    end through it, and Sirr's own end-to-end layer sits inside that).
 *    Cost: the volunteer's bandwidth, capped. Nobody pays anything.
 *
 * 3. Bridges (traffic that doesn't look like Sirr). HyperDHT speaks UDP
 *    in a recognisable way. Over a bridge, the whole DHT — lookups,
 *    announces and every peer connection — rides one WebSocket. Behind a
 *    TLS reverse proxy on :443 it is indistinguishable from an ordinary
 *    HTTPS site with a WebSocket. The bridge carries the throwaway
 *    transport key but sees only Sirr's end-to-end ciphertext inside it. Anyone can run
 *    one (bin/sirr-bridge.js, or "Run a bridge" in the app on a reachable
 *    machine); addresses spread like Tor bridges — by hand or in invites.
 */
const EventEmitter = require('events');
const crypto = require('crypto');
const b4a = require('b4a');

const MAX_REMEMBERED = 64;
const MAX_RELAY_SESSIONS = 24;
const RELAY_TOPIC = (day) => crypto.createHash('sha256').update('sirr/relays/1|' + day).digest();
const today = () => Math.floor(Date.now() / 864e5);

/** "host:port" | "pubkey@host:port" | {host, port} → {host, port} or null */
function parseNode(x) {
  if (x && typeof x === 'object' && x.host && x.port) return { host: String(x.host), port: Number(x.port) };
  const m = /^(?:[0-9a-f]{64}@|[^@\s]+@)?\[?([a-zA-Z0-9.\-:]+?)\]?:(\d{2,5})$/.exec(String(x || '').trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  return { host: m[1], port };
}
const nodeStr = (n) => n.host + ':' + n.port;
function isBridgeUrl(u) { return /^wss?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(String(u || '')); }

class Pathways extends EventEmitter {
  /**
   * @param {object} o
   * @param {string[]} [o.remembered]  nodes from earlier sessions ("host:port")
   * @param {string[]} [o.entry]       user-supplied entry points
   * @param {string}   [o.bridge]      ws(s):// bridge URL, or ''
   * @param {'off'|'auto'|'always'} [o.relays]
   * @param {boolean}  [o.volunteer]   relay for others
   */
  constructor(o = {}) {
    super();
    this.remembered = (o.remembered || []).map(parseNode).filter(Boolean);
    this.entry = (o.entry || []).map(parseNode).filter(Boolean);
    this.bridge = isBridgeUrl(o.bridge) ? String(o.bridge) : '';
    this.relayMode = ['off', 'auto', 'always'].includes(o.relays) ? o.relays : 'auto';
    this.volunteer = !!o.volunteer;
    this.dhtOpts = o.dhtOpts || {};     // tests: { host: '127.0.0.1' }
    this.defaults = o.defaults !== false;
    this.pool = new Map();            // relay pubkey hex -> seenAt
    this.dht = null;
    this.usingBridge = false;
    this._relay = null;
    this._timers = [];
  }

  /** Entry points, best first: the user's, then remembered, then defaults. */
  bootstrapList() {
    const DHT = require('hyperdht');
    const seen = new Set(), out = [];
    const add = (n) => { const k = nodeStr(n); if (!seen.has(k)) { seen.add(k); out.push(n); } };
    this.entry.forEach(add);
    // A random sample, so a censor can't predict which remembered nodes we try.
    [...this.remembered].sort(() => Math.random() - 0.5).slice(0, 24).forEach(add);
    if (this.defaults) for (const s of DHT.BOOTSTRAP) { const n = parseNode(s); if (n) add(n); }
    return out;
  }

  addHints(hints) {
    let changed = false;
    for (const h of hints || []) {
      if (isBridgeUrl(h)) { this.emit('bridge-hint', h); continue; }
      const n = parseNode(h);
      if (n && !this.remembered.some(r => nodeStr(r) === nodeStr(n))) { this.remembered.unshift(n); changed = true; }
    }
    if (changed) { this.remembered = this.remembered.slice(0, MAX_REMEMBERED); this.emit('remember', this.remembered.map(nodeStr)); }
  }

  /** Build the DHT: through the bridge if one is set, else UDP with our entry points. */
  async makeDht() {
    if (this.bridge) {
      try {
        this.dht = await this._bridgeDht(this.bridge);
        this.usingBridge = true;
        return this.dht;
      } catch (e) {
        this.emit('bridge-failed', { url: this.bridge, error: e.message });
      }
    }
    const DHT = require('hyperdht');
    this.dht = new DHT({ ...this.dhtOpts, bootstrap: this.bootstrapList() });
    this.usingBridge = false;
    return this.dht;
  }

  _bridgeDht(url) {
    const WebSocket = require('ws');
    const RelayedDHT = require('@hyperswarm/dht-relay');
    const Stream = require('@hyperswarm/dht-relay/ws');
    return new Promise((resolve, reject) => {
      // A generic client: nothing in the upgrade request says "Sirr".
      const ws = new WebSocket(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, handshakeTimeout: 10000 });
      const fail = (e) => { try { ws.terminate(); } catch (x) {} reject(e instanceof Error ? e : new Error(String(e))); };
      const t = setTimeout(() => fail(new Error('bridge timeout')), 12000);
      ws.once('error', (e) => { clearTimeout(t); fail(e); });
      ws.once('open', () => {
        clearTimeout(t);
        // The relay protocol needs the swarm key pair on the bridge
        // (its non-custodial mode can't announce yet), so the Noise
        // transport ends AT the bridge: it sees every frame we write.
        // That is why nothing after the handshake is written in the clear
        // (network.js: sealed, ratcheted records for every frame). What a
        // bridge still sees: the handshake itself (identity public key,
        // ephemeral key, connection-bound room tags), BOLT frame headers,
        // and the size and timing of records. It can drop or delay
        // traffic; it can't read or forge it.
        const dht = new RelayedDHT(new Stream(true, ws), { custodial: true });
        ws.on('close', () => this.emit('bridge-closed', { url }));
        resolve(dht);
      });
    });
  }

  /** Options for `new Hyperswarm(...)`. */
  swarmOptions() {
    return { dht: this.dht, relayThrough: (force, swarm) => this._pick(force, swarm) };
  }

  _pick(force, swarm) {
    if (this.relayMode === 'off' || !this.pool.size) return null;
    const hard = !!(swarm && swarm.dht && swarm.dht.randomized);
    if (this.relayMode === 'auto' && !force && !hard) return null;
    const keys = [...this.pool.keys()].filter(k => k !== this._myRelayHex);
    if (!keys.length) return null;
    return b4a.from(keys[Math.floor(Math.random() * keys.length)], 'hex');
  }

  /** Start background work once the swarm exists. */
  async start(swarm) {
    const dht = swarm.dht;
    const tick = async () => {
      if (this.relayMode !== 'off') await this.refreshPool(dht).catch(() => {});
      this.rememberNow(dht);
    };
    setTimeout(tick, 15000);
    this._timers.push(setInterval(tick, 10 * 60e3));
    if (this.volunteer && !this.usingBridge) await this.startRelay(dht).catch((e) => this.emit('relay-error', e));
    for (const t of this._timers) if (t.unref) t.unref();
  }

  rememberNow(dht) {
    try {
      if (this.usingBridge || typeof dht.toArray !== 'function') return;
      const live = dht.toArray({ limit: 40 }).map(parseNode).filter(Boolean);
      if (!live.length) return;
      const merged = new Map();
      for (const n of [...live, ...this.remembered]) merged.set(nodeStr(n), n);
      this.remembered = [...merged.values()].slice(0, MAX_REMEMBERED);
      this.emit('remember', this.remembered.map(nodeStr));
    } catch (e) {}
  }

  async refreshPool(dht) {
    const found = new Map();
    for (const d of [today(), today() - 1]) {
      try {
        for await (const r of dht.lookup(RELAY_TOPIC(d))) {
          for (const p of r.peers || []) found.set(b4a.toString(p.publicKey, 'hex'), Date.now());
          if (found.size >= 64) break;
        }
      } catch (e) {}
    }
    if (found.size) this.pool = found;
    this.emit('pool', { relays: this.pool.size });
    return this.pool.size;
  }

  // ─── Volunteering ───────────────────────────────────────────────
  async startRelay(dht) {
    if (this._relay) return;
    const DHT = require('hyperdht');
    const { Server } = require('blind-relay');
    const keyPair = DHT.keyPair();            // new every launch: unlinkable
    this._myRelayHex = b4a.toString(keyPair.publicKey, 'hex');
    const relay = new Server({ createStream: (opts) => dht.createRawStream({ ...opts, framed: true }) });
    const sessions = new Set();
    const server = dht.createServer((socket) => {
      if (sessions.size >= MAX_RELAY_SESSIONS) { socket.destroy(); return; }
      socket.on('error', () => {});
      const s = relay.accept(socket, { id: socket.remotePublicKey });
      this.relayed = (this.relayed || 0) + 1;
      sessions.add(s);
      s.on('error', () => {});
      s.on('close', () => sessions.delete(s));
      socket.on('close', () => sessions.delete(s));
    });
    await server.listen(keyPair);
    const announce = async () => { try { await dht.announce(RELAY_TOPIC(today()), keyPair).finished(); } catch (e) {} };
    announce();
    const t = setInterval(announce, 10 * 60e3); if (t.unref) t.unref();
    this._timers.push(t);
    this._relay = { server, relay, sessions, keyPair };
    this.emit('relay-on', { key: this._myRelayHex });
  }

  async stopRelay() {
    if (!this._relay) return;
    const r = this._relay; this._relay = null;
    try { await r.relay.close(); } catch (e) {}
    try { await r.server.close(); } catch (e) {}
  }

  stats() {
    return {
      bridge: this.usingBridge ? this.bridge : '',
      relays: this.pool.size,
      relayMode: this.relayMode,
      volunteering: !!this._relay,
      relaying: this._relay ? this._relay.sessions.size : 0,
      remembered: this.remembered.length,
    };
  }

  async destroy() {
    for (const t of this._timers) clearInterval(t);
    await this.stopRelay();
  }
}

/** Serve the DHT over WebSocket for others (an in-app or standalone bridge). */
function serveBridge(dht, { port = 49443, host = '0.0.0.0', server } = {}) {
  const { WebSocketServer } = require('ws');
  const { relay } = require('@hyperswarm/dht-relay');
  const Stream = require('@hyperswarm/dht-relay/ws');
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port, host });
  wss.on('connection', (socket) => {
    socket.on('error', () => {});
    try { relay(dht, new Stream(false, socket)); } catch (e) { try { socket.close(); } catch (x) {} }
  });
  return wss;
}

module.exports = { Pathways, serveBridge, parseNode, isBridgeUrl, RELAY_TOPIC, MAX_REMEMBERED };
