'use strict';
/**
 * Sirr — lite message store (pure JS)
 * ═══════════════════════════════════════════════════════════════════
 * Same API as message-store.js (SQLite), for runtimes that can't load
 * native Node addons — Sirr Mobile's Bare worklet. One file per room,
 * named by a keyed hash of the room code and sealed with the vault, so the
 * at-rest guarantees match desktop: no room code, message or name is
 * readable on disk.
 *
 * Kept in memory, flushed (debounced) after writes. Sized for a phone: the
 * newest MAX_PER_CHANNEL messages of each channel are kept.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PER_CHANNEL = 3000;
const FLUSH_MS = 400;

class LiteMessageStore {
  constructor(dbPath, vault, opts = {}) {
    this.dir = path.join(path.dirname(dbPath), 'msgs');
    this.vault = vault || null;
    this.migratedRows = 0;
    this.rooms = new Map();          // room -> { channels: {ch: [msg]} }
    this.dirty = new Set();
    this._t = null;
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.startsWith('m_') || !f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
        const j = JSON.parse(this.vault && this.vault.isSealed(raw) ? this.vault.open(raw) : raw);
        if (j && j.room) this.rooms.set(j.room, { channels: j.channels || {} });
      } catch (e) { /* unreadable file: skip rather than lose the rest */ }
    }
  }

  _file(room) {
    const id = this.vault ? this.vault.mac('litefile|' + room) : crypto.createHash('sha256').update(String(room)).digest('hex').slice(0, 32);
    return path.join(this.dir, 'm_' + id + '.json');
  }
  _room(room, create) {
    let r = this.rooms.get(room);
    if (!r && create) { r = { channels: {} }; this.rooms.set(room, r); }
    return r;
  }
  _list(room, ch, create) {
    const r = this._room(room, create);
    if (!r) return null;
    ch = ch || 'default';
    if (!r.channels[ch] && create) r.channels[ch] = [];
    return r.channels[ch] || null;
  }
  _touch(room) {
    this.dirty.add(room);
    if (this._t) return;
    this._t = setTimeout(() => { this._t = null; this.flush(); }, FLUSH_MS);
  }
  flush() {
    for (const room of this.dirty) {
      const r = this.rooms.get(room);
      const f = this._file(room);
      try {
        if (!r || !Object.values(r.channels).some(l => l.length)) { if (fs.existsSync(f)) fs.unlinkSync(f); continue; }
        const json = JSON.stringify({ room, channels: r.channels });
        fs.writeFileSync(f + '.tmp', this.vault ? this.vault.seal(json) : json);
        fs.renameSync(f + '.tmp', f);
      } catch (e) {}
    }
    this.dirty.clear();
  }

  _find(room, ch, msgId) {
    const l = this._list(room, ch, false);
    if (!l) return -1;
    for (let i = l.length - 1; i >= 0; i--) if (l[i].msgId === msgId) return i;
    return -1;
  }

  appendMessage(room, channel, msg) {
    if (!msg || !msg.msgId) return false;
    const ch = channel || 'default';
    if (this._find(room, ch, String(msg.msgId)) >= 0) return false;
    const l = this._list(room, ch, true);
    const m = { ...msg, msgId: String(msg.msgId), channel: ch, timestamp: Number(msg.timestamp || msg.ts || Date.now()), storedAt: Date.now() };
    // keep ordered by timestamp (appends are almost always newest)
    let i = l.length;
    while (i > 0 && l[i - 1].timestamp > m.timestamp) i--;
    l.splice(i, 0, m);
    if (l.length > MAX_PER_CHANNEL) l.splice(0, l.length - MAX_PER_CHANNEL);
    this._touch(room);
    return true;
  }
  updateMessageContent(room, channel, msgId, content) {
    const i = this._find(room, channel, String(msgId)); if (i < 0) return false;
    this._list(room, channel)[i].content = String(content || ''); this._touch(room); return true;
  }
  mergeMeta(room, channel, msgId, extra) {
    const i = this._find(room, channel, String(msgId)); if (i < 0) return false;
    Object.assign(this._list(room, channel)[i], extra || {}); this._touch(room); return true;
  }
  deleteMessage(room, channel, msgId) {
    const i = this._find(room, channel, String(msgId)); if (i < 0) return null;
    const [m] = this._list(room, channel).splice(i, 1); this._touch(room); return m;
  }
  clearChannel(room, channel) { const r = this._room(room); if (r) { delete r.channels[channel || 'default']; this._touch(room); } }
  clearRoom(room) { if (this.rooms.delete(room)) this._touch(room); }

  getHistory(room, channel, limit) {
    const l = this._list(room, channel, false) || [];
    const lim = (Number.isInteger(limit) && limit > 0) ? limit : 200;
    return l.slice(-lim).map(m => ({ ...m }));
  }
  hasMessage(room, channel, msgId) { return !!msgId && this._find(room, channel, String(msgId)) >= 0; }
  getMessage(room, channel, msgId) {
    const i = this._find(room, channel, String(msgId)); return i < 0 ? null : { ...this._list(room, channel)[i] };
  }
  getRoomMessageIds(room, limit) {
    const r = this._room(room); if (!r) return [];
    const all = [];
    for (const [ch, l] of Object.entries(r.channels)) for (const m of l) all.push({ msgId: m.msgId, channel: ch, ts: m.timestamp });
    all.sort((a, b) => a.ts - b.ts);
    const lim = (Number.isInteger(limit) && limit > 0) ? limit : 200;
    return all.slice(-lim);
  }
  getMessagesByIds(room, msgIds) {
    const r = this._room(room); if (!r || !Array.isArray(msgIds)) return [];
    const want = new Set(msgIds.map(String)), out = [];
    for (const l of Object.values(r.channels)) for (const m of l) if (want.has(m.msgId)) out.push({ ...m });
    return out;
  }
  count() { let n = 0; for (const r of this.rooms.values()) for (const l of Object.values(r.channels)) n += l.length; return n; }
  exportMessages() {
    const out = [];
    for (const [room, r] of this.rooms) for (const [ch, l] of Object.entries(r.channels)) for (const m of l) out.push({ room, channel: ch, msg: { ...m } });
    return out;
  }
  importMessages(entries) {
    let n = 0;
    for (const e of entries || []) if (e && e.msg && this.appendMessage(e.room, e.channel || e.msg.channel, e.msg)) n++;
    return n;
  }
  migrateNdjson() { return { files: 0, rows: 0 }; }
  sweepExpired(now) {
    const cutoff = Number(now || Date.now()), removed = [];
    for (const [room, r] of this.rooms) {
      for (const [ch, l] of Object.entries(r.channels)) {
        const keep = l.filter(m => !(m.expiresAt > 0 && m.expiresAt <= cutoff));
        if (keep.length !== l.length) {
          for (const m of l) if (m.expiresAt > 0 && m.expiresAt <= cutoff) removed.push({ room, channel: ch, msgId: m.msgId });
          r.channels[ch] = keep; this._touch(room);
        }
      }
    }
    return removed;
  }
  scrub() { this.flush(); }
  close() { if (this._t) { clearTimeout(this._t); this._t = null; } this.flush(); }
}

module.exports = LiteMessageStore;
