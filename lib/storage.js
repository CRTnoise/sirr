const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// Message store is injectable: desktop uses SQLite, Sirr Mobile
// (Bare runtime, no native Node addons) passes the pure-JS lite store.
const Vault = require('./vault');
const RoomCode = require('./roomcode');

// Channel IDs encode their kind in the prefix. The baked-in default for
// every room is a text channel named "default" (renamable, not deletable).
// Additional channels get random suffixes so two peers can each create a
// channel at the same time without colliding.
const DEFAULT_CHANNEL = { id: 'default', kind: 'text', name: 'default' };

// The permissions an owner can grant to another room member. The owner
// implicitly holds all of these (and a couple of extras — grant/revoke
// admin, transfer ownership — that are never delegable). Everything else
// (chatting, pinning own messages, adding reactions) stays open to all
// members regardless of admin status.
const ROOM_PERMS = ['createChannel', 'renameChannel', 'deleteChannel', 'renameRoom'];
function _normalizePerms(p) {
  const out = {};
  for (const k of ROOM_PERMS) out[k] = !!(p && p[k]);
  return out;
}
function makeChannelId(kind) {
  const prefix = kind === 'voice' ? 'v_' : 't_';
  return prefix + Math.random().toString(36).slice(2, 10);
}

// Default config shape — factored out so both first-run and recover-from-
// corrupt-file paths use the same template.
function _defaultConfig() {
  return {
    nickname: 'anon_' + Math.random().toString(36).slice(2, 6),
    accentColor: '#4ff0a0', fontScale: 1, density: 'default',
    bubble: 'flat', chatBg: 'none', timeFormat: '12',
    notifSound: 'on', avatarEmoji: '', avatarImage: '', avatarPixels: '',
    statusText: '', autoDownload: 'off',
    desktopNotifs: 'all',
    mentionToasts: 'on',
    sendTyping: 'on',
    vcAutoMute: 'off',
    noiseGate: 'off',
    reduceMotion: 'off',
    highContrast: 'off',
    largeTargets: 'off',
    linkPreview: 'off',
    inbox: 'off',
    rooms: [], contacts: {}, blocklist: {},
    createdAt: new Date().toISOString(),
  };
}

// Debounce window for config writes. We coalesce bursts of updates (peer-
// joined / roster touches / pin toggles) into a single disk write.
const CONFIG_FLUSH_MS = 250;

