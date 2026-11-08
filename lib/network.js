/**
 * Sirr — network layer
 * ═════════════════════════
 * Rooms are rendezvous points on the Hyperswarm DHT; every member connects
 * directly to every other (Noise-encrypted streams). On top of each stream:
 *
 *   • a forward-secret handshake between identity keys (KEY_EXCHANGE →
 *     KEY_CONFIRM, see crypto-layer); nothing but the handshake and the
 *     keepalive is accepted before it completes;
 *   • room membership proven per connection with tags, never by sending
 *     room codes (see _tag);
 *   • newline-delimited JSON messages, with app-level encryption for all
 *     content, plus binary BOLT frames for files (lib/bolt.js);
 *   • hard caps on every buffer, line, rate and count a peer can make us
 *     hold, and a 15 s / 45 s keepalive that catches half-open links.
 */

const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const b4a = require('b4a');
const bolt = require('./bolt');
const msgsig = require('./msgsig');

const MSG = {
  KEY_EXCHANGE: 0x01,
  KEY_CONFIRM:  0x05,  // forward-secret handshake: carries the ephemeral
                       //   auth tag once both sides have each other's eph key.
  CHAT:         0x02,
  ANNOUNCE:     0x03,
  LEAVE:        0x04,
  TYPING:       0x06,
  ROOM_RENAME:  0x07,
  PING:         0x08,
  PONG:         0x09,
  ROOMS_UPDATE: 0x0A,  // I've joined/left a room — here's my new set
  CHANNEL_CREATE: 0x0B,
  CHANNEL_RENAME: 0x0C,
  CHANNEL_DELETE: 0x0D,
  CHANNELS_SYNC:  0x0E,  // unicast: "here are my channels for room X"
  VOICE_OFFER:  0x10,
  VOICE_ANSWER: 0x11,
  VOICE_ICE:    0x12,
  VOICE_LEAVE:  0x13,
  VOICE_JOIN:   0x14,
  VOICE_READY:  0x15,  // "I heard your JOIN and I will call you"
  VOICE_MEDIA:  0x16,  // mesh audio packet over the swarm link (base64)
  BOLT_CTL:     0x60,  // BOLT transfer control (offer/accept/ack/fin/done/cancel), encrypted
  ROOM_KEYS:    0x61,  // encrypted unicast: my per-room signing keys for rooms we share
  ROOM_MOVE:    0x62,  // encrypted unicast: owner-signed move to a new code (rekey / eviction)
  COVER:        0x63,  // encrypted chaff (opt-in cover traffic); dropped on receipt
  PROFILE:      0x64,  // encrypted: nickname / avatar / status — never sent before the session
  FILE_START:   0x20,
  FILE_CHUNK:   0x21,
  FILE_END:     0x22,
  CONTACT_ADD:  0x30,  // unicast: "I added you as a contact"
  SYNC_SUMMARY: 0x31,  // unicast: "room X — my last N msgIds"
  SYNC_REQUEST: 0x32,  // unicast: "please resend these msgIds for room X"
  SYNC_MESSAGES:0x33,  // unicast: encrypted bundle of full messages
  PIN_TOGGLE:   0x34,  // broadcast: {room, channel, msgId, pinned, preview, nick}
  PINS_SYNC:    0x35,  // unicast: full pin list for room/channel (on peer-joined)
  ROOM_CHARTER: 0x40,  // unicast: {room, ownerFingerprint, createdAt} — tells a peer who owns this room
  ADMIN_UPDATE: 0x41,  // broadcast: {room, fingerprint, perms} — owner grants/revokes admin perms
  ADMIN_SYNC:   0x42,  // unicast: {room, admins} — full admin snapshot, only trusted from owner
  MSG_EDIT:     0x50,  // encrypted broadcast: {room, channel, msgId, content, editedAt}
                       //   — author-only: receivers reject if sender's fp doesn't match the
                       //   message's original author fingerprint (verified at storage layer).
  MSG_DELETE_FOR_ALL: 0x51,  // broadcast: {room, channel, msgId}
                       //   — moderation: receivers verify sender is owner OR is the original
                       //   author. (Author-self-delete is technically already covered by the
                       //   local-only delete-message path, but this lets it propagate.)
};
// The only messages accepted before a peer has authenticated.
const PRE_AUTH = new Set([MSG.KEY_EXCHANGE, MSG.KEY_CONFIRM, MSG.PING, MSG.PONG, MSG.LEAVE]);

// Every wire type must be unique: a duplicate silently routes one message
// kind into another's handler (a switch takes the first matching case).
(() => {
  const seen = new Map();
  for (const [k, v] of Object.entries(MSG)) {
    if (seen.has(v)) throw new Error('MSG.' + k + ' reuses 0x' + v.toString(16) + ' of MSG.' + seen.get(v));
    seen.set(v, k);
  }
})();


const MAX_BUFFER_BYTES = 32 * 1024 * 1024; // 32 MB per peer — holds a burst of
                                           //   512 KB file chunks (each ~684 KB
                                           //   base64+JSON) without dropping the
                                           //   socket. Below this we never OOM.
const MAX_LINE_BYTES   = 4 * 1024 * 1024;  // 4 MB per single message — one 512 KB
                                           //   binary chunk is ~684 KB once base64
                                           //   + JSON framed; 4 MB leaves headroom.
const KEEPALIVE_MS     = 15_000;
const KEEPALIVE_TIMEOUT_MS = 45_000;
// Per-transfer inbound cap. A peer announces size on FILE_START; we cap at
// min(announced, MAX_INBOUND_FILE_BYTES). Chunks over the cap get dropped
// and the transfer is aborted. Prevents a malicious peer from streaming
// unbounded bytes at us to fill the disk.
const MAX_INBOUND_FILE_BYTES = 512 * 1024 * 1024;  // 512 MB
const MIN_FILE_CHUNK_BYTES = 1024;                 // metadata sanity floor
function b64DecodedLen(s) {
  const n = s.length;
  if (!n) return 0;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.floor(n * 3 / 4) - pad;
}
// Deferred-DM queue limits — in normal flow both fingerprints are already
// set by the time a DM CHAT arrives (KEY_EXCHANGE strictly precedes CHAT
// because we gate on `hasSession`). The queue is a belt-and-braces defense
// for the race window between receiving a CHAT and finishing identity
// plumbing, NOT a general buffer. Cap it hard so a malicious peer can't
// grow our memory by streaming pending DMs.
const MAX_PENDING_DM_CHATS = 32;
const PENDING_DM_TTL_MS    = 10_000;
const CONTACT_ADD_MIN_MS   = 30_000;  // per-peer debounce on CONTACT_ADD
const SYNC_MAX_IDS         = 200;     // per sync message: ids offered/requested/returned
const ROOMS_MAX            = 256;     // rooms a peer may declare
// Voice over the swarm link. 50 packets/s is normal; cap well
// above that so a hostile peer can't flood the renderer.
const VOICE_MEDIA_MAX_BYTES = 4096;
const VOICE_MEDIA_MAX_PER_SEC = 150;
// If this much is already queued on a socket (a file upload in progress,
// a congested link), new audio is dropped rather than queued behind it —
// late audio is worthless.
const VOICE_MEDIA_MAX_QUEUED = 256 * 1024;

// Deterministic DM-code derivation from a sorted fingerprint pair. Mirrors
// SirrStorage.dmRoomCode so the network layer can validate a DM CHAT's
// claimed room against the crypto-authenticated sender without a storage
// dependency. Both sides (peers in the pair) produce the same string.
function _dmCodeFor(fpA, fpB) {
  if (!fpA || !fpB) return '';
  const [a, b] = [String(fpA), String(fpB)].sort();
  const h = crypto.createHash('sha256').update(a + '|' + b).digest('hex');
  return 'DM' + h.slice(0, 10).toUpperCase();
}

class SirrNetwork extends EventEmitter {
  constructor(cry) {
    super();
    this.crypto = cry;
    this.swarm = null;
    this.peers = new Map();       // pid -> peer record (see _onConn)
    this.rooms = new Map();       // roomName -> { topic, disc }
    this.topicToRoom = new Map(); // topicHex -> roomName (reverse lookup)
    this.buffers = new Map();     // pid -> string (stream buffer)
    this.incomingFiles = new Map(); // "pid:fileId" -> { bytes, cap, aborted }
    this.pendingDmChats = [];     // [{pid, msg, pt, receivedAt}] waiting on fingerprints
    this.nickname = 'anon';
    this.avatarEmoji = '';
    this.avatarPixels = '';     // drawn sigil, '<n>:<base64 bits>'
    this.status = 'active';       // 'active' | 'away' — changes broadcast via ANNOUNCE
    this.statusText = '';         // free-text status line shown in the hover card
    this.myId = '';
    this._keepaliveTimer = null;
    // Fingerprints on this set get dropped at KEY_EXCHANGE time. main.js
    // keeps it in sync with SirrStorage.getBlocklist().
    this.blockedFingerprints = new Set();
    this.dmKeys = new Map();      // DM code -> counterpart identity key (b64)
    this.jitterMs = 0;            // opt-in random delay before chat goes out
    this._jitterTail = 0;
    this._coverTimer = null;
  }

  // ─── Traffic shaping (opt-in) ─────────────────────────────────
  // Cover traffic: each authenticated link carries encrypted chaff at
  // random (Poisson) times, padded like real messages, so someone watching
  // the encrypted streams can't tell talking from idling.
  setCoverTraffic(on) {
    if (this._coverTimer) { clearInterval(this._coverTimer); this._coverTimer = null; }
    if (!on) return;
    const MEAN_S = 12;
    this._coverTimer = setInterval(() => {
      for (const [pid, peer] of this.peers) {
        if (!this.crypto.hasSession(pid) || Math.random() > 1 / MEAN_S) continue;
        const n = 16 + Math.floor(Math.random() * (Math.random() < 0.8 ? 400 : 3000));
        try { this._send(peer.socket, { type: MSG.COVER, data: this.crypto.encrypt(crypto.randomBytes(n).toString('base64'), pid) }); } catch (e) {}
      }
    }, 1000);
    if (this._coverTimer.unref) this._coverTimer.unref();
  }
  // Send jitter: chat waits a random 0..jitterMs before going out (order
  // kept), so typing rhythm and "who answered whom, how fast" blur.
  setSendJitter(ms) { this.jitterMs = Math.max(0, Math.min(30000, Number(ms) || 0)); }
  _later(fn) {
    if (!this.jitterMs) return fn();
    const at = Math.max(this._jitterTail, Date.now() + Math.random() * this.jitterMs);
    this._jitterTail = at;
    setTimeout(fn, at - Date.now());
  }

