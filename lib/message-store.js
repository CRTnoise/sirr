/**
 * Sirr — Message Store (SQLite)
 * =================================
 * Replaces the per-channel .ndjson files with a single SQLite database.
 *
 * Why SQLite: O(log n) lookup-by-msgId on a B-tree, single-statement range
 * queries (last N for getHistory, sync summaries, etc.), and trivial future
 * search support, all without sidecar index bookkeeping. better-sqlite3 is
 * synchronous (perfect for the main process) and electron-builder rebuilds
 * the native binding via `postinstall: install-app-deps`.
 *
 * Schema:
 *   messages(room, channel, msg_id) PRIMARY KEY
 *           ts INTEGER       — wall-clock timestamp from the sender
 *           stored_at INTEGER — when WE persisted it (replaces .ndjson's
 *                               wrapper field of the same name)
 *           nickname, fingerprint, type, content, content_ref, reply_to,
 *           self (0|1), file_name, file_size
 *
 *   Indexes:
 *     idx_messages_room_channel_ts — getHistory(room, channel, limit)
 *     idx_messages_room_ts         — getRoomMessageIds(room, limit) and
 *                                    cross-channel scans
 *
 * Image content (data URIs > 1 KB) still get spilled to disk via the existing
 * filesDir scheme. The DB row stores `content_ref` (the file id); `content`
 * is restored at read time by the caller (SirrStorage._loadFile).
 */