class SirrStorage {
  /**
   * @param {string} [dir]
   * @param {{vault?: import('./vault')}} [opts]  vault → config, history and
   *        spilled files are encrypted at rest
   */
  constructor(dir, opts = {}) {
    this.baseDir = dir || SirrStorage.defaultDir();
    this.vault = opts.vault || null;
    this.configPath = path.join(this.baseDir, 'config.json');
    this.historyDir = path.join(this.baseDir, 'history');
    this.filesDir = path.join(this.baseDir, 'files');
    [this.baseDir, this.historyDir, this.filesDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    this._cfg = null;
    this._flushTimer = null;
    this._loadConfig();
    // SQLite-backed message store — replaces per-channel .ndjson files.
    // Constructor opens (or creates) the DB; the one-shot migration below
    // imports any pre-existing ndjson on first launch and renames the source
    // files to .migrated so we don't re-import on subsequent runs.
    const MessageStore = opts.MessageStore || require('./message-store');
    this.messages = new MessageStore(path.join(this.baseDir, 'messages.db'), this.vault, {
      // Migration hook: move a spilled file from its old (room-code-bearing)
      // name to the keyed-hash name.
      remapRef: (oldRef, room, ch, msgId) => {
        const nu = this._mkFid(room, ch, msgId);
        if (nu !== oldRef) { try { fs.renameSync(path.join(this.filesDir, oldRef), path.join(this.filesDir, nu)); } catch (e) {} }
        return nu;
      },
    });
    try { this.messages.migrateNdjson(this.historyDir); } catch (e) {}
  }

  // ─── Config: in-memory cache + debounced flush ─────────────────────
  // The config is read once on construction and kept in `_cfg`. Mutators
  // update the cache and schedule a write; bursts of updates coalesce into
  // a single fs.writeFileSync via CONFIG_FLUSH_MS. Call `flushSync()` from
  // the app's before-quit hook to guarantee the final write happens.
  _readCfgFile(p) {
    const raw = fs.readFileSync(p, 'utf8');
    if (this.vault && this.vault.isSealed(raw)) return JSON.parse(this.vault.open(raw));
    const cfg = JSON.parse(raw);
    // Plaintext config from an older version: re-write sealed right away
    // and shred the plaintext backup.
    if (this.vault) this._needsReseal = true;
    return cfg;
  }

  _loadConfig() {
    if (!fs.existsSync(this.configPath)) {
      this._cfg = _defaultConfig();
      this._flushNow();
      return;
    }
    try {
      this._cfg = this._readCfgFile(this.configPath);
    } catch (e) {
      // Primary file corrupt (e.g. crash mid-write on old versions) — try
      // the last-known-good backup before falling back to factory defaults,
      // so the user doesn't silently lose every room and contact.
      try {
        this._cfg = this._readCfgFile(this.configPath + '.bak');
        this._flushNow();
      } catch (e2) {
        this._cfg = _defaultConfig();
        this._flushNow();
        return;
      }
    }
    let dirty = false;
    for (const r of (this._cfg.rooms || [])) {
      if (!Array.isArray(r.channels) || !r.channels.length) {
        r.channels = [{ ...DEFAULT_CHANNEL }];
        dirty = true;
      }
      for (const ch of r.channels) {
        if (!ch.deletedMsgIds || typeof ch.deletedMsgIds !== 'object') {
          ch.deletedMsgIds = {};
          dirty = true;
        }
      }
    }
    if (!this._cfg.contacts || typeof this._cfg.contacts !== 'object') { this._cfg.contacts = {}; dirty = true; }
    if (!this._cfg.blocklist || typeof this._cfg.blocklist !== 'object') { this._cfg.blocklist = {}; dirty = true; }
    if (dirty) this._scheduleFlush();
  }
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flushNow(); }, CONFIG_FLUSH_MS);
  }
  _flushNow() {
    // Atomic write: serialize to a temp file then rename over the target.
    // A crash mid-write can no longer corrupt config.json. The previous
    // good file is preserved as .bak for the recovery path in _loadConfig.
    try {
      // sealed with the vault — config.json holds every room code
      // (the join secrets) and contacts.
      const json = JSON.stringify(this._cfg, null, 2);
      const data = this.vault ? this.vault.seal(json) : json;
      const tmp = this.configPath + '.tmp';
      fs.writeFileSync(tmp, data);
      try {
        if (fs.existsSync(this.configPath)) fs.copyFileSync(this.configPath, this.configPath + '.bak');
      } catch (e) {}
      fs.renameSync(tmp, this.configPath);
    } catch (e) {}
  }
  // Forced synchronous flush — call on clean shutdown so pending mutations
  // aren't lost if the debounce timer hasn't fired yet.
  flushSync() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._flushNow();
  }
  getConfig() { return this._cfg; }
  saveConfig(c) { this._cfg = c; this._scheduleFlush(); }
  updateConfig(p) { const u = { ...this._cfg, ...p }; this.saveConfig(u); return u; }
  // `opts.asOwner` (with `opts.myFingerprint`) records the caller as the
  // room's owner. Used by the "create room" flow. Joining an existing room
  // must NOT pass asOwner — ownership is discovered from peers via the
  // charter protocol.
  addRoom(code, name, opts) {
    const c = this.getConfig();
    if (!c.rooms) c.rooms = [];
    const existing = c.rooms.find(r => r.code === code);
    if (existing) {
      if (opts && opts.asOwner && opts.myFingerprint && !existing.ownerFingerprint) {
        existing.ownerFingerprint = opts.myFingerprint;
        existing.createdAt = existing.createdAt || Date.now();
        this.saveConfig(c);
      }
      return existing;
    }
    const rec = {
      code,
      name: name || code,
      joinedAt: Date.now(),
      channels: [{ ...DEFAULT_CHANNEL }],
    };
    if (opts && opts.asOwner && opts.myFingerprint) {
      rec.ownerFingerprint = opts.myFingerprint;
      rec.createdAt = Date.now();
    }
    c.rooms.push(rec);
    this.saveConfig(c);
    return rec;
  }
  renameRoom(code, name) { const c = this.getConfig(); const r = (c.rooms || []).find(r => r.code === code); if (r) { r.name = name; this.saveConfig(c); } }
  getRooms() { return this.getConfig().rooms || []; }
  // Reorder persistent room records to match the renderer's drag order.
  // Unknown codes get pushed to the end in existing order so dropping a
  // stale payload can't silently remove rooms.
  reorderRooms(codes) {
    if (!Array.isArray(codes)) return false;
    const c = this.getConfig();
    const idx = new Map();
    codes.forEach((code, i) => idx.set(code, i));
    (c.rooms || []).sort((a, b) => {
      const ai = idx.has(a.code) ? idx.get(a.code) : 9999;
      const bi = idx.has(b.code) ? idx.get(b.code) : 9999;
      return ai - bi;
    });
    this.saveConfig(c);
    return true;
  }

  // ─── Channels ──────────────────────────────────────────────────────
  getChannels(code) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    return r && Array.isArray(r.channels) ? r.channels : [{ ...DEFAULT_CHANNEL }];
  }
  addChannel(code, channel) {
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r) return null;
    if (!Array.isArray(r.channels)) r.channels = [{ ...DEFAULT_CHANNEL }];
    // Dedupe by id: if the channel was already added (e.g. two peers raced
    // the broadcast), keep the existing entry.
    // Channel records can come from peers (create / sync): bound them.
    if (!channel || typeof channel.id !== 'string' || !/^[\w-]{1,64}$/.test(channel.id)) return null;
    if (r.channels.find(ch => ch.id === channel.id)) return r.channels;
    if (r.channels.length >= 100) return null;
    r.channels.push({
      id: channel.id,
      kind: channel.kind === 'voice' ? 'voice' : 'text',
      name: String(channel.name || channel.id).slice(0, 64),
      createdAt: Number.isFinite(channel.createdAt) ? channel.createdAt : Date.now(),
    });
    this.saveConfig(c);
    return r.channels;
  }
  renameChannel(code, channelId, name) {
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r || !Array.isArray(r.channels)) return null;
    const ch = r.channels.find(ch => ch.id === channelId);
    if (!ch) return null;
    ch.name = String(name || ch.name).slice(0, 64);
    this.saveConfig(c);
    return r.channels;
  }
  removeChannel(code, channelId) {
    if (channelId === 'default') return null;  // default is not deletable
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r || !Array.isArray(r.channels)) return null;
    const before = r.channels.length;
    r.channels = r.channels.filter(ch => ch.id !== channelId);
    if (r.channels.length === before) return null;
    this.saveConfig(c);
    // Clean up that channel's history + any file blobs prefixed with it.
    try { this.messages.clearChannel(code, channelId); } catch (e) {}
    this._removeFilesForChannel(code, channelId);
    return r.channels;
  }

  // ─── Messages ──────────────────────────────────────────────────────
  // Persistence flows through `this.messages` (SQLite). The big content
  // spill-to-disk path for inline image data URIs stays here so the DB row
  // never grows unbounded; we just record the fid in `contentRef`.
  appendMessage(room, channel, msg) {
    if (!msg || msg.type === 'reaction') return;
    if (this.isRoomEphemeral(room)) return;
    const chId = channel || 'default';
    const toStore = { ...msg };
    if (msg.type === 'image' && msg.content && msg.content.startsWith('data:') && msg.content.length > 1000) {
      const fid = this._mkFid(room, chId, msg.msgId);
      try {
        fs.writeFileSync(path.join(this.filesDir, fid), this.vault ? this.vault.seal(msg.content) : msg.content, 'utf8');
        toStore.content = '';
        toStore.contentRef = fid;
      } catch (e) { toStore.content = ''; }
    }
    if (msg.type === 'file') {
      // Blob URLs die with the session. BOLT transfers keep the
      // received file on disk under its transfer id, so the message stays
      // saveable after a restart via `fileRef`.
      const ref = typeof msg.fileRef === 'string' && /^[0-9a-f]{16}$/.test(msg.fileRef) ? msg.fileRef : '';
      toStore.content = ref ? 'bolt:' + ref : '';
      toStore.fileRef = ref || undefined;
      toStore.blobUrl = false;
    }
    toStore.storedAt = Date.now();
    // Disappearing messages: if this message didn't already arrive with an
    // expiry (set by the sender and carried on the wire), stamp one from the
    // room's TTL so self-sent and locally-stored messages vanish in sync with
    // peers. expiresAt of 0 = never expires.
    if (!toStore.expiresAt) {
      const ttl = this.getRoomTTL(room);
      if (ttl > 0) toStore.expiresAt = (msg.timestamp || Date.now()) + ttl;
    }
    try { this.messages.appendMessage(room, chId, toStore); }
    catch (e) {}
  }

  // Per-room disappearing-message TTL, in milliseconds. 0 = off (default).
  // "No history on this device": messages of this room live in memory only.
  isRoomEphemeral(code) { const r = (this.getConfig().rooms || []).find(r => r.code === code); return !!(r && r.ephemeral); }
  setRoomEphemeral(code, on) {
    const cfg = this.getConfig();
    const r = (cfg.rooms || []).find(r => r.code === code);
    if (!r) return false;
    r.ephemeral = !!on;
    this.updateConfig({ rooms: cfg.rooms });
    if (on) { try { this.messages.clearRoom(code); } catch (e) {} this._removeFilesForRoom(code); }
    return true;
  }
  getRoomTTL(code) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    return r && Number.isFinite(r.messageTTL) ? Math.max(0, r.messageTTL) : 0;
  }
  setRoomTTL(code, ttlMs) {
    const cfg = this.getConfig();
    const r = (cfg.rooms || []).find(r => r.code === code);
    if (!r) return false;
    r.messageTTL = Math.max(0, Number(ttlMs) || 0);
    this.updateConfig({ rooms: cfg.rooms });
    return true;
  }
  sweepExpiredMessages(now) {
    try { return this.messages.sweepExpired(now); } catch (e) { return []; }
  }
  getHistory(room, channel, limit = 200) {
    const chId = channel || 'default';
    let rows = [];
    try { rows = this.messages.getHistory(room, chId, limit); }
    catch (e) { rows = []; }
    for (const m of rows) {
      if (m && m.contentRef) {
        const content = this._loadFile(m.contentRef);
        if (content) m.content = content;
      }
    }
    return rows;
  }
  _loadFile(fid) {
    const fp = path.join(this.filesDir, fid);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8');
    if (this.vault && this.vault.isSealed(raw)) { try { return this.vault.open(raw); } catch (e) { return null; } }
    return raw;
  }

  /** one-time upgrade of plaintext config / spilled files to sealed. */
  sealAtRest() {
    if (!this.vault) return { files: 0 };
    if (this._needsReseal) {
      this._flushNow();
      try { Vault.shred(this.configPath + '.bak'); } catch (e) {}
      this._flushNow();      // writes a sealed .bak on the next flush
      this._needsReseal = false;
    }
    let files = 0;
    try {
      for (const f of fs.readdirSync(this.filesDir)) {
        const fp = path.join(this.filesDir, f);
        const raw = fs.readFileSync(fp, 'utf8');
        if (this.vault.isSealed(raw)) continue;
        fs.writeFileSync(fp + '.tmp', this.vault.seal(raw), 'utf8');
        Vault.shred(fp);
        fs.renameSync(fp + '.tmp', fp);
        files++;
      }
    } catch (e) {}
    return { files };
  }
  clearHistory(room, channel) {
    const chId = channel || 'default';
    try { this.messages.clearChannel(room, chId); } catch (e) {}
    this._removeFilesForChannel(room, chId);
  }
  _mkFid(room, channel, msgId) {
    // with at-rest encryption the file name must not carry the room
    // code (the directory listing would leak every room's join secret).
    // Prefix = keyed hash of the room, so leaving a room can still find them.
    if (this.vault) return this._chanFilePrefix(room, channel) + this.vault.mac('file|' + room + '|' + (channel || 'default') + '|' + msgId).slice(0, 24);
    return this._safe(room) + '__' + this._safe(channel || 'default') + '__' + (msgId || Date.now().toString(36)) + '_img';
  }
  _chanFilePrefix(room, channel) {
    return this.vault
      ? this._roomFilePrefix(room) + this.vault.mac('chanfiles|' + room + '|' + (channel || 'default')).slice(0, 12) + '_'
      : this._safe(room) + '__' + this._safe(channel || 'default') + '__';
  }
  _roomFilePrefix(room) { return this.vault ? 'f_' + this.vault.mac('roomfiles|' + room).slice(0, 16) + '_' : this._safe(room) + '__'; }
  _removeFilesForRoom(room) {
    const prefix = this._roomFilePrefix(room);
    try {
      for (const name of fs.readdirSync(this.filesDir)) {
        if (name.startsWith(prefix)) {
          try { fs.unlinkSync(path.join(this.filesDir, name)); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  _removeFilesForChannel(room, channel) {
    const prefix = this._chanFilePrefix(room, channel);
    try {
      for (const name of fs.readdirSync(this.filesDir)) {
        if (name.startsWith(prefix)) {
          try { fs.unlinkSync(path.join(this.filesDir, name)); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  removeRoom(code) {
    const c = this.getConfig();
    c.rooms = (c.rooms || []).filter(r => r.code !== code);
    this.saveConfig(c);
    try { this.messages.clearRoom(code); } catch (e) {}
    this._removeFilesForRoom(code);
  }
  // ─── Contacts ──────────────────────────────────────────────────────
  // Contacts are keyed by fingerprint (8-char hex from network layer).
  // Each record: { fingerprint, nickname, avatarEmoji, addedAt, lastSeenAt }
  getContacts() {
    const cfg = this.getConfig();
    return cfg.contacts || {};
  }
  addContact(fingerprint, info) {
    if (!fingerprint) return null;
    const cfg = this.getConfig();
    if (!cfg.contacts) cfg.contacts = {};
    const existing = cfg.contacts[fingerprint] || {};
    cfg.contacts[fingerprint] = {
      fingerprint,
      nickname: (info && info.nickname) || existing.nickname || '',
      avatarEmoji: (info && info.avatarEmoji) || existing.avatarEmoji || '',
      addedAt: existing.addedAt || Date.now(),
      lastSeenAt: (info && info.lastSeenAt) || existing.lastSeenAt || Date.now(),
    };
    this.saveConfig(cfg);
    return cfg.contacts[fingerprint];
  }
  removeContact(fingerprint) {
    const cfg = this.getConfig();
    if (!cfg.contacts || !cfg.contacts[fingerprint]) return false;
    delete cfg.contacts[fingerprint];
    this.saveConfig(cfg);
    return true;
  }
  touchContact(fingerprint, info) {
    const cfg = this.getConfig();
    if (!cfg.contacts || !cfg.contacts[fingerprint]) return null;
    const c = cfg.contacts[fingerprint];
    if (info && info.nickname) c.nickname = info.nickname;
    if (info && info.avatarEmoji) c.avatarEmoji = info.avatarEmoji;
    if (info && info.avatarPixels !== undefined) c.avatarPixels = info.avatarPixels;
    c.lastSeenAt = Date.now();
    this.saveConfig(cfg);
    return c;
  }

  // ─── Direct Messages ───────────────────────────────────────────────
  // DMs are a hidden room whose code is deterministic from the sorted
  // fingerprint pair. Both peers independently compute the same code and
  // join the same Hyperswarm topic.
  dmRoomCode(fpA, fpB) {
    if (!fpA || !fpB) return null;
    const [a, b] = [String(fpA), String(fpB)].sort();
    const h = crypto.createHash('sha256').update(a + '|' + b).digest('hex');
    return 'DM' + h.slice(0, 10).toUpperCase();
  }
  /** Remember a DM counterpart's identity key (for its pairwise rendezvous). */
  setDmPeerKey(code, publicKey) {
    const c = this.getConfig();
    const r = (c.rooms || []).find(x => x.code === code && x.isDm);
    if (!r || typeof publicKey !== 'string') return false;
    if (!r.dmPeer || typeof r.dmPeer !== 'object') r.dmPeer = { fingerprint: '', nickname: '' };
    if (r.dmPeer.publicKey === publicKey) return false;
    r.dmPeer.publicKey = publicKey;
    this.saveConfig(c);
    return true;
  }
  addDmRoom(code, peerFingerprint, peerNickname) {
    const c = this.getConfig();
    if (!c.rooms) c.rooms = [];
    const existing = c.rooms.find(r => r.code === code);
    if (existing) {
      if (!existing.isDm) existing.isDm = true;
      if (!existing.dmPeer) existing.dmPeer = { fingerprint: peerFingerprint, nickname: peerNickname || '' };
      this.saveConfig(c);
      return existing;
    }
    const r = {
      code,
      name: peerNickname || ('DM · ' + (peerFingerprint || '').slice(0, 6)),
      joinedAt: Date.now(),
      channels: [{ ...DEFAULT_CHANNEL }],
      isDm: true,
      dmPeer: { fingerprint: peerFingerprint, nickname: peerNickname || '' },
    };
    c.rooms.push(r);
    this.saveConfig(c);
    return r;
  }
  getDmRooms() {
    return (this.getConfig().rooms || []).filter(r => r.isDm);
  }
  /** Mark a room as moved (rekey / eviction); `move` is the signed move. */
  setRoomMoved(code, move) {
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r) return false;
    r.moved = move; r.movedAt = Date.now();
    this.saveConfig(c);
    return true;
  }
  /** Ownership, identity pins, room keys, admins and channels carry over to a moved room. */
  copyRoomTrust(from, to) {
    const c = this.getConfig();
    const a = (c.rooms || []).find(r => r.code === from), b = (c.rooms || []).find(r => r.code === to);
    if (!a || !b) return false;
    for (const k of ['ownerFingerprint', 'createdAt']) if (a[k] && !b[k]) b[k] = a[k];
    for (const k of ['ids', 'signKeys', 'admins']) if (a[k] && typeof a[k] === 'object') b[k] = { ...(a[k]), ...(b[k] || {}) };
    if (Array.isArray(a.channels) && a.channels.length) b.channels = a.channels.map(ch => ({ ...ch }));
    if (a.ephemeral) b.ephemeral = a.ephemeral;
    if (a.messageTTL) b.messageTTL = a.messageTTL;
    this.saveConfig(c);
    return true;
  }
  getRoomRecord(code) {
    return (this.getConfig().rooms || []).find(r => r.code === code) || null;
  }

  // ─── Roster (per-room "peers ever seen") ───────────────────────────
  // Keyed by fingerprint. Each entry: { fingerprint, nickname, avatarEmoji, firstSeenAt, lastSeenAt }.
  // Populated on peer-joined and on incoming CHAT. Survives restarts so the
  // right-side ledger can show "who has access" separately from "who's live".
  getRoster(code) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    return (r && r.roster && typeof r.roster === 'object') ? r.roster : {};
  }
  getAllRosters() {
    const out = {};
    for (const r of (this.getConfig().rooms || [])) {
      if (r && r.code) out[r.code] = (r.roster && typeof r.roster === 'object') ? r.roster : {};
    }
    return out;
  }
  touchRoster(code, fingerprint, info) {
    if (!code || !fingerprint) return null;
    const cfg = this.getConfig();
    const r = (cfg.rooms || []).find(r => r.code === code);
    if (!r) return null;
    if (!r.roster || typeof r.roster !== 'object') r.roster = {};
    const existing = r.roster[fingerprint] || {};
    const nickname   = (info && info.nickname)    || existing.nickname    || '';
    const avatarEmoji= (info && info.avatarEmoji) || existing.avatarEmoji || '';
    const avatarPixels = (info && info.avatarPixels !== undefined) ? info.avatarPixels : (existing.avatarPixels || '');
    r.roster[fingerprint] = {
      fingerprint,
      nickname,
      avatarEmoji,
      avatarPixels,
      firstSeenAt: existing.firstSeenAt || Date.now(),
      lastSeenAt: Date.now(),
    };
    this.saveConfig(cfg);
    return r.roster[fingerprint];
  }
  removeFromRoster(code, fingerprint) {
    const cfg = this.getConfig();
    const r = (cfg.rooms || []).find(r => r.code === code);
    if (!r || !r.roster || !r.roster[fingerprint]) return false;
    delete r.roster[fingerprint];
    this.saveConfig(cfg);
    return true;
  }

  // ─── Room ownership + per-room admins ──────────────────────────────
  // Each room has at most one owner (fingerprint of the creator). The owner
  // holds all permissions implicitly and can grant a subset of ROOM_PERMS to
  // other fingerprints via `setAdmin`. Trust model: peers converge on the
  // owner via the ROOM_CHARTER network message (earliest-createdAt wins on
  // tiebreak), and only the owner's ADMIN_UPDATE messages are honored on the
  // receiving side. DM rooms (isDm) are exempt — both parties are peers.
  getRoomOwner(code) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    if (!r || r.isDm) return null;
    return { fingerprint: r.ownerFingerprint || '', createdAt: r.createdAt || 0 };
  }
  isRoomOwner(code, fingerprint) {
    if (!fingerprint) return false;
    const o = this.getRoomOwner(code);
    return !!(o && o.fingerprint && o.fingerprint === fingerprint);
  }
  // Adopt an owner from a peer's ROOM_CHARTER. Accepts only when we have no
  // owner locally, or when the incoming charter was created strictly earlier.
  // Never displaces ourselves (we trust our own local record over gossip).
  acceptRoomCharter(code, ownerFingerprint, createdAt, myFingerprint, ownerId) {
    if (!code || !ownerFingerprint || !createdAt) return false;
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r || r.isDm) return false;
    // The code itself says who owns the room (lib/roomcode.js).
    const committed = RoomCode.ownerMatches(code, ownerId);
    if (committed === false) return 'conflict';
    if (committed === true) {
      if (r.ownerFingerprint === ownerFingerprint && r.createdAt) return false;
      r.ownerFingerprint = ownerFingerprint;
      r.createdAt = createdAt;
      if (!r.ids || typeof r.ids !== 'object') r.ids = {};
      r.ids[ownerFingerprint] = ownerId;          // authoritative — overrides any earlier pin
      this.saveConfig(c);
      return true;
    }
    if (!this._idOk(r, ownerFingerprint, ownerId)) return 'conflict';
    if (r.ownerFingerprint === myFingerprint && r.createdAt) return false; // we're owner — keep
    if (!r.ownerFingerprint) {
      r.ownerFingerprint = ownerFingerprint;
      r.createdAt = createdAt;
      this.saveConfig(c);
      return true;
    }
    // trust-on-first-use. Letting an EARLIER createdAt replace the
    // recorded owner — but createdAt is whatever the claimant says, so any
    // member could send "I own this room, created at t=1" and take over
    // moderation in everyone else's view. A known owner is now never
    // replaced from the network; the caller surfaces the conflict instead.
    if (r.ownerFingerprint !== ownerFingerprint) return 'conflict';
    return false;
  }
  getAdmins(code) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    return (r && r.admins && typeof r.admins === 'object') ? r.admins : {};
  }
  // Set (or revoke, when perms is empty/falsy) admin perms for a fingerprint.
  // Owner membership is enforced by the caller — this method just writes.
  setAdmin(code, fingerprint, perms, grantedBy) {
    if (!code || !fingerprint) return null;
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r) return null;
    if (!r.admins || typeof r.admins !== 'object') r.admins = {};
    const normalized = _normalizePerms(perms);
    const hasAny = ROOM_PERMS.some(k => normalized[k]);
    if (!hasAny) {
      if (r.admins[fingerprint]) {
        delete r.admins[fingerprint];
        this.saveConfig(c);
      }
      return null;
    }
    r.admins[fingerprint] = {
      ...normalized,
      grantedAt: (r.admins[fingerprint] && r.admins[fingerprint].grantedAt) || Date.now(),
      grantedBy: grantedBy || '',
    };
    this.saveConfig(c);
    return r.admins[fingerprint];
  }
  removeAdmin(code, fingerprint) {
    if (!code || !fingerprint) return false;
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r || !r.admins || !r.admins[fingerprint]) return false;
    delete r.admins[fingerprint];
    this.saveConfig(c);
    return true;
  }
  // Replace the entire admin table for a room — used when receiving an
  // ADMIN_SYNC snapshot from the owner. Returns true if anything changed.
  replaceAdmins(code, adminsMap, fromFingerprint) {
    if (!code) return false;
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r) return false;
    // Only accept replace-all from the owner — otherwise a malicious peer
    // could wipe our admin table.
    if (!r.ownerFingerprint || r.ownerFingerprint !== fromFingerprint) return false;
    const next = {};
    for (const [fp, p] of Object.entries(adminsMap || {})) {
      if (!fp) continue;
      const normalized = _normalizePerms(p);
      if (!ROOM_PERMS.some(k => normalized[k])) continue;
      next[fp] = { ...normalized, grantedAt: p.grantedAt || Date.now(), grantedBy: r.ownerFingerprint };
    }
    r.admins = next;
    this.saveConfig(c);
    return true;
  }
  // Permission gate used on both the IPC side (when we're initiating an
  // action) and the receive side (when a peer's action arrives).
  // `perm` is one of ROOM_PERMS; owner always passes. Legacy rooms created
  // before owner-tracking existed have no ownerFingerprint — we treat those
  // as "open" so the upgrade doesn't silently lock admin actions on any
  // room that was already running when the feature shipped.
  // ─── Identity pinning ─────────────────────────────────────
  // Fingerprints are 64 bits — fine for eyeballs, too short to be the
  // thing authorization hangs on (a targeted collision is ~2^64 work).
  // Per room, the first full 256-bit identity seen behind a fingerprint is
  // pinned; afterwards anyone presenting that fingerprint with a different
  // key is refused for owner / admin / author / DM decisions. `id` absent
  // means a local call (the user themselves) and is not checked.
  _idOk(r, fingerprint, id) {
    if (!id) return true;
    if (!r.ids || typeof r.ids !== 'object') r.ids = {};
    const pinned = r.ids[fingerprint];
    if (!pinned) {
      if (Object.keys(r.ids).length < 5000) { r.ids[fingerprint] = id; this.saveConfig(this._cfg); }
      return true;
    }
    return pinned === id;
  }
  /** Our own identity, so local permission checks can use the PO commitment. */
  setSelfIdentity(fingerprint, identityId) { this.selfFp = fingerprint; this.selfId = identityId; }
  // The full identity to test against a PO- commitment: the peer's (network
  // calls pass it) or ours (local calls pass only our fingerprint).
  _cid(fingerprint, id) { return id || (fingerprint && fingerprint === this.selfFp ? this.selfId : ''); }

  pinIdentity(code, fingerprint, id) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    if (!r || !fingerprint) return false;
    return this._idOk(r, fingerprint, id);
  }

  hasPerm(code, fingerprint, perm, id) {
    if (!fingerprint || !perm) return false;
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    if (!r) return false;
    if (!this._idOk(r, fingerprint, id)) return false;
    if (r.isDm) return true;
    const committed = RoomCode.ownerMatches(code, this._cid(fingerprint, id));
    if (committed === true) return true;                    // the code commits to this identity: owner
    // Fail closed. A code without an owner commitment (anything that isn't
    // an SR- code or a DM — e.g. a room carried over from an old build) has
    // no provable owner, so nobody holds room permissions in it.
    if (committed === null) return false;
    if (!r.ownerFingerprint) return false;
    if (r.ownerFingerprint === fingerprint) return committed !== false;
    const a = r.admins && r.admins[fingerprint];
    return !!(a && a[perm]);
  }
  // The set of perms the given fingerprint holds for a room. Owner returns
  // all-true plus `isOwner: true`. Handy for the renderer to gate UI.
  getPerms(code, fingerprint) {
    const base = _normalizePerms(null);
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    if (!r) return { ...base, isOwner: false };
    if (r.isDm) {
      for (const k of ROOM_PERMS) base[k] = true;  // both DM peers are equal
      return { ...base, isOwner: false };
    }
    // Mirrors hasPerm: the UI must never offer what enforcement refuses.
    const committed = RoomCode.ownerMatches(code, this._cid(fingerprint));
    if (committed === null) return { ...base, isOwner: false, unowned: true };
    if (committed === true || (r.ownerFingerprint && r.ownerFingerprint === fingerprint && committed !== false)) {
      for (const k of ROOM_PERMS) base[k] = true;
      return { ...base, isOwner: true };
    }
    const a = r.admins && r.admins[fingerprint];
    if (a) for (const k of ROOM_PERMS) base[k] = !!a[k];
    return { ...base, isOwner: false };
  }

  // ─── Blocklist ──────────────────────────────────────────────────────
  // Peers on this list get their socket destroyed on KEY_EXCHANGE. Keyed
  // by fingerprint so a blocked peer can't escape by generating a new pid.
  getBlocklist() {
    const cfg = this.getConfig();
    return (cfg.blocklist && typeof cfg.blocklist === 'object') ? cfg.blocklist : {};
  }
  blockPeer(fingerprint, info) {
    if (!fingerprint) return null;
    const cfg = this.getConfig();
    if (!cfg.blocklist || typeof cfg.blocklist !== 'object') cfg.blocklist = {};
    cfg.blocklist[fingerprint] = {
      fingerprint,
      nickname: (info && info.nickname) || (cfg.blocklist[fingerprint]?.nickname) || '',
      blockedAt: Date.now(),
    };
    this.saveConfig(cfg);
    return cfg.blocklist[fingerprint];
  }
  unblockPeer(fingerprint) {
    const cfg = this.getConfig();
    if (!cfg.blocklist || !cfg.blocklist[fingerprint]) return false;
    delete cfg.blocklist[fingerprint];
    this.saveConfig(cfg);
    return true;
  }

  // ─── Export / Import all data ──────────────────────────────────────
  // Bundles config + messages + identity into a single JSON. The identity
  // block is the crypto keys — exported unencrypted, so UI must warn the
  // user loudly before handing them the file.
  //
  // Format note: v1 backups carried `histories` (a map of ndjson filename →
  // raw text). v2 carries `messages` (an array of {room, channel, msg}).
  // importAll accepts BOTH so older backups still restore correctly after
  // the SQLite migration; new exports always emit v2.
  exportAll(identityProvider) {
    let messages = [];
    try { messages = this.messages.exportMessages(); } catch (e) { messages = []; }
    let identity = null;
    // Preferred: ask the crypto layer for the plaintext pair so backups
    // stay portable even when identity.json is keystore-encrypted (v2).
    if (typeof identityProvider === 'function') {
      try { identity = identityProvider() || null; } catch (e) { identity = null; }
    }
    if (!identity) {
      try {
        const ip = path.join(this.baseDir, 'identity.json');
        if (fs.existsSync(ip)) {
          const raw = JSON.parse(fs.readFileSync(ip, 'utf8'));
          // Only legacy plaintext files are exportable this way.
          if (raw && raw.secretKey) identity = { publicKey: raw.publicKey, secretKey: raw.secretKey };
        }
      } catch {}
    }
    return {
      format: 'sirr-bundle',
      version: 2,
      exportedAt: new Date().toISOString(),
      config: this.getConfig(),
      messages,
      identity,
    };
  }
  importAll(bundle, identitySaver) {
    if (!bundle || bundle.format !== 'sirr-bundle') {
      throw new Error('Not a valid Sirr backup');
    }
    if (bundle.version !== 1 && bundle.version !== 2) {
      throw new Error('Unsupported backup version: ' + bundle.version);
    }
    if (bundle.config) this.saveConfig(bundle.config);
    // v2: messages live as structured rows.
    if (Array.isArray(bundle.messages) && bundle.messages.length) {
      try { this.messages.importMessages(bundle.messages); } catch (e) {}
    }
    // v1: messages were ndjson blobs keyed by filename. Parse them through
    // the same path the one-shot ndjson migration uses so we converge on
    // the SQLite store regardless of which backup format we're loading.
    if (bundle.histories && typeof bundle.histories === 'object') {
      const entries = [];
      for (const [name, content] of Object.entries(bundle.histories)) {
        if (typeof name !== 'string' || !name.endsWith('.ndjson')) continue;
        if (name.includes('/') || name.includes('\\') || name.includes('..')) continue;
        const stem = name.slice(0, -'.ndjson'.length);
        const split = stem.indexOf('__');
        const room = split >= 0 ? stem.slice(0, split) : stem;
        const channel = split >= 0 ? (stem.slice(split + 2) || 'default') : 'default';
        for (const line of String(content || '').split('\n')) {
          if (!line) continue;
          try {
            const m = JSON.parse(line);
            if (m && m.msgId) entries.push({ room, channel: m.channel || channel, msg: m });
          } catch (e) {}
        }
      }
      if (entries.length) {
        try { this.messages.importMessages(entries); } catch (e) {}
      }
    }
    if (bundle.identity && bundle.identity.publicKey && bundle.identity.secretKey) {
      // Preferred: route through the crypto layer so the restored key is
      // validated and saved keystore-encrypted on this machine.
      let saved = false;
      if (typeof identitySaver === 'function') {
        try { saved = !!identitySaver(bundle.identity); } catch (e) { saved = false; }
      }
      if (!saved) {
        const ip = path.join(this.baseDir, 'identity.json');
        try {
          fs.writeFileSync(ip, JSON.stringify({
            version: 1,
            publicKey: bundle.identity.publicKey,
            secretKey: bundle.identity.secretKey,
          }, null, 2), { mode: 0o600 });
        } catch {}
      }
    }
    return true;
  }

  // ─── Offline sync support ──────────────────────────────────────────
  // Return the msgIds of the last N messages across all channels of a
  // room. Peers compare these to detect missing history on reconnect.
  getRoomMessageIds(room, limit = 200) {
    try { return this.messages.getRoomMessageIds(room, limit); }
    catch (e) { return []; }
  }
  // Return full message records for a set of msgIds. Used to reply to a
  // peer's SYNC_FETCH request with the messages they're missing.
  getMessagesByIds(room, msgIds) {
    let out = [];
    try { out = this.messages.getMessagesByIds(room, msgIds || []); }
    catch (e) { return []; }
    for (const m of out) {
      if (m && m.contentRef) {
        const content = this._loadFile(m.contentRef);
        if (content) m.content = content;
      }
    }
    return out;
  }
  // ─── Pinned messages ───────────────────────────────────────────────
  // Pins are stored on the channel record as `pins: { msgId: { preview,
  // nick, ts } }`. Preview is a short text snippet so the pins panel has
  // something to show even if the original message was never received
  // locally (e.g. peer pinned something before we came online).
  _findChannel(code, channelId) {
    const cfg = this.getConfig();
    const r = (cfg.rooms || []).find(r => r.code === code);
    if (!r || !Array.isArray(r.channels)) return { cfg, room: null, channel: null };
    const ch = r.channels.find(c => c.id === (channelId || 'default'));
    return { cfg, room: r, channel: ch || null };
  }
  getPins(code, channelId) {
    const { channel } = this._findChannel(code, channelId);
    return (channel && channel.pins && typeof channel.pins === 'object') ? channel.pins : {};
  }
  // Toggle (pin === true sets / pin === false removes). Returns the updated
  // pin record for true, or null when removing / when the channel is missing.
  setPin(code, channelId, msgId, pinned, info) {
    if (!msgId) return null;
    const { cfg, channel } = this._findChannel(code, channelId);
    if (!channel) return null;
    if (!channel.pins || typeof channel.pins !== 'object') channel.pins = {};
    if (pinned) {
      channel.pins[msgId] = {
        preview: ((info && info.preview) || '').slice(0, 160),
        nick: (info && info.nick) || '',
        ts: (info && info.ts) || Date.now(),
      };
      this.saveConfig(cfg);
      return channel.pins[msgId];
    } else {
      if (!channel.pins[msgId]) return null;
      delete channel.pins[msgId];
      this.saveConfig(cfg);
      return null;
    }
  }
  // List all pins across every channel of a room. Used when replying to a
  // PINS_SYNC request on peer-joined — each channel is sent in its own
  // message so recipients can reconcile per channel.
  getAllPinsForRoom(code) {
    const cfg = this.getConfig();
    const r = (cfg.rooms || []).find(r => r.code === code);
    if (!r || !Array.isArray(r.channels)) return [];
    const out = [];
    for (const ch of r.channels) {
      if (!ch.pins || typeof ch.pins !== 'object') continue;
      const pins = [];
      for (const [msgId, rec] of Object.entries(ch.pins)) {
        pins.push({ msgId, preview: rec.preview || '', nick: rec.nick || '', ts: rec.ts || 0 });
      }
      if (pins.length) out.push({ channel: ch.id, pins });
    }
    return out;
  }

  isMessageDeleted(room, channel, msgId) {
    if (!msgId) return false;
    const { channel: ch } = this._findChannel(room, channel);
    return !!(ch && ch.deletedMsgIds && ch.deletedMsgIds[msgId]);
  }

  deleteMessage(room, channel, msgId) {
    if (!msgId) return { ok: false };
    const chId = channel || 'default';
    const { cfg, channel: ch } = this._findChannel(room, chId);
    if (!ch) return { ok: false };

    let removed = null;
    try { removed = this.messages.deleteMessage(room, chId, msgId); }
    catch (e) { return { ok: false, error: e.message || 'delete failed' }; }
    if (!removed) return { ok: false };

    if (removed.contentRef) {
      try { fs.unlinkSync(path.join(this.filesDir, removed.contentRef)); } catch (e) {}
    }
    if (!ch.deletedMsgIds || typeof ch.deletedMsgIds !== 'object') ch.deletedMsgIds = {};
    ch.deletedMsgIds[msgId] = Date.now();
    if (ch.pins && ch.pins[msgId]) delete ch.pins[msgId];
    this.saveConfig(cfg);
    return { ok: true, message: removed };
  }

  hasMessage(room, channel, msgId) {
    if (!msgId) return false;
    if (this.isMessageDeleted(room, channel, msgId)) return true;
    try { return this.messages.hasMessage(room, channel, msgId); }
    catch (e) { return false; }
  }

  // ─── Edit (author-only) ────────────────────────────────────────────
  // Looks up the existing row, verifies that `byFingerprint` matches the
  // message's recorded author, and rewrites `content`. Returns
  // { ok, message } where `message` is the updated row, or { ok: false,
  // error } on failure. Image / file messages are not editable (their
  // content lives off-row in `contentRef`).
  // ─── DM message requests ───────────────────────────────────
  // A DM from someone who isn't in your contacts arrives as a request: the
  // conversation exists but is flagged until you accept (or decline) it.
  setDmRequest(code, on) {
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r) return false;
    if (on) r.request = true; else delete r.request;
    this.saveConfig(c);
    return true;
  }
  isDmRequest(code) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    return !!(r && r.request);
  }

  // ─── Per-room signing keys of other members ────────────────
  // Learned only directly from each member over the authenticated
  // session. Trust-on-first-use: a key once recorded for (room, fp) is
  // never replaced — the derivation is deterministic, so a change means
  // someone is lying.
  setRoomSignKey(code, fingerprint, pub, id) {
    const c = this.getConfig();
    const r = (c.rooms || []).find(r => r.code === code);
    if (!r || !fingerprint || typeof pub !== 'string') return false;
    if (!this._idOk(r, fingerprint, id)) return 'conflict';
    if (!r.signKeys || typeof r.signKeys !== 'object') r.signKeys = {};
    if (r.signKeys[fingerprint]) return r.signKeys[fingerprint] === pub ? false : 'conflict';
    if (Object.keys(r.signKeys).length >= 1000) return false;
    r.signKeys[fingerprint] = pub;
    this.saveConfig(c);
    return true;
  }
  getRoomSignKey(code, fingerprint) {
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    return (r && r.signKeys && r.signKeys[fingerprint]) || '';
  }

  editMessage(room, channel, msgId, content, byFingerprint, extra, byId) {
    if (byId) {
      const rr = (this.getConfig().rooms || []).find(x => x.code === room);
      if (rr && !this._idOk(rr, byFingerprint, byId)) return { ok: false, error: 'NOT_AUTHOR' };
    }
    if (!msgId) return { ok: false, error: 'NO_MSG' };
    const chId = channel || 'default';
    let existing;
    try { existing = this.messages.getMessage(room, chId, msgId); }
    catch (e) { return { ok: false, error: e.message || 'lookup failed' }; }
    if (!existing) return { ok: false, error: 'NOT_FOUND' };
    if (existing.type !== 'text') return { ok: false, error: 'NOT_EDITABLE' };
    // Authorization: only the original author can edit. We compare the
    // recorded fingerprint when present; for very old self-messages where
    // the fingerprint wasn't stored, we accept `self === true` paired with
    // `byFingerprint` matching our own (callers in main.js pass our fp).
    const authorFp = existing.fingerprint || '';
    if (authorFp) {
      if (!byFingerprint || authorFp !== byFingerprint) {
        return { ok: false, error: 'NOT_AUTHOR' };
      }
    } else if (!existing.self) {
      // No author fp recorded AND not our own message — refuse.
      return { ok: false, error: 'NOT_AUTHOR' };
    }
    const ok = this.messages.updateMessageContent(room, chId, msgId, content);
    if (!ok) return { ok: false, error: 'UPDATE_FAILED' };
    if (extra && (extra.editSig || extra.editedAt || 'sigOk' in extra)) {
      // sigOk follows the latest content: a verified edit keeps the badge,
      // an unverifiable one drops it (null clears the stored flag).
      const meta = { editSig: extra.editSig || undefined, editedAt: extra.editedAt || undefined };
      if ('sigOk' in extra) {
        meta.sigOk = extra.sigOk === true ? true : null;
        if (extra.sigOk !== true) meta.verified = null;
      }
      try { this.messages.mergeMeta(room, chId, msgId, meta); } catch (e) {}
    }
    const updated = this.messages.getMessage(room, chId, msgId);
    return { ok: true, message: updated };
  }

  // ─── Moderation gate ───────────────────────────────────────────────
  // Used by the delete-for-all path. The owner can always moderate; granted
  // admins (anyone with at least one ROOM_PERM) can too. The original
  // author of a message can always delete it for everyone — that's the
  // expected social default and doesn't depend on admin status.
  canModerate(code, fingerprint, id) {
    if (!code || !fingerprint) return false;
    const r = (this.getConfig().rooms || []).find(r => r.code === code);
    if (!r) return false;
    if (!this._idOk(r, fingerprint, id)) return false;
    if (r.isDm) return true;                              // both DM peers are equal
    const committed = RoomCode.ownerMatches(code, this._cid(fingerprint, id));
    if (committed === true) return true;                  // the code commits to this identity: owner
    if (committed === null) return false;                 // no owner commitment: fail closed
    if (!r.ownerFingerprint) return false;
    if (r.ownerFingerprint === fingerprint) return committed !== false;  // owner
    const a = r.admins && r.admins[fingerprint];
    if (!a) return false;
    return ROOM_PERMS.some(k => a[k]);                    // any granted perm = moderator
  }

  _safe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  getDataDir() { return this.baseDir; }
  getStorageStats() {
    let sz = 0;
    try {
      // SQLite DB + WAL/SHM sidecars all sit at this.baseDir/messages.db*
      for (const name of fs.readdirSync(this.baseDir)) {
        if (!name.startsWith('messages.db')) continue;
        try { sz += fs.statSync(path.join(this.baseDir, name)).size; } catch (e) {}
      }
    } catch (e) {}
    // Any leftover .ndjson.migrated files (kept on disk for recovery) and
    // pre-migration loose .ndjson files still count toward total footprint.
    try {
      for (const name of fs.readdirSync(this.historyDir)) {
        try { sz += fs.statSync(path.join(this.historyDir, name)).size; } catch (e) {}
      }
    } catch (e) {}
    try {
      for (const name of fs.readdirSync(this.filesDir)) {
        try { sz += fs.statSync(path.join(this.filesDir, name)).size; } catch (e) {}
      }
    } catch (e) {}
    let msgCount = 0;
    try { msgCount = this.messages.count(); } catch (e) {}
    return {
      dataDir: this.baseDir,
      rooms: this.getRooms().length,
      messages: msgCount,
      totalSizeHuman: sz < 1048576 ? (sz / 1024).toFixed(1) + 'KB' : (sz / 1048576).toFixed(1) + 'MB',
    };
  }

  // Clean shutdown — close the SQLite handle so WAL can checkpoint.
  close() {
    try { if (this.messages) this.messages.close(); } catch (e) {}
  }
}
SirrStorage.makeChannelId = makeChannelId;
SirrStorage.defaultDir = () => path.join(os.homedir(), '.sirr');
SirrStorage.DEFAULT_CHANNEL = DEFAULT_CHANNEL;
SirrStorage.ROOM_PERMS = ROOM_PERMS;
module.exports = SirrStorage;