  // ─── Clock check ───────────────────────────────────────────────
  // Rendezvous topics change every hour, so a clock that is far off can't
  // meet anyone. Peers say what minute it is in their handshake; if the
  // median of what they say is ≥ 30 minutes from ours, the UI is told.
  _noteClock(peer, clk) {
    const m = Number(clk);
    if (!Number.isFinite(m)) return;
    peer.skewMin = m - Math.round(Date.now() / 60000);
    const xs = [...this.peers.values()].map(p => p.skewMin).filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) return;
    const med = xs[Math.floor(xs.length / 2)];
    if (Math.abs(med) >= 30 && (xs.length >= 2 || Math.abs(med) >= 50)) {
      if (this._skewWarned !== Math.round(med / 10)) { this._skewWarned = Math.round(med / 10); this.emit('clock-skew', { minutes: med, peers: xs.length }); }
    }
  }

  // Set the active/away flag and (optionally) the free-text status line,
  // then broadcast an ANNOUNCE so every connected peer's UI refreshes.
  updateStatus(status, statusText) {
    let changed = false;
    if (status && status !== this.status) { this.status = status; changed = true; }
    if (statusText !== undefined && statusText !== this.statusText) {
      this.statusText = String(statusText || '').slice(0, 80);
      changed = true;
    }
    if (changed) this.reannounce();
  }

  setBlocklist(fps) {
    this.blockedFingerprints = new Set(fps || []);
    // Also kick any currently-connected peer matching the list.
    for (const [pid, peer] of this.peers) {
      if (peer.fingerprint && this.blockedFingerprints.has(peer.fingerprint)) {
        try { peer.socket.destroy(); } catch (e) {}
        this._dropPeer(pid);
      }
    }
  }

  /**
   * @param {string} nick
   * @param {{inbox?: boolean}} [opts]  inbox → listen on the fingerprint
   *        inbox topic (see _inboxTopic). Off unless the user opts in.
   */
  async init(nick, opts = {}) {
    this.nickname = nick || 'anon';
    this._inboxEnabled = !!opts.inbox;
    // Pathways (lib/pathways.js): remembered entry points, a bridge,
    // volunteer relays. Without it, plain Hyperswarm defaults.
    if (opts.pathways) {
      this.pathways = opts.pathways;
      await this.pathways.makeDht();
      this.swarm = new Hyperswarm(this.pathways.swarmOptions());
      this.pathways.start(this.swarm).catch(() => {});
    } else {
      this.swarm = new Hyperswarm();
    }
    // Derive myId from Hyperswarm's noise keypair — this is exactly how
    // remote peers compute our pid in _onConn (they use info.publicKey on
    // their end, which is OUR swarm.keyPair.publicKey). So myId matches
    // exactly what everyone else sees us as.
    this.myId = b4a.toString(this.swarm.keyPair.publicKey, 'hex').slice(0, 12);
    this.myKeyHex = b4a.toString(this.swarm.keyPair.publicKey, 'hex');
    if (this._inboxEnabled) this._joinOwnInbox();
    this.swarm.on('connection', (s, info) => this._onConn(s, info));
    this._startKeepalive();
    // Rotate blinded rendezvous topics every 5 min (checks the hourly epoch;
    // the frequent tick keeps the ±1 window fresh across the boundary).
    this._rvTimer = setInterval(() => { this._rotateRendezvous().catch(() => {}); }, 300000);
    return true;
  }

  // ── Blinded rotating rendezvous ────────────────────────────────────
  // A room is discoverable only on HMAC(roomSecret, epoch), where epoch is
  // the current UTC hour. The topic changes every hour, so a DHT observer
  // who doesn't hold the code can link a room's presence across at most one
  // epoch before the rendezvous point moves. There is deliberately no
  // static topic: a single long-lived one would undo the rotation. We sit on
  // the current epoch and its neighbours to absorb clock skew and the hour
  // boundary.
  _epochNow() { return Math.floor(Date.now() / 3600000); } // 1-hour epochs
  _roomSecret(name) {
    // Domain-separated so the topic is never a plain hash of the code. The
    // code itself is the capability; its entropy (lib/roomcode.js) is what
    // stops an offline guess against topics seen on the DHT.
    return crypto.createHash('sha256').update('sirr/rv/1|' + name).digest();
  }
  /** Key material for Echoes (lib/echoes.js): the room's, or a DM's pairwise secret. */
  _echoSecret(name) {
    if (/^DM[0-9A-F]{10}$/.test(name)) {
      const pub = this.dmKeys.get(name);
      return pub ? this.crypto.pairSecret(pub, 'sirr/dm-echo/1') : null;
    }
    return this._roomSecret(name);
  }
  _rotatingTopic(name, epoch) {
    if (/^DM[0-9A-F]{10}$/.test(name)) {
      // A DM's name is derived from two public fingerprints (and has only
      // 40 bits), so a topic built from it would let anyone find the pair.
      // Its rendezvous comes from a secret only the two of them share
      // instead; until we hold the counterpart's key there is none, and
      // the DM travels over connections we already have.
      const pub = this.dmKeys.get(name);
      if (!pub) return null;
      return crypto.createHmac('sha256', this.crypto.pairSecret(pub, 'sirr/dm-rv/1'))
        .update('epoch:' + epoch).digest();
    }
    return crypto.createHmac('sha256', this._roomSecret(name))
      .update('epoch:' + epoch).digest();
  }
  // All topics a room should currently be discoverable on.
  _topicsFor(name) {
    const e = this._epochNow();
    return [e, e - 1, e + 1].map(epoch => ({ topic: this._rotatingTopic(name, epoch), kind: 'rv', epoch }))
      .filter(t => t.topic);
  }

  /**
   * Record a DM counterpart's identity key (from an authenticated session or
   * from storage) so the DM gets its pairwise rendezvous. Returns true when
   * the key was new.
   */
  setDmPeerKey(code, pub64) {
    if (!/^DM[0-9A-F]{10}$/.test(String(code)) || typeof pub64 !== 'string') return false;
    if (this.dmKeys.get(code) === pub64) return false;
    try {
      const fp = this.crypto.getFingerprintFor(pub64);
      if (_dmCodeFor(this.crypto.getFingerprint(), fp) !== code) return false;   // not this DM's counterpart
    } catch (e) { return false; }
    this.dmKeys.set(code, pub64);
    const r = this.rooms.get(code);
    if (r && this.swarm) {
      for (const t of this._topicsFor(code)) {
        const hex = t.topic.toString('hex');
        if (this.topicToRoom.has(hex)) continue;
        try {
          const disc = this.swarm.join(t.topic, { client: true, server: true });
          r.discs.push({ disc, hex, kind: t.kind, epoch: t.epoch });
          this.topicToRoom.set(hex, code);
        } catch (e) {}
      }
    }
    return true;
  }

  async joinRoom(name) {
    if (this.rooms.has(name)) return { alreadyJoined: true };
    // Join every topic in the epoch window. Each gets its own discovery; topicToRoom maps all of them back to this room so an
    // inbound connection on any topic resolves correctly.
    //
    // IMPORTANT: we register the room and start the swarm joins synchronously,
    // but we do NOT await flushed() here. flushed() waits for the DHT announce
    // to propagate, which can take seconds on a healthy network and can hang
    // indefinitely behind carrier-grade NAT (mobile 5G, etc.). Room creation
    // is a local operation — it must not fail just because announce is slow.
    // Discovery converges in the background; peers appear when the DHT does.
    const topics = this._topicsFor(name);
    const discs = [];
    for (const t of topics) {
      const hex = t.topic.toString('hex');
      if (this.topicToRoom.has(hex)) continue;
      const disc = this.swarm.join(t.topic, { client: true, server: true });
      discs.push({ disc, hex, kind: t.kind, epoch: t.epoch });
      this.topicToRoom.set(hex, name);
    }
    const topicHex = topics.length ? topics[0].topic.toString('hex') : '';
    this.rooms.set(name, { topicHex, discs, epoch: this._epochNow() });
    // Flush in the background and report when discovery is announced, so the
    // UI can show a "searching → announced" state without blocking the join.
    Promise.all(discs.map(d => d.disc.flushed().catch(() => {})))
      .then(() => this.emit('room-announced', { room: name }))
      .catch(() => {});

    // Re-intersect with every already-connected peer's declared rooms. A peer
    // that sent us `declaredRooms = ['X', 'Y', 'Z']` on KEY_EXCHANGE when we
    // were only in X must now be credited for Y as soon as we join Y —
    // otherwise they stay invisible in Y's sidebar until they send a CHAT
    // (the lazy-reconcile path). This is the fix for "friend in a common
    // room shows 'joined' but not in peers until they message".
    for (const [pid, peer] of this.peers) {
      if (this._declares(peer, name) && !peer.rooms.has(name)) {
        peer.rooms.add(name);
        this._sendRoomKeys(pid);
        this.emit('peer-updated', this._peerPayload(pid, peer));
      }
    }

    // Tell existing peers our new membership — as per-connection tags
    // (never the raw code list; see _tag).
    this._sendRoomsUpdate();

    this.emit('room-joined', { room: name, topicHex: topicHex.slice(0, 16) });
    // A DM whose counterpart is already connected gets its rendezvous now.
    if (/^DM[0-9A-F]{10}$/.test(name) && !this.dmKeys.has(name)) {
      for (const [, peer] of this.peers) {
        if (peer.publicKey && peer.forwardSecret
            && _dmCodeFor(this.crypto.getFingerprint(), peer.fingerprint) === name) {
          if (this.setDmPeerKey(name, peer.publicKey)) this.emit('dm-key', { room: name, publicKey: peer.publicKey });
        }
      }
    }
    return { joined: true };
  }

  async leaveRoom(name) {
    const r = this.rooms.get(name);
    if (!r) return;
    // Tear down every discovery this room is on and drop each topic→room
    // mapping.
    const discs = r.discs || [];
    for (const d of discs) {
      try { await d.disc.destroy(); } catch (e) {}
      if (d.hex) this.topicToRoom.delete(d.hex);
    }
    if (r.topicHex) this.topicToRoom.delete(r.topicHex);
    this.rooms.delete(name);
    // Strip the room from every peer's known-shared set
    for (const [pid, peer] of this.peers) {
      if (peer.rooms.has(name)) {
        peer.rooms.delete(name);
        this.emit('peer-updated', this._peerPayload(pid, peer));
      }
    }
    // Tell peers we left
    this._sendRoomsUpdate();
  }

  // Epoch rotation: once an hour the rotating topics move. For each joined
  // room, join the new epoch's topic and retire the one that's now two epochs
  // old (we keep current ±1). Called on a timer started in init().
  async _rotateRendezvous() {
    const e = this._epochNow();
    for (const [name, r] of this.rooms) {
      if (r.epoch === e) continue; // already current
      const wantEpochs = new Set([e - 1, e, e + 1]);
      const discs = r.discs || [];
      // Add topics for any epoch in the window we're not already on.
      for (const ep of wantEpochs) {
        const topic = this._rotatingTopic(name, ep);
        if (!topic) continue;
        const hex = topic.toString('hex');
        if (this.topicToRoom.has(hex)) continue;
        try {
          const disc = this.swarm.join(topic, { client: true, server: true });
          discs.push({ disc, hex, kind: 'rv', epoch: ep });
          this.topicToRoom.set(hex, name);
        } catch (err) {}
      }
      // Retire rotating topics older than the window.
      const keep = [];
      for (const d of discs) {
        if (d.kind === 'rv' && d.epoch !== undefined && !wantEpochs.has(d.epoch)) {
          try { await d.disc.destroy(); } catch (err) {}
          this.topicToRoom.delete(d.hex);
        } else {
          keep.push(d);
        }
      }
      r.discs = keep;
      r.epoch = e;
    }
  }

  // Build the payload we send to the renderer for a peer event
  _peerPayload(pid, peer) {
    return {
      peerId: pid,
      nickname: peer.nickname,
      fingerprint: peer.fingerprint,
      avatarEmoji: peer.avatarEmoji || '',
      avatarPixels: peer.avatarPixels || '',
      status: peer.status || 'active',
      statusText: peer.statusText || '',
      forwardSecret: !!peer.forwardSecret,  // v2 ephemeral session established
      rooms: [...peer.rooms],  // which rooms we share with this peer
    };
  }

  // Figure out which rooms we share with a freshly-connected peer.
  // Hyperswarm gives us `info.topics` (array of Buffers) — we reverse-lookup
  // to room names via our topicToRoom map.
  // ─── Room membership proofs ─────────────────────────────────
  // Room codes are join secrets (and DM codes name who you talk to), so
  // membership is never declared by sending codes: a member of one room
  // would learn, and could walk into, all of your others. Each room is
  // proven with a tag bound to THIS connection:
  //     tag = HMAC-SHA256(key = room code, "sirr/room-tag/1|" keyA "|" keyB)
  // (keyA/keyB = both swarm public keys, sorted). Only someone who knows
  // the code can produce or check it, and it's useless on any other
  // connection, so it can't be replayed to a third party.
  // A peer that declares membership with a raw code list instead of tags is
  // answered with exactly the codes it already proved it knows.
  _tag(code, peer) {
    // Memoised per connection: tags are checked for every room on every
    // membership update, and the inputs never change for a live socket.
    const cache = peer._tagCache || (peer._tagCache = new Map());
    let t = cache.get(code);
    if (t === undefined) {
      const pair = [this.myKeyHex || '', peer.remoteKeyHex || ''].sort().join('|');
      t = crypto.createHmac('sha256', String(code)).update('sirr/room-tag/1|' + pair).digest('hex').slice(0, 32);
      cache.set(code, t);
    }
    return t;
  }
  _declares(peer, code) {
    return !!((peer.declaredTags && peer.declaredTags.has(this._tag(code, peer)))
      || (peer.declaredRooms && peer.declaredRooms.has(code)));
  }
  _roomsPayloadFor(peer) {
    const tags = [], raw = [];
    for (const code of this.rooms.keys()) {
      tags.push(this._tag(code, peer));
      if (peer.declaredRooms && peer.declaredRooms.has(code)) raw.push(code);   // they told us first
    }
    return { roomTags: tags, rooms: raw };
  }
  /** Apply a peer's declared membership; returns true if the shared set changed. */
  _applyDeclared(pid, peer, msg, { keepIfEmpty = false } = {}) {
    let touched = false;
    if (Array.isArray(msg.roomTags)) {
      peer.declaredTags = new Set(msg.roomTags.filter(t => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)).slice(0, ROOMS_MAX));
      touched = true;
    }
    if (Array.isArray(msg.rooms)) {
      peer.declaredRooms = new Set(msg.rooms.filter(r => typeof r === 'string' && r.length <= 128).slice(0, ROOMS_MAX));
      touched = true;
    }
    if (!touched) return false;
    const next = new Set();
    for (const code of this.rooms.keys()) {
      if (!this._declares(peer, code)) continue;
      if (/^DM[0-9A-F]{10}$/.test(code) && peer.fingerprint
          && code !== _dmCodeFor(this.crypto.getFingerprint(), peer.fingerprint)) continue;
      next.add(code);
    }
    if (keepIfEmpty && next.size === 0 && peer.rooms.size > 0) return false;
    const before = [...peer.rooms].sort().join('|');
    peer.rooms = next;
    const changed = before !== [...next].sort().join('|');
    // An older client (raw list, no tags) only learns what we share from a
    // raw list — send exactly the codes it just proved it knows.
    if (!msg.roomTags && next.size) {
      const disclose = [...next].sort().join('|');
      if (peer._rawDisclosed !== disclose) {
        peer._rawDisclosed = disclose;
        this._send(peer.socket, { type: MSG.ROOMS_UPDATE, rooms: [...next] });
      }
    }
    if (changed) this._sendRoomKeys(pid);
    return changed;
  }
  _sendRoomsUpdate() {
    for (const [, peer] of this.peers) {
      if (!peer.keyExchanged) continue;
      this._send(peer.socket, { type: MSG.ROOMS_UPDATE, ...this._roomsPayloadFor(peer) });
    }
  }
  /** Tell one peer our per-room signing keys for the rooms we share (encrypted). */
  _sendRoomKeys(pid) {
    const peer = this.peers.get(pid);
    if (!peer || !this.crypto.hasSession(pid) || !peer.rooms.size) return;
    if (!peer._keysSent) peer._keysSent = new Set();
    const keys = [];
    for (const room of peer.rooms) {
      if (peer._keysSent.has(room)) continue;
      try { keys.push({ room, pub: this.crypto.roomSignPub(room) }); peer._keysSent.add(room); } catch (e) {}
    }
    if (!keys.length) return;
    try { this._send(peer.socket, { type: MSG.ROOM_KEYS, data: this.crypto.encrypt(JSON.stringify({ keys }), pid) }); } catch (e) {}
  }

  _roomsForInfo(info) {
    const out = new Set();
    const hexes = new Set();
    const topics = info?.topics || [];
    for (const t of topics) {
      const hex = b4a.isBuffer(t) || t instanceof Uint8Array
        ? b4a.toString(t, 'hex')
        : String(t);
      hexes.add(hex);
      const room = this.topicToRoom.get(hex);
      if (room) out.add(room);
    }
    return { rooms: out, hexes };
  }

  _onConn(socket, info) {
    const pid = info.publicKey
      ? b4a.toString(info.publicKey, 'hex').slice(0, 12)
      : crypto.randomBytes(6).toString('hex');

    // If we already have a peer with this pid, the new connection is a dup
    // (Hyperswarm occasionally opens parallel streams). Keep the older one.
    if (this.peers.has(pid)) {
      try { socket.destroy(); } catch (e) {}
      return;
    }

    const { rooms, hexes } = this._roomsForInfo(info);
    this.buffers.set(pid, '');

    // Provisional peer record — we'll fill nickname/fingerprint on KEY_EXCHANGE
    const peer = {
      socket,
      nickname: pid,              // placeholder until KEY_EXCHANGE
      publicKey: null,
      fingerprint: '',
      avatarEmoji: '',
      status: 'active',
      statusText: '',
      senderId: '',
      rooms,                      // which of OUR rooms this peer is in (intersection)
      declaredRooms: new Set(),   // full list the peer has declared — used to
                                  // re-intersect when WE join a room later
      topicHexes: hexes,          // raw topic hexes (for later room joins)
      remoteKeyHex: info.publicKey ? b4a.toString(info.publicKey, 'hex') : pid,
      declaredTags: new Set(),
      lastSeen: Date.now(),
      keyExchanged: false,
    };
    this.peers.set(pid, peer);

    // Send our key-exchange immediately, including the list of rooms WE'RE in.
    // The peer does the same; intersection = shared rooms.
    // We also advertise a per-connection ephemeral public key; the
    // forward-secret handshake completes with KEY_CONFIRM.
    const { ephPub64 } = this.crypto.beginEphemeral(pid);
    this._send(socket, {
      type: MSG.KEY_EXCHANGE,
      kxVersion: 3,
      ephPub: ephPub64,
      clk: Math.round(Date.now() / 60000),
      publicKey: this.crypto.getPublicKeyB64(),
      // Nickname, avatar and status go out only inside the session
      // (PROFILE): nothing about who you are crosses before authentication
      // — not to someone probing your inbox, not to a bridge.
      senderId: this.myId,
      // membership as connection-bound tags; `rooms` (raw codes) is
      // left empty — older clients get raw codes only after proving them.
      ...this._roomsPayloadFor(peer),
      caps: [bolt.CAP],
    });

    // One byte-level demultiplexer per socket: newline-delimited JSON (all
    // existing messages) and binary BOLT frames share the stream. Lines are
    // decoded only once complete, so UTF-8 split across packets is safe.
    const demux = new bolt.StreamDemux({ maxLine: MAX_LINE_BYTES, maxBuffer: MAX_BUFFER_BYTES });
    const onLine = (ln) => {
      let msg;
      try { msg = JSON.parse(ln); } catch (e) { return; }
      this._onMsg(pid, socket, msg);
    };
    const onFrame = (hdr, header, payload) => {
      const p = this.peers.get(pid);
      if (!p || !p.keyExchanged) return;
      this.emit('bolt-frame', { peerId: pid, hdr, header, payload });
    };
    socket.on('data', (raw) => {
      if (this.peers.get(pid)?.socket !== socket) return;   // superseded socket
      if (!demux.push(raw, onLine, onFrame)) {
        // Corrupt framing or an unbounded line/buffer — broken or hostile peer.
        try { socket.destroy(); } catch (e) {}
        return;
      }
      const p = this.peers.get(pid);
      if (p) p.lastSeen = Date.now();
    });

    socket.on('error', () => {});
    socket.on('close', () => { if (this.peers.get(pid)?.socket === socket) this._dropPeer(pid); });
  }

  _dropPeer(pid) {
    const p = this.peers.get(pid);
    if (!p) return;
    const payload = this._peerPayload(pid, p);
    this.peers.delete(pid);
    this.buffers.delete(pid);
    // Drop any half-done file transfers from this peer so the map can't grow
    // unbounded across reconnects.
    const prefix = pid + ':';
    for (const key of this.incomingFiles.keys()) {
      if (key.startsWith(prefix)) this.incomingFiles.delete(key);
    }
    // Discard any DMs still queued on this peer — without a session we can
    // never validate them, and we've already released the decrypted payload
    // from the parked entry.
    if (this.pendingDmChats.length) {
      this.pendingDmChats = this.pendingDmChats.filter(e => e.pid !== pid);
    }
    this.crypto.removeSession(pid);
    this.crypto.clearEphemeral(pid);
    clearTimeout(p._joinTimer);
    if (p._joined) this.emit('peer-left', payload);
  }

  _onMsg(pid, socket, msg) {
    const peer = this.peers.get(pid);
    if (!peer || !msg || typeof msg !== 'object') return;
    // Until the peer has proven its identity (KEY_EXCHANGE, then the
    // KEY_CONFIRM that installs the session), only the handshake and
    // keepalive are accepted. Everything else — room state, pins, admin
    // claims, voice signaling — must come from an authenticated identity.
    if (!PRE_AUTH.has(msg.type)) {
      if (!peer.keyExchanged) return;
      if (!this.crypto.hasSession(pid) && msg.type !== MSG.ANNOUNCE && msg.type !== MSG.ROOMS_UPDATE) return;
    }

    switch (msg.type) {
      case MSG.KEY_EXCHANGE: {
        if (peer.keyExchanged) return; // ignore duplicates
        // ── Session establishment ──────────────────────────────────
        // Both sides send an ephemeral X25519 key bound to their identity
        // (see crypto-layer). We authenticate the peer's ephemeral key, send
        // KEY_CONFIRM with our tag, and install the session when THEIR
        // KEY_CONFIRM arrives. There is no static-key fallback: a peer (or a
        // man in the middle stripping fields) that doesn't offer an
        // ephemeral key gets no session, so forward secrecy can't be
        // downgraded away.
        if (!(msg.kxVersion >= 3) || typeof msg.ephPub !== 'string' || typeof msg.publicKey !== 'string') {
          this.emit('crypto-error', { peerId: pid, error: 'peer offered no forward-secret key exchange' });
          try { socket.destroy(); } catch (e) {}
          this._dropPeer(pid);
          return;
        }
        let r;
        try {
          const tag = this.crypto.ephemeralAuth(pid, msg.publicKey, msg.ephPub,
            [this.myKeyHex || '', peer.remoteKeyHex || ''].sort().join('|'));
          // Stash what we need to verify their upcoming KEY_CONFIRM.
          peer._kx = { peerIdent: msg.publicKey, peerEph: msg.ephPub };
          this._send(socket, { type: MSG.KEY_CONFIRM, tag });
          // We already know their identity key, so the blocklist gate and
          // peer record can populate without waiting for the session.
          r = { fingerprint: this.crypto.getFingerprintFor(msg.publicKey) };
        } catch (e) {
          this.emit('crypto-error', { peerId: pid, error: 'key exchange failed' }); return;
        }
        // Blocklist gate: drop the connection the instant we know who they
        // are. Fingerprint comes from the peer's public key, so they can't
        // spoof someone else's identity out of the block.
        if (this.blockedFingerprints.has(r.fingerprint)) {
          try { socket.destroy(); } catch (e) {}
          this._dropPeer(pid);
          return;
        }
        peer.keyExchanged = true;
        this._noteClock(peer, msg.clk);
        peer.publicKey = msg.publicKey;
        peer.fingerprint = r.fingerprint;
        try { peer.identityId = this.crypto.identityIdFor(msg.publicKey); } catch (e) { peer.identityId = ''; }
        peer.nickname = pid;              // until PROFILE arrives
        peer.senderId = msg.senderId || '';
        peer.caps = new Set(Array.isArray(msg.caps) ? msg.caps.filter(c => typeof c === 'string').slice(0, 16) : []);

        // Reconcile rooms: peer told us which rooms they're in. Intersect
        // with our rooms — whatever's in both, we share. This replaces the
        // unreliable Hyperswarm info.topics inference.
        peer.rooms = new Set();
        this._applyDeclared(pid, peer, { roomTags: Array.isArray(msg.roomTags) ? msg.roomTags : undefined,
                                         rooms: Array.isArray(msg.rooms) ? msg.rooms : [] });
        // 'peer-joined' waits for KEY_CONFIRM: until then the identity is
        // only claimed, and nothing about it may reach rosters or the UI.
        // Reply with our own announce so both sides are fully populated
        this._send(socket, {
          type: MSG.ANNOUNCE,
          caps: [bolt.CAP],
          ...this._roomsPayloadFor(peer),
        });
        // The session isn't usable until KEY_CONFIRM arrives; parked DMs
        // are drained there.
        break;
      }

      case MSG.KEY_CONFIRM: {
        // Second leg of the v2 forward-secret handshake. Verify the peer's
        // tag against our ephemeral pair and install the ephemeral↔ephemeral
        // session. Only valid if we previously stashed their KEY_EXCHANGE.
        if (!peer._kx) return;            // no v2 handshake in progress
        if (this.crypto.isForwardSecret(pid)) return; // already done
        try {
          const res = this.crypto.completeEphemeral(
            pid, peer._kx.peerIdent, peer._kx.peerEph, msg.tag,
          );
          // Fingerprint must match what we already recorded — defends
          // against a confirm that somehow references a different identity.
          if (peer.fingerprint && res.fingerprint !== peer.fingerprint) {
            this.emit('crypto-error', { peerId: pid, error: 'confirm fingerprint mismatch' });
            return;
          }
          peer._kx = null;
          peer.forwardSecret = true;
          this._sendProfile(pid);
          // Announce the peer once its PROFILE is in (or after 2 s), so the
          // UI never shows a placeholder name.
          peer._joinTimer = setTimeout(() => this._emitJoined(pid), 2000);
          // Now authenticated: if we hold a DM with this identity, it can
          // have its pairwise rendezvous.
          const dm = _dmCodeFor(this.crypto.getFingerprint(), peer.fingerprint);
          if (this.rooms.has(dm) && this.setDmPeerKey(dm, peer.publicKey)) this.emit('dm-key', { room: dm, publicKey: peer.publicKey });
          this.emit('session-ready', { peerId: pid, fingerprint: peer.fingerprint });
          this._sendRoomKeys(pid);
          // Session is live — now safe to decrypt any DMs parked during the
          // two-leg handshake.
          this._drainPendingDmChats(pid);
        } catch (e) {
          this.emit('crypto-error', { peerId: pid, error: 'ephemeral auth failed' });
          // Auth failure is a hard stop: a peer that can't prove control of
          // its identity key doesn't get a session at all.
          try { socket.destroy(); } catch (e2) {}
          this._dropPeer(pid);
        }
        break;
      }

      case MSG.ANNOUNCE: {
        if (Array.isArray(msg.caps)) peer.caps = new Set(msg.caps.filter(c => typeof c === 'string').slice(0, 16));
        // ANNOUNCE may also carry rooms (belt-and-braces: if KEY_EXCHANGE's
        // rooms list was missing or stale, we can still sync here)
        if (Array.isArray(msg.rooms) || Array.isArray(msg.roomTags)) {
          // Don't clobber a good set with an empty announce.
          this._applyDeclared(pid, peer, msg, { keepIfEmpty: true });
        }
        // Before KEY_CONFIRM the state is kept and goes out with 'peer-joined'.
        if (this.crypto.hasSession(pid)) this.emit('peer-updated', this._peerPayload(pid, peer));
        break;
      }

      case MSG.ROOMS_UPDATE: {
        // Peer's room membership changed (joined or left a room)
        if (!Array.isArray(msg.rooms) && !Array.isArray(msg.roomTags)) break;
        this._applyDeclared(pid, peer, msg);
        if (this.crypto.hasSession(pid)) this.emit('peer-updated', this._peerPayload(pid, peer));
        break;
      }

      case MSG.CHAT: {
        if (!this.crypto.hasSession(pid)) return;
        let pt;
        try { pt = JSON.parse(this.crypto.decrypt(msg.data, pid)); }
        catch (e) { this.emit('crypto-error', { peerId: pid, error: e.message }); return; }
        this._deliverChat(pid, pt);
        break;
      }

      case MSG.LEAVE: {
        this._dropPeer(pid);
        break;
      }

      case MSG.TYPING: {
        if (msg.room && (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room))) return;
        this.emit('peer-typing', {
          peerId: pid, nickname: peer.nickname,
          room: msg.room || '', channel: msg.channel || 'default',
        });
        break;
      }

      case MSG.CHANNEL_CREATE: {
        if (!msg.room || !msg.channel) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('channel-created', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room, channel: msg.channel,
          silent: !!msg.silent,
        });
        break;
      }
      case MSG.CHANNEL_RENAME: {
        if (!msg.room || !msg.channelId) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('channel-renamed', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room, channelId: msg.channelId,
          newName: msg.newName, silent: !!msg.silent,
        });
        break;
      }
      case MSG.CHANNEL_DELETE: {
        if (!msg.room || !msg.channelId) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('channel-deleted', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room, channelId: msg.channelId,
        });
        break;
      }
      case MSG.CHANNELS_SYNC: {
        if (!msg.room || !Array.isArray(msg.channels)) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('channels-sync', {
          peerId: pid, fingerprint: peer.fingerprint, room: msg.room, channels: msg.channels,
        });
        break;
      }

      case MSG.ROOM_RENAME: {
        if (msg.room && (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room))) return;
        this.emit('room-renamed', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room, newName: msg.newName,
          // `silent` is set when the sender is just syncing their current
          // name to a fresh peer (not an actual rename event). Renderer
          // suppresses the toast in that case.
          silent: !!msg.silent,
        });
        break;
      }

      case MSG.ROOM_CHARTER: {
        // Peer told us who owns a room we both share. Sender identity is
        // crypto-authenticated; deciding whether to adopt the charter
        // (vs. ignoring an obvious forgery) happens in main.js where
        // storage lives.
        if (!msg.room || !msg.ownerFingerprint || !msg.createdAt) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('room-charter', {
          peerId: pid, fingerprint: peer.fingerprint, nickname: peer.nickname,
          room: msg.room,
          ownerFingerprint: String(msg.ownerFingerprint),
          createdAt: Number(msg.createdAt) || 0,
        });
        break;
      }
      case MSG.ADMIN_UPDATE: {
        // Owner granted or revoked admin perms for a fingerprint. Receiver
        // verifies sender == ownerFingerprint in main.js.
        if (!msg.room || !msg.target) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('admin-update', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room,
          target: String(msg.target),
          perms: msg.perms || null,
        });
        break;
      }
      case MSG.ADMIN_SYNC: {
        // Owner shipped us the full admin table on peer-joined. Applied as
        // a replace only if sender is the verified owner (checked in main).
        if (!msg.room || !msg.admins || typeof msg.admins !== 'object') break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('admin-sync', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room,
          admins: msg.admins,
        });
        break;
      }

      case MSG.VOICE_JOIN:
      case MSG.VOICE_READY:
      case MSG.VOICE_OFFER:
      case MSG.VOICE_ANSWER:
      case MSG.VOICE_ICE:
      case MSG.VOICE_LEAVE: {
        if (msg.room && (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room))) return;
        this.emit('voice-signal', {
          peerId: pid,
          type: msg.type,
          room: msg.room || '',
          channel: msg.channel || '',
          data: msg.data || '',
        });
        break;
      }

      case MSG.VOICE_MEDIA: {
        // Media is never persisted or rendered as text — it goes straight
        // to the mesh decoder. The Hyperswarm stream already provides
        // confidentiality and peer authentication (Noise), exactly as for
        // the voice signaling above.
        if (!msg.room || !this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        if (typeof msg.d !== 'string' || msg.d.length > VOICE_MEDIA_MAX_BYTES * 4 / 3 + 4) return;
        const now = Date.now();
        if (!peer._vmWin || now - peer._vmWin >= 1000) { peer._vmWin = now; peer._vmCount = 0; }
        if (++peer._vmCount > VOICE_MEDIA_MAX_PER_SEC) return;
        let data;
        try { data = b4a.from(msg.d, 'base64'); } catch (e) { return; }
        if (!data.length || data.length > VOICE_MEDIA_MAX_BYTES) return;
        this.emit('voice-media', { peerId: pid, room: msg.room, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
        break;
      }

      case MSG.ROOM_KEYS: {
        if (!this.crypto.hasSession(pid)) return;
        let obj;
        try { obj = JSON.parse(this.crypto.decrypt(msg.data, pid)); } catch (e) { return; }
        if (!obj || !Array.isArray(obj.keys)) return;
        const keys = [];
        for (const k of obj.keys.slice(0, ROOMS_MAX)) {
          if (!k || typeof k.room !== 'string' || !peer.rooms.has(k.room)) continue;   // only rooms we share
          if (typeof k.pub !== 'string' || Buffer.from(k.pub, 'base64').length !== 32) continue;
          keys.push({ room: k.room, pub: k.pub });
        }
        if (keys.length) this.emit('room-keys', { peerId: pid, fingerprint: peer.fingerprint, keys });
        break;
      }

      case MSG.ROOM_MOVE: {
        if (!this.crypto.hasSession(pid)) return;
        let obj;
        try { obj = JSON.parse(this.crypto.decrypt(msg.data, pid)); } catch (e) { return; }
        // Only from a peer that proved it knows the old code.
        if (!obj || typeof obj.from !== 'string' || !peer.rooms.has(obj.from)) return;
        this.emit('room-move', { peerId: pid, fingerprint: peer.fingerprint, identityId: peer.identityId || '', move: obj });
        break;
      }

      case MSG.BOLT_CTL: {
        if (!this.crypto.hasSession(pid)) return;
        let obj;
        try { obj = JSON.parse(this.crypto.decrypt(msg.data, pid)); } catch (e) { return; }
        if (!obj || typeof obj !== 'object' || typeof obj.op !== 'string') return;
        if (obj.room && (!this.rooms.has(obj.room) || !peer.rooms.has(obj.room))) return;
        this.emit('bolt-ctl', { peerId: pid, fingerprint: peer.fingerprint, nickname: peer.nickname, obj });
        break;
      }

      case MSG.FILE_START:
      case MSG.FILE_CHUNK:
      case MSG.FILE_END: {
        if (!this.crypto.hasSession(pid)) return;
        let pt;
        try { pt = JSON.parse(this.crypto.decrypt(msg.data, pid)); }
        catch (e) { return; }
        if (pt.room) {
          if (!this.rooms.has(pt.room) || !peer.rooms.has(pt.room)) return;
        }
        // Default channel keeps older clients (which don't set .channel) in
        // the "default" bucket instead of a ghost channel.
        if (!pt.channel) pt.channel = 'default';
        // Per-transfer byte accounting — a malicious peer can't stream past
        // MAX_INBOUND_FILE_BYTES regardless of how many chunks they send.
        if (pt.fileId) {
          const key = pid + ':' + pt.fileId;
          if (msg.type === MSG.FILE_START) {
            const announced = Number(pt.fileSize) > 0 ? Number(pt.fileSize) : MAX_INBOUND_FILE_BYTES;
            const cap = Math.min(announced, MAX_INBOUND_FILE_BYTES);
            const totalChunks = Number(pt.totalChunks);
            const maxChunks = announced > 0
              ? Math.max(1, Math.ceil(cap / MIN_FILE_CHUNK_BYTES))
              : 0;
            if (!Number.isInteger(totalChunks) || totalChunks < 0 || totalChunks > maxChunks) {
              this._abortIncomingFile(pid, peer, pt, 'bad-meta');
              return;
            }
            if (announced > 0 && totalChunks === 0) {
              this._abortIncomingFile(pid, peer, pt, 'bad-meta');
              return;
            }
            this.incomingFiles.set(key, { bytes: 0, cap, aborted: false, totalChunks });
            if (announced > MAX_INBOUND_FILE_BYTES) {
              this.incomingFiles.get(key).aborted = true;
              this._abortIncomingFile(pid, peer, pt, 'size-cap');
              return;
            }
          } else {
            const rec = this.incomingFiles.get(key);
            if (rec && rec.aborted) return;  // swallow remaining chunks
            if (rec && msg.type === MSG.FILE_CHUNK) {
              if (!Number.isInteger(pt.index) || pt.index < 0 || pt.index >= rec.totalChunks) {
                rec.aborted = true;
                this._abortIncomingFile(pid, peer, pt, 'bad-meta');
                return;
              }
              // Exact decoded length. The old floor(len·3/4) counted base64
              // padding as data (+1 byte per 512 KB chunk), so the running
              // total overshot the announced size on the LAST chunk and
              // every file ≥ 512 KB was aborted as "size-cap" after it had
              // fully arrived — the "files never arrive" bug.
              const add = typeof pt.data === 'string' ? b64DecodedLen(pt.data) : 0;
              rec.bytes += add;
              if (rec.bytes > rec.cap) {
                rec.aborted = true;
                this._abortIncomingFile(pid, peer, pt, 'size-cap');
                return;
              }
            }
            if (msg.type === MSG.FILE_END) this.incomingFiles.delete(key);
          }
        }
        this.emit('file-transfer', {
          peerId: pid,
          nickname: peer.nickname,
          fingerprint: peer.fingerprint,
          msgType: msg.type,
          ...pt,
        });
        break;
      }

      case MSG.COVER: break;   // chaff: nothing to do

      case MSG.PROFILE: {
        if (!this.crypto.hasSession(pid)) return;
        let p;
        try { p = JSON.parse(this.crypto.decrypt(msg.data, pid)); } catch (e) { return; }
        if (!p || typeof p !== 'object') return;
        if (typeof p.nickname === 'string' && p.nickname.trim()) peer.nickname = p.nickname.slice(0, 32);
        peer.avatarEmoji = String(p.avatarEmoji || '').slice(0, 32);
        peer.avatarPixels = (/^(8|12|16|24|32):[A-Za-z0-9+/]{1,176}={0,2}$/.test(String(p.avatarPixels || '')) ? String(p.avatarPixels) : '');
        peer.status = p.status === 'away' ? 'away' : 'active';
        peer.statusText = String(p.statusText || '').slice(0, 80);
        if (!peer._joined) this._emitJoined(pid);
        else this.emit('peer-updated', this._peerPayload(pid, peer));
        break;
      }

      case MSG.PING: {
        // Reply with PONG (echo the timestamp if any)
        this._send(socket, { type: MSG.PONG, t: msg.t || 0 });
        break;
      }

      case MSG.PONG: {
        // The keepalive PING we sent embedded its dispatch timestamp in `t`;
        // PONG echoes it back. Round-trip = now − t (clock-skew-immune
        // because both readings come from this side's clock).
        if (msg.t) {
          const rtt = Date.now() - msg.t;
          if (rtt >= 0 && rtt < 60_000) peer.rtt = rtt;
        }
        break;
      }

      case MSG.CONTACT_ADD: {
        // Unilateral: another peer has added us to their contacts. This is
        // the "NICKNAME has added you" notification hook. We don't auto-add
        // them back — that's an explicit user action.
        // Per-peer debounce: a peer can't pop more than one toast within
        // CONTACT_ADD_MIN_MS. Blocks a noisy/malicious peer from spamming
        // unbounded notifications.
        const now = Date.now();
        if (peer.lastContactAddAt && now - peer.lastContactAddAt < CONTACT_ADD_MIN_MS) return;
        peer.lastContactAddAt = now;
        this.emit('contact-add', {
          peerId: pid,
          nickname: peer.nickname,
          fingerprint: peer.fingerprint,
          avatarEmoji: peer.avatarEmoji || '',
          avatarPixels: peer.avatarPixels || '',
        });
        break;
      }

      case MSG.SYNC_SUMMARY: {
        // Peer is telling us which msgIds they have for a given room. We
        // compare to our own store and request whatever's missing.
        if (!msg.room || !Array.isArray(msg.ids)) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('sync-summary', {
          peerId: pid,
          room: msg.room,
          ids: msg.ids.slice(0, SYNC_MAX_IDS),  // [{msgId, channel, ts}, ...]
        });
        break;
      }

      case MSG.SYNC_REQUEST: {
        if (!msg.room || !Array.isArray(msg.msgIds)) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('sync-request', {
          peerId: pid, room: msg.room,
          msgIds: msg.msgIds.filter(x => typeof x === 'string' && x.length <= 64).slice(0, SYNC_MAX_IDS),
        });
        break;
      }

      case MSG.SYNC_MESSAGES: {
        if (!this.crypto.hasSession(pid)) return;
        let pt;
        try { pt = JSON.parse(this.crypto.decrypt(msg.data, pid)); }
        catch (e) { this.emit('crypto-error', { peerId: pid, error: e.message }); return; }
        if (!pt.room || !Array.isArray(pt.messages)) break;
        if (!this.rooms.has(pt.room) || !peer.rooms.has(pt.room)) return;
        this.emit('sync-messages', {
          peerId: pid, fingerprint: peer.fingerprint, nickname: peer.nickname,
          room: pt.room, messages: pt.messages.slice(0, SYNC_MAX_IDS),
        });
        break;
      }

      case MSG.PIN_TOGGLE: {
        if (!msg.room || !msg.channel || !msg.msgId) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('pin-toggle', {
          peerId: pid,
          room: msg.room,
          channel: msg.channel,
          msgId: msg.msgId,
          pinned: !!msg.pinned,
          preview: msg.preview || '',
          nick: msg.nick || peer.nickname,
          ts: msg.ts || Date.now(),
          silent: !!msg.silent,
        });
        break;
      }

      case MSG.PINS_SYNC: {
        if (!msg.room || !msg.channel || !Array.isArray(msg.pins)) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('pins-sync', {
          peerId: pid, room: msg.room, channel: msg.channel, pins: msg.pins,
        });
        break;
      }

      case MSG.MSG_EDIT: {
        // Encrypted: payload carries the new content. Receiver enforces
        // author-identity (sender fingerprint must match the message's
        // original author) at the storage layer in main.js.
        if (!this.crypto.hasSession(pid)) return;
        let pt;
        try { pt = JSON.parse(this.crypto.decrypt(msg.data, pid)); }
        catch (e) { this.emit('crypto-error', { peerId: pid, error: e.message }); return; }
        if (!pt.room || !pt.msgId) break;
        if (!this.rooms.has(pt.room) || !peer.rooms.has(pt.room)) return;
        this.emit('msg-edit', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: pt.room, channel: pt.channel || 'default',
          msgId: pt.msgId, content: pt.content || '',
          editedAt: Number(pt.editedAt) || Date.now(),
          editSig: typeof pt.editSig === 'string' ? pt.editSig : '',
        });
        break;
      }

      case MSG.MSG_DELETE_FOR_ALL: {
        // Plaintext: msgId is not secret on its own. Receiver verifies the
        // sender is owner OR original author at the storage layer.
        if (!msg.room || !msg.msgId) break;
        if (!this.rooms.has(msg.room) || !peer.rooms.has(msg.room)) return;
        this.emit('msg-delete-for-all', {
          peerId: pid, fingerprint: peer.fingerprint,
          room: msg.room, channel: msg.channel || 'default', msgId: msg.msgId,
        });
        break;
      }
    }
  }

  // Decrypted CHAT delivery. Split out so the deferred-DM drain can
  // replay a message along the exact same path as live delivery.
  _deliverChat(pid, pt) {
    const peer = this.peers.get(pid);
    if (!peer) return;
    if (pt.room) {
      if (pt.room.startsWith('DM')) {
        // DM delivery: the ONLY valid sender is the other half of the
        // fingerprint pair encoded in the DM code. If either fingerprint
        // isn't populated yet (shouldn't happen — KEY_EXCHANGE strictly
        // precedes CHAT because both gate on `hasSession` — but defend
        // anyway), queue the message and retry on next KEY_EXCHANGE drain.
        const myFp = (this.crypto && this.crypto.getFingerprint) ? this.crypto.getFingerprint() : '';
        if (!myFp || !peer.fingerprint) {
          this._queuePendingDm(pid, pt);
          return;
        }
        if (pt.room !== _dmCodeFor(myFp, peer.fingerprint)) return;
        if (!peer.rooms.has(pt.room)) {
          peer.rooms.add(pt.room);
          this.emit('peer-updated', this._peerPayload(pid, peer));
        }
      } else {
        // Regular room: we must be a member.
        if (!this.rooms.has(pt.room) || !peer.rooms.has(pt.room)) return;
      }
    }
    this.emit('message', {
      peerId: pid,
      nickname: peer.nickname,
      fingerprint: peer.fingerprint,
      room: pt.room,
      channel: pt.channel || 'default',
      content: pt.content,
      timestamp: pt.timestamp,
      type: pt.type || 'text',
      msgId: pt.msgId || '',
      replyTo: pt.replyTo || null,
      fileName: pt.fileName || '',
      fileSize: pt.fileSize || 0,
      expiresAt: Number(pt.expiresAt) || 0,
      sig: typeof pt.sig === 'string' && pt.sig.length <= 100 ? pt.sig : '',
    });
  }
  _queuePendingDm(pid, pt) {
    // Drop ancient entries first, then enforce the hard cap. We prune the
    // oldest when the queue would overflow so a noisy peer can't grow the
    // buffer past MAX_PENDING_DM_CHATS.
    const now = Date.now();
    this.pendingDmChats = this.pendingDmChats.filter(e => now - e.receivedAt < PENDING_DM_TTL_MS);
    if (this.pendingDmChats.length >= MAX_PENDING_DM_CHATS) {
      this.pendingDmChats.shift();
    }
    this.pendingDmChats.push({ pid, pt, receivedAt: now });
  }
  _drainPendingDmChats(pidJustReady) {
    if (!this.pendingDmChats.length) return;
    const now = Date.now();
    const remaining = [];
    for (const e of this.pendingDmChats) {
      if (now - e.receivedAt >= PENDING_DM_TTL_MS) continue;  // expired
      if (e.pid === pidJustReady) {
        // Peer's fingerprint is now set — replay through the normal path.
        this._deliverChat(e.pid, e.pt);
      } else {
        remaining.push(e);
      }
    }
    this.pendingDmChats = remaining;
  }

  _abortIncomingFile(pid, peer, pt, reason) {
    this.emit('file-transfer', {
      peerId: pid, nickname: peer.nickname, fingerprint: peer.fingerprint,
      msgType: MSG.FILE_END, ...pt, aborted: true, reason,
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Keepalive — catches silent half-open TCP / wifi drop
  // ───────────────────────────────────────────────────────────────────

  _startKeepalive() {
    if (this._keepaliveTimer) clearInterval(this._keepaliveTimer);
    this._keepaliveTimer = setInterval(() => {
      const now = Date.now();
      const toDrop = [];
      for (const [pid, peer] of this.peers) {
        // Drop if we haven't heard ANYTHING in over the timeout
        if (now - peer.lastSeen > KEEPALIVE_TIMEOUT_MS) {
          toDrop.push(pid);
          continue;
        }
        // Otherwise send a PING
        this._send(peer.socket, { type: MSG.PING, t: now });
      }
      for (const pid of toDrop) {
        const p = this.peers.get(pid);
        if (p) {
          try { p.socket.destroy(); } catch (e) {}
          this._dropPeer(pid);
        }
      }
    }, KEEPALIVE_MS);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Sending
  // ───────────────────────────────────────────────────────────────────

  _peerSharesRoom(peer, room) {
    if (!peer || !room) return false;
    // a DM room is shared with exactly ONE peer — the counterpart.
    // DM codes are SHA-256 of the two fingerprints, and fingerprints are
    // shown to everyone in any common room, so a third party could compute
    // the code, join it, and be sent every message, file and call in that
    // DM. Every send path goes through here.
    // the counterpart does NOT need to have opened the DM yet — if we
    // have any connection to them, the DM is delivered (it lands on their
    // side as a message request until they accept). Before, a DM only
    // arrived once the other person had added you and messaged you back.
    if (/^DM[0-9A-F]{10}$/.test(room)) {
      if (!this.rooms.has(room)) return false;
      if (!peer.fingerprint || room !== _dmCodeFor(this.crypto.getFingerprint(), peer.fingerprint)) return false;
      // the 64-bit fingerprint alone isn't enough — the DM is pinned
      // to the counterpart's full identity on first contact.
      return !this.pinCheck || this.pinCheck(room, peer.fingerprint, peer.identityId) !== false;
    }
    return !!(peer.rooms && peer.rooms.has(room));
  }

  // ─── Mobile lifecycle ─────────────────────────────────────
  // When the OS backgrounds the app, the DHT's UDP sockets and announce
  // timers stall. Without telling Hyperswarm, discovery never recovered:
  // someone who created a room, went to share the invite and came back was
  // invisible to people joining. suspend/resume hand that to Hyperswarm;
  // refresh re-announces every room topic right away.
  async suspend() {
    try { if (this.swarm && this.swarm.suspend) await this.swarm.suspend(); } catch (e) {}
  }
  async resume() {
    try { if (this.swarm && this.swarm.resume) await this.swarm.resume(); } catch (e) {}
    await this.refresh();
  }
  async refresh() {
    for (const [, r] of this.rooms) {
      for (const d of (r.discs || [])) {
        try { if (d.disc && d.disc.refresh) d.disc.refresh({ client: true, server: true }); } catch (e) {}
      }
    }
    try { if (this._ownInbox && this._ownInbox.refresh) this._ownInbox.refresh({ server: true, client: false }); } catch (e) {}
    this.emit('refreshed', { rooms: this.rooms.size, peers: this.peers.size });
  }

  // ─── Personal inbox ─────────────────────────────────────────
  // Every identity listens on a DHT topic derived from its fingerprint, so
  // someone who wants to DM you can find you even when you share no room.
  // Opening a DM joins the counterpart's inbox as a client. The connection
  // that forms is an ordinary authenticated Sirr connection; the DM
  // itself still only goes to the exact counterpart (see _peerSharesRoom).
  _inboxTopic(fp) {
    return crypto.createHash('sha256').update('sirr/inbox/1|' + String(fp || '').replace(/\s+/g, '').toUpperCase()).digest();
  }
  /** Turn the personal inbox on or off at runtime (Settings → Privacy). */
  setInboxEnabled(on) {
    this._inboxEnabled = !!on;
    if (!this.swarm) return;
    if (on) this._joinOwnInbox();
    else if (this._ownInbox) {
      const d = this._ownInbox; this._ownInbox = null;
      Promise.resolve().then(() => d.destroy()).catch(() => {});
    }
  }
  _joinOwnInbox() {
    try {
      const fp = this.crypto.getFingerprint();
      if (!fp || this._ownInbox) return;
      this._ownInbox = this.swarm.join(this._inboxTopic(fp), { server: true, client: false });
    } catch (e) {}
  }
  reachInbox(fp) {
    if (!fp) return false;
    if (!this._inboxes) this._inboxes = new Map();
    const key = String(fp).replace(/\s+/g, '').toUpperCase();
    if (this._inboxes.has(key)) return true;
    try {
      this._inboxes.set(key, this.swarm.join(this._inboxTopic(fp), { server: false, client: true }));
      return true;
    } catch (e) { return false; }
  }

  _broadcastToRoom(room, o, opts) {
    if (!room) return 0;
    const requireSession = !!(opts && opts.requireSession);
    let sent = 0;
    for (const [pid, peer] of this.peers) {
      if (!this._peerSharesRoom(peer, room)) continue;
      if (requireSession && !this.crypto.hasSession(pid)) continue;
      try {
        this._send(peer.socket, o);
        sent++;
      } catch (e) {}
    }
    return sent;
  }

  _encBroadcastToRoom(type, payload) {
    const room = payload && payload.room;
    if (!room) return 0;
    const json = JSON.stringify(payload);
    let sent = 0;
    for (const [pid, peer] of this.peers) {
      if (!this._peerSharesRoom(peer, room)) continue;
      if (!this.crypto.hasSession(pid)) continue;
      try {
        this._send(peer.socket, { type, data: this.crypto.encrypt(json, pid) });
        sent++;
      } catch (e) {}
    }
    return sent;
  }

  // Encrypted chat message. Only peers we currently know share `room` get a
  // copy on the wire; receivers still enforce membership after decrypt as a
  // second line of defense.
  sendMessage(room, content, msgType, extra) {
    const ts = Date.now();
    const msgId = ts.toString(36) + Math.random().toString(36).slice(2, 6);
    const obj = {
      room,
      channel: (extra && extra.channel) || 'default',
      content, timestamp: ts, type: msgType || 'text', msgId,
      replyTo: extra?.replyTo || null,
      fileName: extra?.fileName || '',
      fileSize: extra?.fileSize || 0,
      expiresAt: (extra && extra.expiresAt) || 0,
    };
    // Room-key signature so the message stays verifiable when someone else
    // relays it later (offline sync). See lib/msgsig.js.
    let sig = '';
    try { sig = this.crypto.signForRoom(room, msgsig.canonicalMessage(room, obj)); obj.sig = sig; } catch (e) {}
    const payload = JSON.stringify(obj);
    let peerCount = 0;
    for (const [pid, peer] of this.peers) {
      if (this._peerSharesRoom(peer, room) && this.crypto.hasSession(pid)) peerCount++;
    }
    this._later(() => {
      for (const [pid, peer] of this.peers) {
        if (!this._peerSharesRoom(peer, room)) continue;
        if (!this.crypto.hasSession(pid)) continue;
        try { this._send(peer.socket, { type: MSG.CHAT, data: this.crypto.encrypt(payload, pid) }); } catch (e) {}
      }
    });
    return { sent: true, timestamp: ts, msgId, peerCount, sig };
  }

  sendFileStart(data)   { this._encBroadcastToRoom(MSG.FILE_START, data); }
  // Resolves once every recipient socket has drained below its high-water
  // mark (or 15 s passes). Without this, a 200 MB upload was written into
  // the sockets in one go: hundreds of MB in RAM, and voice signaling /
  // keepalives stuck behind it for minutes on a slow uplink.
  async sendFileChunkRaw(data) {
    const room = data && data.room;
    if (!room) return 0;
    const json = JSON.stringify(data);
    const waits = [];
    let sent = 0;
    for (const [pid, peer] of this.peers) {
      if (!this._peerSharesRoom(peer, room)) continue;
      if (!this.crypto.hasSession(pid)) continue;
      try {
        const ok = peer.socket.write(JSON.stringify({ type: MSG.FILE_CHUNK, data: this.crypto.encrypt(json, pid) }) + '\n');
        sent++;
        if (ok === false) waits.push(this._drain(peer.socket, 15000));
      } catch (e) {}
    }
    if (waits.length) await Promise.all(waits);
    return sent;
  }

  _drain(socket, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(t);
        try { socket.removeListener('drain', finish); socket.removeListener('close', finish); } catch (e) {}
        resolve();
      };
      const t = setTimeout(finish, timeoutMs);
      try { socket.once('drain', finish); socket.once('close', finish); } catch (e) { finish(); }
    });
  }

  _queuedBytes(socket) {
    try {
      if (typeof socket.writableLength === 'number') return socket.writableLength;
      const ws = socket._writableState;
      if (ws && typeof ws.buffered === 'number') return ws.buffered;
      if (ws && typeof ws.length === 'number') return ws.length;
    } catch (e) {}
    return 0;
  }

  // ─── BOLT ──────────────────────────────────────────────────
  identityIdOf(pid) { return this.peers.get(pid)?.identityId || ''; }
  peerHasCap(pid, cap) { const p = this.peers.get(pid); return !!(p && p.caps && p.caps.has(cap)); }
  peerInfo(pid) {
    const p = this.peers.get(pid);
    return p ? { peerId: pid, fingerprint: p.fingerprint, nickname: p.nickname, rooms: [...p.rooms], caps: p.caps ? [...p.caps] : [] } : null;
  }
  peersInRoom(room) {
    const out = [];
    for (const [pid, p] of this.peers) {
      if (this._peerSharesRoom(p, room) && this.crypto.hasSession(pid)) out.push(pid);
    }
    return out;
  }
  sessionMac(pid, label) { return this.crypto.sessionMac(pid, label); }

  /** Encrypted BOLT control message to one peer. */
  sendRoomMove(pid, move) {
    const peer = this.peers.get(pid);
    if (!peer || !this.crypto.hasSession(pid) || !peer.rooms.has(move.from)) return false;
    try { this._send(peer.socket, { type: MSG.ROOM_MOVE, data: this.crypto.encrypt(JSON.stringify(move), pid) }); return true; } catch (e) { return false; }
  }
  sendBoltCtl(pid, obj) {
    const peer = this.peers.get(pid);
    if (!peer || !this.crypto.hasSession(pid)) return false;
    this._send(peer.socket, { type: MSG.BOLT_CTL, data: this.crypto.encrypt(JSON.stringify(obj), pid) });
    return true;
  }

  /**
   * Raw BOLT frame to one peer. Resolves once the socket can take more
   * (drain), so a sender awaiting this is naturally paced by the link.
   * Resolves false if the peer is gone.
   */
  async sendBoltFrame(pid, frame) {
    const peer = this.peers.get(pid);
    if (!peer) return false;
    let ok;
    try { ok = peer.socket.write(frame); } catch (e) { return false; }
    if (ok === false) await this._drain(peer.socket, 30000);
    return !!this.peers.get(pid);
  }

  /** Legacy (pre-BOLT) file message to ONE peer, drain-aware. */
  async sendLegacyFileTo(pid, type, payload) {
    const peer = this.peers.get(pid);
    if (!peer || !this.crypto.hasSession(pid)) return false;
    let ok;
    try {
      ok = peer.socket.write(JSON.stringify({ type, data: this.crypto.encrypt(JSON.stringify(payload), pid) }) + '\n');
    } catch (e) { return false; }
    if (ok === false) await this._drain(peer.socket, 30000);
    return !!this.peers.get(pid);
  }

  /** Stop / restart reading a peer's socket (receiver-side disk backpressure). */
  pausePeer(pid)  { try { this.peers.get(pid)?.socket.pause(); } catch (e) {} }
  resumePeer(pid) { try { this.peers.get(pid)?.socket.resume(); } catch (e) {} }

  /** Mesh audio packet to one peer over the swarm connection. */
  sendVoiceMedia(pid, bytes, room) {
    const peer = this.peers.get(pid);
    if (!peer || !peer.keyExchanged || !this._peerSharesRoom(peer, room)) return false;
    if (!bytes || !bytes.length || bytes.length > VOICE_MEDIA_MAX_BYTES) return false;
    if (this._queuedBytes(peer.socket) > VOICE_MEDIA_MAX_QUEUED) return false;
    this._send(peer.socket, { type: MSG.VOICE_MEDIA, room, d: b4a.toString(b4a.from(bytes), 'base64') });
    return true;
  }
  sendFileEnd(data)     { this._encBroadcastToRoom(MSG.FILE_END,   data); }

  // Typing indicator — room-scoped on the wire.
  sendTyping(room, channel) {
    this._broadcastToRoom(room, { type: MSG.TYPING, room, channel: channel || 'default' });
  }

  // Nickname / avatar / status changed — tell everyone
  reannounce() {
    // Per peer: membership as that connection's tags (never raw codes);
    // the profile itself only inside the session.
    for (const [pid, peer] of this.peers) {
      this._send(peer.socket, { type: MSG.ANNOUNCE, caps: [bolt.CAP], ...this._roomsPayloadFor(peer) });
      this._sendProfile(pid);
    }
  }
  _sendProfile(pid) {
    const peer = this.peers.get(pid);
    if (!peer || !this.crypto.hasSession(pid)) return;
    const p = { nickname: this.nickname, avatarEmoji: this.avatarEmoji, avatarPixels: this.avatarPixels, status: this.status, statusText: this.statusText };
    try { this._send(peer.socket, { type: MSG.PROFILE, data: this.crypto.encrypt(JSON.stringify(p), pid) }); } catch (e) {}
  }
  _emitJoined(pid) {
    const peer = this.peers.get(pid);
    if (!peer || peer._joined) return;
    clearTimeout(peer._joinTimer);
    peer._joined = true;
    this.emit('peer-joined', this._peerPayload(pid, peer));
  }

  broadcastRoomRename(room, newName) {
    this._broadcastToRoom(room, { type: MSG.ROOM_RENAME, room, newName });
  }

  // Unicast a room rename to a single peer — used to sync the current name
  // to peers who joined after we renamed. `silent` skips the "Room renamed"
  // toast on the receiver since no actual rename event occurred.
  sendRoomRenameTo(pid, room, newName, silent) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return;
    this._send(peer.socket, { type: MSG.ROOM_RENAME, room, newName, silent: !!silent });
  }

  // Voice signalling is also room-scoped; targeted sends still require the
  // destination peer to share the room locally.
  sendVoiceSignal(pid, st, data, room, channel) {
    const env = { type: st, data, room: room || '', channel: channel || '' };
    if (pid) {
      const peer = this.peers.get(pid);
      if (!peer || !this._peerSharesRoom(peer, room)) return;
      this._send(peer.socket, env);
    } else {
      this._broadcastToRoom(room, env);
    }
  }

  broadcastVoiceSignal(st, data, room, channel) {
    this._broadcastToRoom(room, { type: st, data, room: room || '', channel: channel || '' });
  }

  // ─── Channel admin broadcasts ────────────────────────────────────
  broadcastChannelCreate(room, channel, silent) {
    this._broadcastToRoom(room, { type: MSG.CHANNEL_CREATE, room, channel, silent: !!silent });
  }
  broadcastChannelRename(room, channelId, newName, silent) {
    this._broadcastToRoom(room, { type: MSG.CHANNEL_RENAME, room, channelId, newName, silent: !!silent });
  }
  broadcastChannelDelete(room, channelId) {
    this._broadcastToRoom(room, { type: MSG.CHANNEL_DELETE, room, channelId });
  }
  // Unicast full channel list to a newly-joined peer so they don't stall
  // on the bare "default" until someone renames/creates something.
  sendChannelsSyncTo(pid, room, channels) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return;
    this._send(peer.socket, { type: MSG.CHANNELS_SYNC, room, channels });
  }

  // ─── Contacts + offline sync ─────────────────────────────────────
  sendContactAddTo(pid) {
    const peer = this.peers.get(pid);
    if (!peer) return false;
    this._send(peer.socket, { type: MSG.CONTACT_ADD });
    return true;
  }
  // Look up a currently-connected peer by their fingerprint (8-char hex).
  // Returns the peerId or null.
  findPeerByFingerprint(fp) {
    if (!fp) return null;
    for (const [pid, peer] of this.peers) {
      if (peer.fingerprint === fp) return pid;
    }
    return null;
  }
  // Sync summary: "here are the last N msgIds I have for room X". Sent on
  // peer-joined so the other side can pull anything they missed offline.
  sendSyncSummaryTo(pid, room, ids) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return false;
    this._send(peer.socket, { type: MSG.SYNC_SUMMARY, room, ids });
    return true;
  }
  sendSyncRequestTo(pid, room, msgIds) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return false;
    this._send(peer.socket, { type: MSG.SYNC_REQUEST, room, msgIds });
    return true;
  }
  // Pin / unpin broadcast. Room-scoped on the wire; the msgId alone does not
  // leak content since bodies are only ever seen via CHAT/SYNC_MESSAGES. The
  // `preview` field is a short snippet so the pins panel has something to
  // show on recipients who never saw the original message.
  broadcastPinToggle(room, channel, msgId, pinned, extra) {
    this._broadcastToRoom(room, {
      type: MSG.PIN_TOGGLE,
      room, channel, msgId,
      pinned: !!pinned,
      preview: (extra && extra.preview) || '',
      nick: (extra && extra.nick) || this.nickname,
      ts: (extra && extra.ts) || Date.now(),
    });
  }
  // Unicast full pin list for a given room+channel — sent on peer-joined so
  // freshly-connected peers see our pins without waiting for a toggle.
  sendPinsSyncTo(pid, room, channel, pins) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return false;
    this._send(peer.socket, { type: MSG.PINS_SYNC, room, channel, pins });
    return true;
  }
  // ─── Room ownership + admin protocol ─────────────────────────────
  // Unicast the charter to a newly-joined peer so they learn who owns a
  // shared room. Plain (not encrypted) — the owner fingerprint and creation
  // timestamp aren't secrets and a listener on the wire can already see the
  // room topic hashes anyway.
  sendRoomCharterTo(pid, room, ownerFingerprint, createdAt) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return false;
    this._send(peer.socket, {
      type: MSG.ROOM_CHARTER, room,
      ownerFingerprint: String(ownerFingerprint || ''),
      createdAt: Number(createdAt) || 0,
    });
    return true;
  }
  // Unicast the full admin table. Only meaningful when WE are the room's
  // owner — recipients reject ADMIN_SYNC whose sender isn't the claimed
  // owner, so no-op on a non-owner's attempt.
  sendAdminSyncTo(pid, room, admins) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return false;
    this._send(peer.socket, { type: MSG.ADMIN_SYNC, room, admins: admins || {} });
    return true;
  }
  // Broadcast a single admin grant/revoke to every connected peer so every
  // member's view of the admin table stays consistent. `perms` is null for
  // a revoke.
  broadcastAdminUpdate(room, target, perms) {
    this._broadcastToRoom(room, {
      type: MSG.ADMIN_UPDATE, room,
      target: String(target || ''),
      perms: perms || null,
    });
  }

  // Edit-message broadcast. Encrypted so the new content body never crosses
  // the wire in clear. Receiver pulls room+channel+msgId from the payload
  // and validates author identity at the storage layer.
  broadcastMsgEdit(room, channel, msgId, content, editedAt) {
    const at = Number(editedAt) || Date.now();
    let editSig = '';
    try { editSig = this.crypto.signForRoom(room, msgsig.canonicalEdit(room, channel, msgId, String(content || ''), at)); } catch (e) {}
    this.lastEditSig = editSig;
    return this._encBroadcastToRoom(MSG.MSG_EDIT, {
      room, channel: channel || 'default', msgId,
      content: String(content || ''), editedAt: at, editSig,
    });
  }
  // Authoritative-delete broadcast. Plaintext (room/channel/msgId carry no
  // secret bodies) — receiver verifies sender is owner or original author.
  broadcastMsgDeleteForAll(room, channel, msgId) {
    return this._broadcastToRoom(room, {
      type: MSG.MSG_DELETE_FOR_ALL,
      room, channel: channel || 'default', msgId,
    });
  }

  // Reply to a SYNC_REQUEST with the full message bodies. Encrypted so file
  // payloads and image data URIs don't leak in clear.
  sendSyncMessagesTo(pid, room, messages) {
    const peer = this.peers.get(pid);
    if (!peer || !this._peerSharesRoom(peer, room)) return false;
    if (!this.crypto.hasSession(pid)) return false;
    try {
      const data = this.crypto.encrypt(JSON.stringify({ room, messages }), pid);
      this._send(peer.socket, { type: MSG.SYNC_MESSAGES, data });
      return true;
    } catch (e) { return false; }
  }

  // ───────────────────────────────────────────────────────────────────
  // Low-level
  // ───────────────────────────────────────────────────────────────────

  _send(s, o) {
    try { s.write(JSON.stringify(o) + '\n'); } catch (e) {}
  }

  _broadcast(o) {
    for (const [, peer] of this.peers) this._send(peer.socket, o);
  }

  getPeers() {
    const l = [];
    for (const [pid, peer] of this.peers) {
      l.push(this._peerPayload(pid, peer));
    }
    return l;
  }

  getStats() {
    // Roll RTT across all peers we have a reading for. `bestRtt` drives the
    // top-of-bar quality chip; `avgRtt` smooths spikes when one peer is
    // unusually slow. `null` when we haven't pinged anyone yet → renderer
    // shows SEARCHING instead of a bogus 0ms.
    let n = 0, total = 0, best = Infinity, worst = 0;
    for (const peer of this.peers.values()) {
      if (typeof peer.rtt === 'number') {
        n++;
        total += peer.rtt;
        if (peer.rtt < best)  best  = peer.rtt;
        if (peer.rtt > worst) worst = peer.rtt;
      }
    }
    return {
      peers: this.peers.size,
      rooms: this.rooms.size,
      sessions: this.crypto.getActiveSessionCount(),
      rtt: {
        samples: n,
        best:  n ? best  : null,
        worst: n ? worst : null,
        avg:   n ? Math.round(total / n) : null,
      },
    };
  }

  async destroy() {
    this._stopKeepalive();
    this.setCoverTraffic(false);
    try { if (this.pathways) await this.pathways.destroy(); } catch (e) {}
    try { if (this._rvTimer) clearInterval(this._rvTimer); } catch (e) {}
    this._broadcast({ type: MSG.LEAVE, nickname: this.nickname });
    if (this.swarm) await this.swarm.destroy();
  }
}

module.exports = SirrNetwork;
module.exports.MSG = MSG;