const Database = require('better-sqlite3');
const Vault = require('./vault');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  room        TEXT NOT NULL,
  channel     TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  stored_at   INTEGER NOT NULL,
  nickname    TEXT,
  fingerprint TEXT,
  type        TEXT NOT NULL,
  content     TEXT,
  content_ref TEXT,
  reply_to    TEXT,
  self        INTEGER DEFAULT 0,
  file_name   TEXT,
  file_size   INTEGER,
  expires_at  INTEGER DEFAULT 0,
  meta        TEXT,
  PRIMARY KEY (room, channel, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_room_channel_ts
  ON messages(room, channel, ts);
CREATE INDEX IF NOT EXISTS idx_messages_room_ts
  ON messages(room, ts);
`;

const META_KEYS = ['sig', 'sigOk', 'editSig', 'editedAt', 'relayedBy', 'verified', 'fileRef'];
const MAX_CONTENT = 8000;   // text ceiling, same as inbound chat (defense in depth for edits)
function _metaOf(msg) {
  const x = {};
  let any = false;
  for (const k of META_KEYS) if (msg[k] !== undefined && msg[k] !== null && msg[k] !== '') { x[k] = msg[k]; any = true; }
  return any ? JSON.stringify(x) : null;
}

function _rowToMessage(row) {
  if (!row) return null;
  const m = {
    msgId: row.msg_id,
    nickname: row.nickname || '',
    content: row.content || '',
    type: row.type || 'text',
    timestamp: row.ts,
    storedAt: row.stored_at,
    channel: row.channel,
    self: !!row.self,
  };
  if (row.fingerprint) m.fingerprint = row.fingerprint;
  if (row.expires_at) m.expiresAt = row.expires_at;
  if (row.reply_to) {
    try { m.replyTo = JSON.parse(row.reply_to); }
    catch (e) { m.replyTo = null; }
  } else {
    m.replyTo = null;
  }
  if (row.content_ref) m.contentRef = row.content_ref;
  // Extras (signatures, relay provenance, BOLT file ref). Only known
  // keys are copied back so a row can't smuggle arbitrary fields.
  if (row.meta) {
    try {
      const x = JSON.parse(row.meta) || {};
      for (const k of META_KEYS) if (x[k] !== undefined) m[k] = x[k];
    } catch (e) {}
  }
  if (row.file_name)   m.fileName = row.file_name;
  if (row.file_size)   m.fileSize = row.file_size;
  return m;
}

class MessageStore {
  /**
   * @param {string} dbPath
   * @param {import('./vault')} [vault]  when given, rows are encrypted at rest
   */
  constructor(dbPath, vault, opts = {}) {
    this.dbPath = dbPath;
    this.vault = vault || null;
    this.remapRef = opts.remapRef || null;
    this.db = new Database(dbPath);
    try { this.db.pragma('journal_mode = WAL'); } catch (e) {}
    // Deleted rows are overwritten with zeros instead of lingering in free
    // pages — disappearing messages actually disappear from the file.
    try { this.db.pragma('secure_delete = ON'); } catch (e) {}
    this.db.exec(SCHEMA);
    // Older DBs: add columns introduced later.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(messages)`).all();
      if (!cols.some(c => c.name === 'expires_at')) this.db.exec(`ALTER TABLE messages ADD COLUMN expires_at INTEGER DEFAULT 0`);
      if (!cols.some(c => c.name === 'meta')) this.db.exec(`ALTER TABLE messages ADD COLUMN meta TEXT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at > 0`);
    } catch (e) {}
    this._prepare();
    if (this.vault) this._migrateToVault();
  }

  // ─── at-rest encoding ───────────────────────────────────────
  // With a vault: `room` and `channel` hold keyed hashes (lookups and
  // indexes still work, the codes never touch disk); every text field —
  // including the real room/channel — lives in one sealed body in
  // `content`. ts / stored_at / self / expires_at stay clear for ordering
  // and expiry sweeps.
  _r(room) { return this.vault ? 'r:' + this.vault.mac('room|' + room) : String(room); }
  _c(room, ch) { ch = ch || 'default'; return this.vault ? 'c:' + this.vault.mac('ch|' + room + '|' + ch) : ch; }

  _messageToRow(room, channel, msg) {
    const ts = Number(msg.timestamp || msg.ts || Date.now());
    const ch = channel || 'default';
    if (!this.vault) {
      return {
        room: String(room), channel: String(ch), msg_id: String(msg.msgId), ts,
        stored_at: Number(msg.storedAt || Date.now()),
        nickname: msg.nickname || '', fingerprint: msg.fingerprint || '',
        type: msg.type || 'text',
        content: typeof msg.content === 'string' ? msg.content : '',
        content_ref: msg.contentRef || null,
        reply_to: msg.replyTo ? JSON.stringify(msg.replyTo) : null,
        self: msg.self ? 1 : 0, file_name: msg.fileName || '', file_size: Number(msg.fileSize || 0),
        expires_at: Number(msg.expiresAt || 0), meta: _metaOf(msg),
      };
    }
    const body = {
      room: String(room), channel: String(ch),
      nickname: msg.nickname || '', fingerprint: msg.fingerprint || '',
      type: msg.type || 'text',
      content: typeof msg.content === 'string' ? msg.content : '',
      replyTo: msg.replyTo || null, fileName: msg.fileName || '', fileSize: Number(msg.fileSize || 0),
    };
    for (const k of META_KEYS) if (msg[k] !== undefined && msg[k] !== null && msg[k] !== '') body[k] = msg[k];
    return {
      room: this._r(room), channel: this._c(room, ch), msg_id: String(msg.msgId), ts,
      stored_at: Number(msg.storedAt || Date.now()),
      nickname: '', fingerprint: '', type: 'x',
      content: this.vault.seal(JSON.stringify(body)),
      content_ref: msg.contentRef || null, reply_to: null,
      self: msg.self ? 1 : 0, file_name: '', file_size: 0,
      expires_at: Number(msg.expiresAt || 0), meta: null,
    };
  }

  /** Row → message. Also returns `room` (real code) when known. */
  _toMsg(row) {
    if (!row) return null;
    if (this.vault && this.vault.isSealed(row.content)) {
      let b;
      try { b = JSON.parse(this.vault.open(row.content)); } catch (e) { return null; }
      const m = {
        msgId: row.msg_id, nickname: b.nickname || '', content: b.content || '',
        type: b.type || 'text', timestamp: row.ts, storedAt: row.stored_at,
        channel: b.channel || 'default', self: !!row.self, replyTo: b.replyTo || null,
      };
      if (b.fingerprint) m.fingerprint = b.fingerprint;
      if (row.expires_at) m.expiresAt = row.expires_at;
      if (row.content_ref) m.contentRef = row.content_ref;
      if (b.fileName) m.fileName = b.fileName;
      if (b.fileSize) m.fileSize = b.fileSize;
      for (const k of META_KEYS) if (b[k] !== undefined) m[k] = b[k];
      Object.defineProperty(m, '_room', { value: b.room, enumerable: false });
      return m;
    }
    const m = _rowToMessage(row);
    if (m) Object.defineProperty(m, '_room', { value: row.room, enumerable: false });
    return m;
  }

  _migrateToVault() {
    let ver = 0;
    try { ver = this.db.pragma('user_version', { simple: true }) || 0; } catch (e) {}
    if (ver >= 2) return;
    const rows = this.db.prepare(`SELECT * FROM messages`).all();
    const plain = rows.filter(r => !this.vault.isSealed(r.content));
    if (plain.length) {
      const tx = this.db.transaction(() => {
        const del = this.db.prepare(`DELETE FROM messages WHERE room = ? AND channel = ? AND msg_id = ?`);
        for (const r of plain) {
          const m = _rowToMessage(r);
          if (m.contentRef && this.remapRef) m.contentRef = this.remapRef(m.contentRef, r.room, r.channel, r.msg_id);
          del.run(r.room, r.channel, r.msg_id);
          this._stmt.insert.run(this._messageToRow(r.room, r.channel, m));
        }
      });
      tx();
    }
    this.db.pragma('user_version = 2');
    // Squeeze plaintext out of free pages and the WAL.
    try { this.db.exec('VACUUM'); } catch (e) {}
    this.scrub();
    this.migratedRows = plain.length;
  }

  /** Flush the WAL into the DB and truncate it (deleted data leaves the log too). */
  scrub() { try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {} }

  _prepare() {
    this._stmt = {
      insert: this.db.prepare(`
        INSERT OR IGNORE INTO messages
          (room, channel, msg_id, ts, stored_at, nickname, fingerprint,
           type, content, content_ref, reply_to, self, file_name, file_size, expires_at, meta)
        VALUES
          (@room, @channel, @msg_id, @ts, @stored_at, @nickname, @fingerprint,
           @type, @content, @content_ref, @reply_to, @self, @file_name, @file_size, @expires_at, @meta)
      `),
      historyTailLimited: this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM messages
          WHERE room = ? AND channel = ?
          ORDER BY ts DESC, stored_at DESC
          LIMIT ?
        ) ORDER BY ts ASC, stored_at ASC
      `),
      hasMessage: this.db.prepare(`SELECT 1 FROM messages WHERE room = ? AND channel = ? AND msg_id = ? LIMIT 1`),
      getOne: this.db.prepare(`SELECT * FROM messages WHERE room = ? AND channel = ? AND msg_id = ? LIMIT 1`),
      deleteOne: this.db.prepare(`DELETE FROM messages WHERE room = ? AND channel = ? AND msg_id = ?`),
      updateRow: this.db.prepare(`
        UPDATE messages SET content = ?, stored_at = ?, meta = ?, nickname = ?, fingerprint = ?, reply_to = ?, file_name = ?, file_size = ?
        WHERE room = ? AND channel = ? AND msg_id = ?
      `),
      clearChannel: this.db.prepare(`DELETE FROM messages WHERE room = ? AND channel = ?`),
      clearRoom: this.db.prepare(`DELETE FROM messages WHERE room = ?`),
      idsForRoomTail: this.db.prepare(`
        SELECT * FROM (
          SELECT * FROM messages WHERE room = ? ORDER BY ts DESC LIMIT ?
        ) ORDER BY ts ASC
      `),
      getByMsgIdsRoom: this.db.prepare(`SELECT * FROM messages WHERE room = ? AND msg_id = ?`),
      allForExport: this.db.prepare(`SELECT * FROM messages ORDER BY ts ASC`),
      countAll: this.db.prepare(`SELECT COUNT(*) AS n FROM messages`),
      expiredList: this.db.prepare(`SELECT * FROM messages WHERE expires_at > 0 AND expires_at <= ?`),
      sweepExpired: this.db.prepare(`DELETE FROM messages WHERE expires_at > 0 AND expires_at <= ?`),
    };
    this._insertMany = this.db.transaction((rows) => {
      let n = 0;
      for (const row of rows) { const r = this._stmt.insert.run(row); if (r && r.changes) n++; }
      return n;
    });
  }

  // ─── Writes ────────────────────────────────────────────────────────
  appendMessage(room, channel, msg) {
    if (!msg || !msg.msgId) return false;
    const r = this._stmt.insert.run(this._messageToRow(room, channel || 'default', msg));
    return !!(r && r.changes);
  }

  _rewrite(room, channel, msgId, mutate) {
    const ch = channel || 'default';
    const row = this._stmt.getOne.get(this._r(room), this._c(room, ch), String(msgId));
    if (!row) return false;
    const m = this._toMsg(row);
    if (!m) return false;
    mutate(m);
    const nr = this._messageToRow(room, ch, m);
    const r = this._stmt.updateRow.run(nr.content, Date.now(), nr.meta, nr.nickname, nr.fingerprint, nr.reply_to, nr.file_name, nr.file_size,
      this._r(room), this._c(room, ch), String(msgId));
    return !!(r && r.changes);
  }

  // Edit-in-place. Caller is responsible for permission checking.
  updateMessageContent(room, channel, msgId, content) {
    if (!msgId) return false;
    const c = String(content || '');
    if (c.length > MAX_CONTENT) return false;
    return this._rewrite(room, channel, msgId, (m) => { m.content = c; });
  }

  /** Merge extras (e.g. editSig/editedAt) into a stored message. */
  mergeMeta(room, channel, msgId, extra) {
    return this._rewrite(room, channel, msgId, (m) => {
      for (const k of META_KEYS) if (extra && extra[k] !== undefined) m[k] = extra[k];
    });
  }

  deleteMessage(room, channel, msgId) {
    const ch = channel || 'default';
    const row = this._stmt.getOne.get(this._r(room), this._c(room, ch), String(msgId));
    if (!row) return null;
    this._stmt.deleteOne.run(this._r(room), this._c(room, ch), String(msgId));
    this._scheduleScrub();
    return this._toMsg(row);
  }
  clearChannel(room, channel) { this._stmt.clearChannel.run(this._r(room), this._c(room, channel)); this._scheduleScrub(); }
  clearRoom(room) { this._stmt.clearRoom.run(this._r(room)); this._scheduleScrub(); }

  _scheduleScrub() {
    if (this._scrubT) return;
    this._scrubT = setTimeout(() => { this._scrubT = null; this.scrub(); }, 2000);
    if (this._scrubT.unref) this._scrubT.unref();
  }

  // ─── Reads ─────────────────────────────────────────────────────────
  getHistory(room, channel, limit) {
    const lim = (Number.isInteger(limit) && limit > 0) ? limit : 200;
    return this._stmt.historyTailLimited.all(this._r(room), this._c(room, channel), lim).map(r => this._toMsg(r)).filter(Boolean);
  }
  hasMessage(room, channel, msgId) {
    if (!msgId) return false;
    return !!this._stmt.hasMessage.get(this._r(room), this._c(room, channel), String(msgId));
  }
  getMessage(room, channel, msgId) {
    if (!msgId) return null;
    return this._toMsg(this._stmt.getOne.get(this._r(room), this._c(room, channel), String(msgId)));
  }
  getRoomMessageIds(room, limit) {
    const lim = (Number.isInteger(limit) && limit > 0) ? limit : 200;
    return this._stmt.idsForRoomTail.all(this._r(room), lim).map(r => {
      const m = this._toMsg(r);
      return m ? { msgId: r.msg_id, channel: m.channel, ts: r.ts } : null;
    }).filter(Boolean);
  }
  getMessagesByIds(room, msgIds) {
    if (!Array.isArray(msgIds) || !msgIds.length) return [];
    const out = [], seen = new Set();
    for (const id of msgIds) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      for (const r of this._stmt.getByMsgIdsRoom.all(this._r(room), String(id))) { const m = this._toMsg(r); if (m) out.push(m); }
    }
    return out;
  }

  // ─── Bulk import / export ──────────────────────────────────────────
  count() { const r = this._stmt.countAll.get(); return r ? r.n : 0; }

  exportMessages() {
    return this._stmt.allForExport.all().map(r => {
      const m = this._toMsg(r);
      return m ? { room: m._room, channel: m.channel, msg: m } : null;
    }).filter(Boolean);
  }

  importMessages(entries) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const rows = [];
    for (const e of entries) {
      if (!e || !e.msg || !e.msg.msgId) continue;
      rows.push(this._messageToRow(e.room, e.channel || e.msg.channel || 'default', e.msg));
    }
    return this._insertMany(rows);
  }

  // ─── ndjson → SQLite one-shot migration (pre-3.x history) ──────────
  migrateNdjson(historyDir) {
    if (!fs.existsSync(historyDir)) return { files: 0, rows: 0 };
    let names = [];
    try { names = fs.readdirSync(historyDir); } catch (e) { return { files: 0, rows: 0 }; }
    let files = 0, rows = 0;
    for (const name of names) {
      const fp = path.join(historyDir, name);
      // with at-rest encryption on, leftover plaintext copies from the
      // original migration are shredded instead of kept forever.
      if (name.endsWith('.ndjson.migrated')) { if (this.vault) Vault.shred(fp); continue; }
      if (!name.endsWith('.ndjson')) continue;
      let room, channel;
      const stem = name.slice(0, -'.ndjson'.length);
      const split = stem.indexOf('__');
      if (split >= 0) { room = stem.slice(0, split); channel = stem.slice(split + 2) || 'default'; }
      else { room = stem; channel = 'default'; }
      let text;
      try { text = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
      const batch = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch (e) { continue; }
        if (!m || !m.msgId) continue;
        batch.push(this._messageToRow(room, m.channel || channel, m));
      }
      if (batch.length) { try { rows += this._insertMany(batch); } catch (e) {} }
      files++;
      if (this.vault) Vault.shred(fp);
      else { try { fs.renameSync(fp, fp + '.migrated'); } catch (e) {} }
    }
    return { files, rows };
  }

  // Delete every message whose TTL has elapsed. Returns {room, channel, msgId}.
  sweepExpired(now) {
    const cutoff = Number(now || Date.now());
    let removed = [];
    try {
      removed = this._stmt.expiredList.all(cutoff).map(r => {
        const m = this._toMsg(r);
        return { room: m ? m._room : r.room, channel: m ? m.channel : r.channel, msgId: r.msg_id };
      });
      if (removed.length) { this._stmt.sweepExpired.run(cutoff); this.scrub(); }
    } catch (e) { removed = []; }
    return removed;
  }

  close() {
    try { this.scrub(); } catch (e) {}
    try { this.db.close(); } catch (e) {}
  }
}

module.exports = MessageStore;
