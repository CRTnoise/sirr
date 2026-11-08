'use strict';
/**
 * Sirr file transfers — BOLT
 * ═══════════════════════════════════════════════════════════════════
 * Runs in the main process. The renderer only says "send this file"
 * and draws progress; bytes never cross IPC as base64 and are never
 * held whole in memory on either side.
 *
 * PER-PEER JOBS
 * A file sent to a room fans out into one job per recipient, each with
 * its own progress, speed, resume state and verdict. Recipients that
 * speak BOLT get binary frames; older clients get the legacy JSON path
 * (shaped so that receivers on the JSON path accept it — see LEGACY).
 *
 * BOLT SESSION (control messages are encrypted JSON, data is frames)
 *
 *   sender                          receiver
 *   offer {id,sid,epoch,size,…}  →
 *                                ←  accept {id,epoch,from}   (from = resume offset)
 *   DATA frames seq = from/CHUNK… →  decrypt, LZ4, hash, write to .part
 *                                ←  ack {id,bytes}           (every 1 MB / 300 ms)
 *   fin {id,sha256}               →
 *                                ←  done {id,ok}             (hash verified, file final)
 *
 * RESUME: if either side drops mid-transfer the job pauses for up to
 * 10 minutes. When the same identity reconnects, the sender re-offers
 * with epoch+1 and the receiver accepts from the bytes it already has.
 * A new epoch means a new key, so no nonce is ever reused.
 */

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const bolt = require('./bolt');

const MSG_FILE_START = 0x20, MSG_FILE_CHUNK = 0x21, MSG_FILE_END = 0x22;

const MAX_SEND_BYTES   = 4 * 1024 * 1024 * 1024;       // 4 GB
const MAX_RECV_BYTES   = 4 * 1024 * 1024 * 1024;
const MAX_BYTES_SOURCE = 512 * 1024 * 1024;            // pasted/clipboard data held in RAM
const DISK_HEADROOM    = 512 * 1024 * 1024;
const MAX_INCOMING     = 8;
const MAX_INCOMING_PER_PEER = 3;
const OFFER_TIMEOUT_MS = 30_000;
const RESUME_WINDOW_MS = 10 * 60_000;
const ACK_BYTES        = 1024 * 1024;
const ACK_MS           = 300;
const PROGRESS_MS      = 150;
const WRITE_HIGH       = 16 * 1024 * 1024;             // pause socket reads above this
const WRITE_LOW        = 4 * 1024 * 1024;
const RETAIN_DAYS      = 30;

// LEGACY: receivers on the JSON path over-count base64 padding by up to 2 bytes
// per chunk and abort when the total passes the announced size. A chunk
// size divisible by 3 has no padding, so only the last chunk can
// over-count (≤ 2) — announcing size + 2 absorbs it. Their integrity
// check uses the END message's exact `bytes`, so nothing else changes.
const LEGACY_CHUNK = 524286;          // 512 KiB − 2, divisible by 3
const LEGACY_SLACK = 2;
const LEGACY_MAX   = 512 * 1024 * 1024 - LEGACY_SLACK;

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

function safeName(name) {
  let s = String(name || 'file').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim();
  s = s.replace(/^\.+/, '_').slice(0, 180);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  return s || 'file';
}

class TransferManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./network')} o.network
   * @param {string} o.dir            base directory for received files
   * @param {() => string} o.myFingerprint
   * @param {() => string} o.myNickname
   */
  constructor({ network, dir, myFingerprint, myNickname, log, vault }) {
    super();
    // received files are written encrypted (vault records) and only
    // decrypted when the user saves / previews them.
    this.vault = vault || null;
    this.net = network;
    this.dir = dir;
    this.myFp = myFingerprint;
    this.myNick = myNickname || (() => '');
    this.log = log || (() => {});
    this.outgoing = new Map();     // id -> out
    this.incoming = new Map();     // fp:id -> rec  (BOLT)
    this.bySid = new Map();        // pid:sid -> rec
    this.legacyIn = new Map();     // pid:fileId -> rec
    this.index = {};               // id -> finished received file
    this.sent = new Map();         // id -> { path | bytes, name, size }  (session only)
    this._wire();
  }

  // ═════════════════════════════════════════════════════════════════
  //  setup
  // ═════════════════════════════════════════════════════════════════
  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fsp.readFile(this._indexPath(), 'utf8');
      this.index = JSON.parse(this.vault && this.vault.isSealed(raw) ? this.vault.open(raw) : raw) || {};
    } catch (e) { this.index = {}; }
    // Drop stale partials and anything past retention.
    const now = Date.now();
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch (e) {}
    for (const n of names) {
      if (!n.endsWith('.part')) continue;
      try { const st = await fsp.stat(path.join(this.dir, n)); if (now - st.mtimeMs > 24 * 3600e3) await fsp.unlink(path.join(this.dir, n)); } catch (e) {}
    }
    for (const [id, e] of Object.entries(this.index)) {
      const old = now - (e.at || 0) > RETAIN_DAYS * 86400e3;
      if (old) { try { require('./vault').shred(e.path); } catch (x) {} }
      if (old || !fs.existsSync(e.path)) delete this.index[id];
    }
    await this._saveIndex();
  }

  _indexPath() { return path.join(this.dir, 'index.json'); }
  async _saveIndex() {
    try {
      const json = JSON.stringify(this.index);
      await fsp.writeFile(this._indexPath(), this.vault ? this.vault.seal(json) : json);
    } catch (e) {}
  }

  _wire() {
    const n = this.net;
    n.on('bolt-ctl',     (m) => { try { this._onCtl(m); } catch (e) { this.log('ctl error', e); } });
    n.on('bolt-frame',   (f) => { try { this._onFrame(f); } catch (e) { this.log('frame error', e); } });
    n.on('file-transfer',(f) => { try { this._onLegacy(f); } catch (e) { this.log('legacy error', e); } });
    n.on('peer-left',    (p) => this._onPeerLeft(p && p.peerId));
    n.on('session-ready',(p) => this._onSessionReady(p));
  }

  _ev(o) { this.emit('event', o); }

  // ═════════════════════════════════════════════════════════════════
  //  SENDING
  // ═════════════════════════════════════════════════════════════════
  /**
   * @param {{room:string, channel?:string, path?:string, bytes?:Uint8Array, name?:string}} req
   */
  async send(req) {
    const room = String(req.room || '');
    if (!room) return { ok: false, error: 'no room' };
    let size, src;
    if (req.path) {
      let st;
      try { st = await fsp.stat(req.path); } catch (e) { return { ok: false, error: 'file not readable' }; }
      if (!st.isFile()) return { ok: false, error: 'not a file' };
      size = st.size;
      src = { path: req.path };
    } else if (req.bytes) {
      const b = Buffer.from(req.bytes.buffer ? Buffer.from(req.bytes.buffer, req.bytes.byteOffset || 0, req.bytes.byteLength) : req.bytes);
      if (b.length > MAX_BYTES_SOURCE) return { ok: false, error: 'too large to send from memory — drop the file instead' };
      size = b.length;
      src = { bytes: b };
    } else return { ok: false, error: 'nothing to send' };
    if (size > MAX_SEND_BYTES) return { ok: false, error: 'file larger than 4 GB' };

    const id = rid(8);
    const name = safeName(req.name || (req.path ? path.basename(req.path) : 'file'));
    const out = {
      id, room, channel: String(req.channel || 'default'), name, size, src,
      jobs: new Map(), startedAt: Date.now(), cancelled: false, lastProgressAt: 0, finished: false,
    };
    this.outgoing.set(id, out);
    this.sent.set(id, { ...src, name, size });

    const targets = this.net.peersInRoom(room);
    this._ev({ ev: 'begin', dir: 'send', id, name, size, room, channel: out.channel, recipients: targets.length });

    for (const pid of targets) this._startJob(out, pid);
    if (!targets.length) this._finishOut(out);
    return { ok: true, id, name, size, recipients: targets.length };
  }

  _startJob(out, pid) {
    const info = this.net.peerInfo(pid) || {};
    const job = {
      pid, fp: info.fingerprint || '', nick: info.nickname || pid,
      mode: this.net.peerHasCap(pid, bolt.CAP) ? 'bolt' : 'legacy',
      state: 'offered', epoch: 0, sid: crypto.randomBytes(4).readUInt32LE(0),
      sent: 0, acked: 0, gen: 0, pausedTimer: null, offerTimer: null, ratio: 1, reason: '',
    };
    out.jobs.set(pid, job);
    if (job.mode === 'legacy') {
      if (out.size > LEGACY_MAX) { this._jobEnd(out, job, false, 'recipient has no BOLT support (files over 512 MB need it)'); return; }
      this._runLegacy(out, job).catch(e => this._jobEnd(out, job, false, 'send error: ' + (e && e.message || e)));
      return;
    }
    this._offer(out, job);
  }

  _offer(out, job) {
    job.state = 'offered';
    clearTimeout(job.offerTimer);
    job.offerTimer = setTimeout(() => {
      if (job.state === 'offered') this._jobEnd(out, job, false, 'no response from recipient');
    }, OFFER_TIMEOUT_MS);
    // Fresh salt per offer: the transfer key depends on it, and it only
    // ever travels inside the sealed, ratcheted session.
    job.salt = crypto.randomBytes(32).toString('base64');
    this.net.sendBoltCtl(job.pid, {
      op: 'offer', v: 1, id: out.id, sid: job.sid, epoch: job.epoch, k: job.salt,
      name: out.name, size: out.size, room: out.room, channel: out.channel, chunk: bolt.CHUNK,
    });
  }

  async _openSource(out) {
    if (out.src.bytes) {
      const b = out.src.bytes;
      return { read: async (pos, len) => b.subarray(pos, pos + len), close: async () => {} };
    }
    const fh = await fsp.open(out.src.path, 'r');
    return {
      read: async (pos, len) => {
        const buf = Buffer.allocUnsafe(len);
        let got = 0;
        while (got < len) {
          const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
          if (!bytesRead) throw new Error('file shrank while sending');
          got += bytesRead;
        }
        return buf;
      },
      close: async () => { try { await fh.close(); } catch (e) {} },
    };
  }

  async _stream(out, job, from) {
    const gen = ++job.gen;
    const live = () => gen === job.gen && job.state === 'sending' && !out.cancelled;
    const myFp = this.myFp();
    let key;
    try { key = this.net.boltKey(job.pid, bolt.keyLabel(myFp, out.id, job.epoch), job.salt); }
    catch (e) { return this._pauseJob(out, job, 'no session'); }

    const src = await this._openSource(out);
    try {
      const hash = crypto.createHash('sha256');
      // Resuming: the hash covers the whole file, so fold in what they
      // already have. Sequential read — fast even for gigabytes.
      for (let p = 0; p < from; ) {
        const n = Math.min(4 * 1024 * 1024, from - p);
        hash.update(await src.read(p, n)); p += n;
        if (!live()) return;
      }
      const comp = new bolt.Compressor(out.name);
      let pos = from;
      let seq = Math.floor(from / bolt.CHUNK);
      job.sent = from;
      while (pos < out.size) {
        if (!live()) return;
        const len = Math.min(bolt.CHUNK, out.size - pos);
        const chunk = await src.read(pos, len);
        hash.update(chunk);
        const { flags, data } = comp.pack(chunk);
        const frame = bolt.sealFrame(key, job.sid, seq, flags | (pos + len >= out.size ? bolt.F_LAST : 0), data);
        if (!(await this.net.sendBoltFrame(job.pid, frame))) return;   // peer gone → peer-left pauses us
        if (!live()) return;
        pos += len; seq++;
        job.sent = pos;
        this._progressOut(out);
      }
      job.ratio = comp.ratio;
      job.state = 'finishing';
      this.net.sendBoltCtl(job.pid, { op: 'fin', id: out.id, epoch: job.epoch, sha256: hash.digest('hex'), bytes: out.size, ratio: comp.ratio });
    } finally {
      await src.close();
    }
  }

  async _runLegacy(out, job) {
    job.state = 'sending';
    const total = Math.max(1, Math.ceil(out.size / LEGACY_CHUNK));
    const base = { room: out.room, channel: out.channel, fileId: out.id };
    const pid = job.pid;
    const ok0 = await this.net.sendLegacyFileTo(pid, MSG_FILE_START, {
      ...base, fileName: out.name, fileSize: out.size + LEGACY_SLACK, totalChunks: total,
      sender: this.myNick(), fingerprint: this.myFp(),
    });
    if (!ok0) return this._jobEnd(out, job, false, 'recipient went offline');
    const src = await this._openSource(out);
    const hash = crypto.createHash('sha256');
    try {
      for (let i = 0; i < total; i++) {
        if (out.cancelled || job.state !== 'sending') {
          // Tell the old client to discard: an END with chunks missing.
          await this.net.sendLegacyFileTo(pid, MSG_FILE_END, { ...base, hash: '', bytes: out.size });
          return;
        }
        const pos = i * LEGACY_CHUNK;
        const len = Math.max(0, Math.min(LEGACY_CHUNK, out.size - pos));
        const chunk = len ? await src.read(pos, len) : Buffer.alloc(0);
        hash.update(chunk);
        if (!(await this.net.sendLegacyFileTo(pid, MSG_FILE_CHUNK, { ...base, index: i, data: chunk.toString('base64') }))) {
          return this._jobEnd(out, job, false, 'recipient went offline (older clients cannot resume)');
        }
        job.sent = pos + len;
        job.acked = job.sent;           // no ACKs on the legacy path; best we know
        this._progressOut(out);
      }
      await this.net.sendLegacyFileTo(pid, MSG_FILE_END, { ...base, hash: hash.digest('hex'), bytes: out.size });
      this._jobEnd(out, job, true, '', { unconfirmed: true });
    } finally {
      await src.close();
    }
  }

  _progressOut(out, force) {
    const now = Date.now();
    if (!force && now - out.lastProgressAt < PROGRESS_MS) return;
    out.lastProgressAt = now;
    let acked = 0, sent = 0, n = 0;
    for (const j of out.jobs.values()) {
      if (j.state === 'failed') continue;
      acked += (j.state === 'done' ? out.size : j.acked); sent += j.sent; n++;
    }
    const delivered = n ? acked / n : 0;
    const elapsed = Math.max(0.001, (now - out.startedAt) / 1000);
    this._ev({
      ev: 'progress', dir: 'send', id: out.id,
      bytes: Math.round(delivered), total: out.size,
      rate: Math.round((n ? sent / n : 0) / elapsed),
      recipients: out.jobs.size,
      done: [...out.jobs.values()].filter(j => j.state === 'done').length,
    });
  }

  _pauseJob(out, job, why) {
    if (job.state === 'done' || job.state === 'failed') return;
    job.state = 'paused';
    job.gen++;
    clearTimeout(job.offerTimer);
    clearTimeout(job.pausedTimer);
    job.pausedTimer = setTimeout(() => {
      if (job.state === 'paused') this._jobEnd(out, job, false, 'recipient did not come back');
    }, RESUME_WINDOW_MS);
    this._ev({ ev: 'paused', dir: 'send', id: out.id, peer: job.nick, reason: why || 'recipient went offline' });
  }

  _jobEnd(out, job, ok, reason, extra) {
    if (job.state === 'done' || job.state === 'failed') return;
    job.state = ok ? 'done' : 'failed';
    job.reason = reason || '';
    job.gen++;
    clearTimeout(job.offerTimer);
    clearTimeout(job.pausedTimer);
    this._ev({ ev: 'delivered', id: out.id, peer: job.nick, fingerprint: job.fp, ok, reason: job.reason, unconfirmed: !!(extra && extra.unconfirmed), ratio: job.ratio });
    this._progressOut(out, true);
    if ([...out.jobs.values()].every(j => j.state === 'done' || j.state === 'failed')) this._finishOut(out);
  }

  _finishOut(out) {
    if (out.finished) return;
    out.finished = true;
    const jobs = [...out.jobs.values()];
    this._ev({
      ev: 'complete', dir: 'send', id: out.id, name: out.name, size: out.size,
      room: out.room, channel: out.channel,
      recipients: jobs.length,
      delivered: jobs.filter(j => j.state === 'done').length,
      failures: jobs.filter(j => j.state === 'failed').map(j => ({ peer: j.nick, reason: j.reason })),
      cancelled: out.cancelled,
      elapsedMs: Date.now() - out.startedAt,
    });
    this.outgoing.delete(out.id);
    if (out.src.bytes && !out.cancelled) { /* keep for SAVE this session */ }
  }

  // ═════════════════════════════════════════════════════════════════
  //  RECEIVING (BOLT)
  // ═════════════════════════════════════════════════════════════════
  async _onCtl({ peerId: pid, fingerprint: fp, nickname, obj }) {
    const op = obj.op;
    // ── sender side ──
    if (op === 'accept' || op === 'decline' || op === 'ack' || op === 'done' || (op === 'cancel' && obj.from === 'recipient')) {
      const out = this.outgoing.get(obj.id);
      if (!out) return;
      const job = [...out.jobs.values()].find(j => j.pid === pid);
      if (!job) return;
      if (op === 'accept') {
        if (job.state !== 'offered' || (obj.epoch | 0) !== job.epoch) return;
        clearTimeout(job.offerTimer);
        const from = Number(obj.from) || 0;
        if (!Number.isInteger(from) || from < 0 || from > out.size || (from % bolt.CHUNK && from !== out.size)) {
          return this._jobEnd(out, job, false, 'bad resume offset');
        }
        job.state = 'sending';
        job.acked = from;
        this._stream(out, job, from).catch(e => this._jobEnd(out, job, false, 'send error: ' + (e && e.message || e)));
      } else if (op === 'decline') {
        this._jobEnd(out, job, false, 'declined: ' + String(obj.reason || '').slice(0, 80));
      } else if (op === 'ack') {
        const b = Number(obj.bytes);
        if (Number.isFinite(b) && b >= job.acked && b <= out.size) { job.acked = b; this._progressOut(out); }
      } else if (op === 'done') {
        if (obj.ok) { job.acked = out.size; this._jobEnd(out, job, true); }
        else this._jobEnd(out, job, false, String(obj.reason || 'rejected').slice(0, 80));
      } else if (op === 'cancel') {
        this._jobEnd(out, job, false, 'cancelled by recipient');
      }
      return;
    }

    // ── receiver side ──
    if (op === 'offer') return this._onOffer(pid, fp, nickname, obj);
    const rec = this.incoming.get(fp + ':' + obj.id);
    if (!rec || rec.pid !== pid) return;
    if (op === 'fin') return this._onFin(rec, obj);
    if (op === 'cancel') return this._failIn(rec, 'cancelled by sender', { notify: false });
  }

  async _onOffer(pid, fp, nickname, o) {
    const decline = (reason) => this.net.sendBoltCtl(pid, { op: 'decline', id: o.id, reason });
    if (typeof o.id !== 'string' || !/^[0-9a-f]{8,32}$/.test(o.id)) return;
    if ((o.chunk | 0) !== bolt.CHUNK) return decline('unsupported chunk size');
    if (typeof o.k !== 'string' || Buffer.from(o.k, 'base64').length !== 32) return decline('sender needs to update Sirr');
    const size = Number(o.size);
    if (!Number.isInteger(size) || size < 0) return decline('bad size');
    const epoch = o.epoch | 0;
    const key = fp + ':' + o.id;
    let rec = this.incoming.get(key);

    if (rec) {
      // Resume (or a duplicate offer). Must be the same file from the same sender.
      if (rec.size !== size || epoch <= rec.epoch) return;
      if (rec.state === 'finalizing' || rec.state === 'done') return;
      await rec.queue;                               // everything enqueued is on disk
      this.bySid.delete(rec.pid + ':' + rec.sid);
      clearTimeout(rec.pausedTimer);
      rec.pid = pid; rec.sid = o.sid >>> 0; rec.epoch = epoch; rec.state = 'receiving';
      rec.key = this.net.boltKey(pid, bolt.keyLabel(fp, o.id, epoch), o.k);
      this.bySid.set(pid + ':' + rec.sid, rec);
      this._ev({ ev: 'resumed', dir: 'recv', id: rec.id, from: rec.enqueued });
      this.net.sendBoltCtl(pid, { op: 'accept', id: o.id, epoch, from: rec.enqueued });
      return;
    }

    if (size > MAX_RECV_BYTES) return decline('too large');
    if (this.incoming.size >= MAX_INCOMING) return decline('busy');
    if ([...this.incoming.values()].filter(r => r.fp === fp).length >= MAX_INCOMING_PER_PEER) return decline('busy');
    try {
      const st = await fsp.statfs(this.dir);
      if (st.bavail * st.bsize < size + DISK_HEADROOM) return decline('recipient is low on disk space');
    } catch (e) { /* statfs unavailable: proceed */ }

    const partPath = path.join(this.dir, o.id + '-' + fp.slice(0, 8) + '.part');
    let fh;
    try { fh = await fsp.open(partPath, 'w'); } catch (e) { return decline('cannot write'); }
    const writer = this.vault ? this.vault.fileWriter(fh) : null;
    rec = {
      writer,
      key: null, id: o.id, pid, fp, nick: String(nickname || '').slice(0, 32),
      name: safeName(o.name), size, room: String(o.room || ''), channel: String(o.channel || 'default'),
      sid: o.sid >>> 0, epoch, enqueued: 0, written: 0, pending: 0,
      hash: crypto.createHash('sha256'), fh, partPath, queue: Promise.resolve(),
      state: 'receiving', startedAt: Date.now(), lastAckAt: 0, lastAckBytes: 0, lastProgressAt: 0,
      readPaused: false, pausedTimer: null, mode: 'bolt',
    };
    rec.key = this.net.boltKey(pid, bolt.keyLabel(fp, o.id, epoch), o.k);
    this.incoming.set(key, rec);
    this.bySid.set(pid + ':' + rec.sid, rec);
    this._ev({ ev: 'begin', dir: 'recv', id: rec.id, name: rec.name, size, room: rec.room, channel: rec.channel,
               from: { peerId: pid, nickname: rec.nick, fingerprint: fp } });
    this.net.sendBoltCtl(pid, { op: 'accept', id: o.id, epoch, from: 0 });
  }

  _onFrame({ peerId: pid, hdr, header, payload }) {
    if (hdr.type !== bolt.T_DATA) return;
    const rec = this.bySid.get(pid + ':' + hdr.sid);
    if (!rec || rec.state !== 'receiving') return;
    const expectSeq = Math.floor(rec.enqueued / bolt.CHUNK);
    const expectLen = Math.min(bolt.CHUNK, rec.size - rec.enqueued);
    if (hdr.seq !== expectSeq || expectLen <= 0) return this._failIn(rec, 'out-of-order data');
    let data;
    try {
      const plain = bolt.openFrame(rec.key, hdr, header, payload);
      data = bolt.unpack(hdr.flags, plain, expectLen);
    } catch (e) {
      return this._failIn(rec, 'data failed authentication');
    }
    rec.hash.update(data);
    const pos = rec.enqueued;
    rec.enqueued += data.length;
    this._write(rec, data, pos);

    const now = Date.now();
    if (rec.enqueued - rec.lastAckBytes >= ACK_BYTES || now - rec.lastAckAt >= ACK_MS || rec.enqueued === rec.size) {
      rec.lastAckAt = now; rec.lastAckBytes = rec.enqueued;
      this.net.sendBoltCtl(pid, { op: 'ack', id: rec.id, bytes: rec.enqueued });
    }
    this._progressIn(rec);
  }

  _write(rec, data, pos) {
    rec.pending += data.length;
    if (!rec.readPaused && rec.pending > WRITE_HIGH) { rec.readPaused = true; this.net.pausePeer(rec.pid); }
    rec.queue = rec.queue.then(async () => {
      if (!rec.fh) { rec.writeError = rec.writeError || new Error('no file handle'); return; }
      if (rec.writer) {
        await rec.writer.append(data);          // in-order; offsets implied by record order
      } else {
        let off = 0;
        while (off < data.length) {
          const { bytesWritten } = await rec.fh.write(data, off, data.length - off, pos + off);
          off += bytesWritten;
        }
      }
      rec.written += data.length;
    }).catch(e => { rec.writeError = e; }).finally(() => {
      rec.pending -= data.length;
      if (rec.readPaused && rec.pending < WRITE_LOW) { rec.readPaused = false; this.net.resumePeer(rec.pid); }
    });
  }

  _progressIn(rec, force) {
    const now = Date.now();
    if (!force && now - rec.lastProgressAt < PROGRESS_MS) return;
    rec.lastProgressAt = now;
    const elapsed = Math.max(0.001, (now - rec.startedAt) / 1000);
    this._ev({ ev: 'progress', dir: 'recv', id: rec.id, bytes: rec.enqueued, total: rec.size, rate: Math.round(rec.enqueued / elapsed) });
  }

  async _onFin(rec, o) {
    if (rec.state !== 'receiving' || (o.epoch | 0) !== rec.epoch) return;
    rec.state = 'finalizing';
    await rec.queue;
    if (rec.writeError) return this._failIn(rec, 'disk write failed');
    if (rec.enqueued !== rec.size || Number(o.bytes) !== rec.size) return this._failIn(rec, 'incomplete');
    const digest = rec.hash.digest('hex');
    if (typeof o.sha256 !== 'string' || o.sha256 !== digest) return this._failIn(rec, 'integrity check failed');
    await this._finalize(rec, { verified: true, sha256: digest, ratio: Number(o.ratio) || 1 });
    this.net.sendBoltCtl(rec.pid, { op: 'done', id: rec.id, ok: true });
  }

  async _finalize(rec, { verified, sha256, ratio }) {
    try { await rec.fh.sync(); } catch (e) {}
    try { await rec.fh.close(); } catch (e) {}
    rec.fh = null;
    const finalPath = path.join(this.dir, rec.id + '__' + rec.name);
    try { await fsp.rename(rec.partPath, finalPath); }
    catch (e) { return this._failIn(rec, 'could not store file'); }
    rec.state = 'done';
    this._forgetIn(rec);
    this.index[rec.id] = {
      name: rec.name, size: rec.size, path: finalPath, sha256, verified, enc: !!rec.writer,
      from: { nickname: rec.nick, fingerprint: rec.fp }, room: rec.room, channel: rec.channel, at: Date.now(),
    };
    this._saveIndex();
    this._ev({
      ev: 'complete', dir: 'recv', id: rec.id, name: rec.name, size: rec.size,
      room: rec.room, channel: rec.channel,
      from: { peerId: rec.pid, nickname: rec.nick, fingerprint: rec.fp },
      verified, ratio, elapsedMs: Date.now() - rec.startedAt, protocol: rec.mode,
    });
  }

  _forgetIn(rec) {
    clearTimeout(rec.pausedTimer);
    if (rec.mode === 'bolt') { this.incoming.delete(rec.fp + ':' + rec.id); this.bySid.delete(rec.pid + ':' + rec.sid); }
    else this.legacyIn.delete(rec.pid + ':' + rec.id);
    if (rec.readPaused) { rec.readPaused = false; this.net.resumePeer(rec.pid); }
  }

  async _failIn(rec, reason, { notify = true } = {}) {
    if (rec.state === 'failed' || rec.state === 'done') return;
    const wasBolt = rec.mode === 'bolt';
    rec.state = 'failed';
    this._forgetIn(rec);
    if (notify && wasBolt) this.net.sendBoltCtl(rec.pid, { op: 'done', id: rec.id, ok: false, reason });
    try { await rec.queue; } catch (e) {}
    try { if (rec.fh) await rec.fh.close(); } catch (e) {}
    rec.fh = null;
    try { await fsp.unlink(rec.partPath); } catch (e) {}
    this._ev({ ev: 'failed', dir: 'recv', id: rec.id, name: rec.name, reason });
  }

  // ═════════════════════════════════════════════════════════════════
  //  RECEIVING (the JSON path, which predates BOLT)
  // ═════════════════════════════════════════════════════════════════
  async _onLegacy(ft) {
    const pid = ft.peerId;
    const key = pid + ':' + ft.fileId;
    if (ft.aborted) {
      const rec = this.legacyIn.get(key);
      if (rec) this._failIn(rec, 'rejected (' + (ft.reason || 'invalid') + ')');
      return;
    }
    if (ft.msgType === MSG_FILE_START) {
      if (this.legacyIn.has(key)) return;
      if (typeof ft.fileId !== 'string' || !/^[0-9a-zA-Z]{4,40}$/.test(ft.fileId)) return;
      const total = Number(ft.totalChunks);
      const size = Number(ft.fileSize);
      if (!Number.isInteger(total) || total < 0 || !Number.isFinite(size) || size < 0) return;
      const partPath = path.join(this.dir, 'L' + ft.fileId + '-' + String(pid).slice(0, 8) + '.part');
      // Register SYNCHRONOUSLY: the chunks (and, for a small file, the END)
      // can arrive before an awaited open() would return. The open is the
      // first link of the write queue instead.
      const fh = null;
      const rec = {
        mode: 'legacy', id: ft.fileId, pid, fp: ft.fingerprint || '', nick: String(ft.sender || ft.nickname || '').slice(0, 32),
        name: safeName(ft.fileName), size, total, room: ft.room, channel: ft.channel || 'default',
        next: 0, parked: new Map(), enqueued: 0, written: 0, pending: 0,
        hash: crypto.createHash('sha256'), fh, partPath, queue: Promise.resolve(),
        state: 'receiving', startedAt: Date.now(), lastProgressAt: 0, readPaused: false,
      };
      rec.queue = fsp.open(partPath, 'w').then(h => { rec.fh = h; rec.writer = this.vault ? this.vault.fileWriter(h) : null; }, e => { rec.writeError = e; });
      this.legacyIn.set(key, rec);
      this._ev({ ev: 'begin', dir: 'recv', id: rec.id, name: rec.name, size, room: rec.room, channel: rec.channel,
                 from: { peerId: pid, nickname: rec.nick, fingerprint: rec.fp }, legacy: true });
      return;
    }
    const rec = this.legacyIn.get(key);
    if (!rec || rec.state !== 'receiving') return;
    if (ft.msgType === MSG_FILE_CHUNK) {
      if (!Number.isInteger(ft.index) || ft.index < rec.next || ft.index >= rec.total || typeof ft.data !== 'string') return;
      rec.parked.set(ft.index, ft.data);
      if (rec.parked.size > 8) return this._failIn(rec, 'out-of-order data');
      while (rec.parked.has(rec.next)) {
        const buf = Buffer.from(rec.parked.get(rec.next), 'base64');
        rec.parked.delete(rec.next);
        rec.hash.update(buf);
        this._write(rec, buf, rec.enqueued);
        rec.enqueued += buf.length;
        rec.next++;
      }
      rec.size = Math.max(rec.size, rec.enqueued);
      this._progressIn(rec);
      return;
    }
    if (ft.msgType === MSG_FILE_END) {
      rec.state = 'finalizing';
      await rec.queue;
      if (rec.writeError) return this._failIn(rec, 'disk write failed');
      if (rec.next !== rec.total) { rec.state = 'receiving'; return this._failIn(rec, 'incomplete (' + rec.next + '/' + rec.total + ' chunks)'); }
      const exact = Number(ft.bytes);
      if (Number.isFinite(exact) && exact >= 0 && exact !== rec.enqueued) { rec.state = 'receiving'; return this._failIn(rec, 'size mismatch'); }
      rec.size = rec.enqueued;
      const digest = rec.hash.digest('hex');
      let verified = null;                                  // old senders hash only files ≤ 50 MB
      if (ft.hash) {
        verified = ft.hash === digest;
        if (!verified) { rec.state = 'receiving'; return this._failIn(rec, 'integrity check failed'); }
      }
      await this._finalize(rec, { verified, sha256: digest, ratio: 1 });
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  peers coming and going
  // ═════════════════════════════════════════════════════════════════
  _onPeerLeft(pid) {
    if (!pid) return;
    for (const out of this.outgoing.values()) {
      for (const job of out.jobs.values()) {
        if (job.pid !== pid || job.state === 'done' || job.state === 'failed') continue;
        if (job.mode === 'legacy') this._jobEnd(out, job, false, 'recipient went offline (older clients cannot resume)');
        else this._pauseJob(out, job, 'recipient went offline — will resume when they reconnect');
      }
    }
    for (const rec of [...this.incoming.values()]) {
      if (rec.pid !== pid || rec.state !== 'receiving') continue;
      rec.state = 'paused';
      this.bySid.delete(rec.pid + ':' + rec.sid);
      if (rec.readPaused) { rec.readPaused = false; }
      rec.pausedTimer = setTimeout(() => { rec.state = 'receiving'; this._failIn(rec, 'sender did not come back', { notify: false }); }, RESUME_WINDOW_MS);
      this._ev({ ev: 'paused', dir: 'recv', id: rec.id, reason: 'sender went offline — will resume when they reconnect' });
    }
    for (const rec of [...this.legacyIn.values()]) {
      if (rec.pid === pid) this._failIn(rec, 'sender went offline', { notify: false });
    }
  }

  _onSessionReady({ peerId: pid, fingerprint: fp }) {
    if (!pid || !fp) return;
    for (const out of this.outgoing.values()) {
      for (const job of out.jobs.values()) {
        if (job.state !== 'paused' || job.fp !== fp || job.mode !== 'bolt') continue;
        if (!this.net.peerHasCap(pid, bolt.CAP)) continue;
        clearTimeout(job.pausedTimer);
        job.pid = pid;
        job.epoch++;
        this._ev({ ev: 'resumed', dir: 'send', id: out.id, peer: job.nick });
        this._offer(out, job);
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════
  //  user actions
  // ═════════════════════════════════════════════════════════════════
  cancel(id) {
    const out = this.outgoing.get(id);
    if (out) {
      out.cancelled = true;
      for (const job of out.jobs.values()) {
        if (job.state === 'done' || job.state === 'failed') continue;
        if (job.mode === 'bolt') this.net.sendBoltCtl(job.pid, { op: 'cancel', id, from: 'sender' });
        const wasLegacySending = job.mode === 'legacy' && job.state === 'sending';
        this._jobEnd(out, job, false, 'cancelled');
        if (wasLegacySending) { /* _runLegacy notices and sends a discarding END */ }
      }
      this._finishOut(out);
      return true;
    }
    for (const rec of [...this.incoming.values(), ...this.legacyIn.values()]) {
      if (rec.id !== id) continue;
      if (rec.mode === 'bolt') this.net.sendBoltCtl(rec.pid, { op: 'cancel', id, from: 'recipient' });
      this._failIn(rec, 'cancelled', { notify: false });
      return true;
    }
    return false;
  }

  /** Where a finished file lives: received files, or what we sent this session. */
  locate(id) {
    const e = this.index[id];
    if (e && fs.existsSync(e.path)) return { path: e.path, name: e.name, size: e.size, enc: !!e.enc };
    const s = this.sent.get(id);
    if (s && s.path && fs.existsSync(s.path)) return { path: s.path, name: s.name, size: s.size };
    if (s && s.bytes) return { bytes: s.bytes, name: s.name, size: s.size };
    return null;
  }

  async saveTo(id, dest) {
    const loc = this.locate(id);
    if (!loc) return { ok: false, error: 'file no longer available' };
    if (loc.bytes) await fsp.writeFile(dest, loc.bytes);
    else if (loc.enc && this.vault) await this.vault.decryptFileTo(loc.path, dest);
    else await fsp.copyFile(loc.path, dest);
    return { ok: true, path: dest };
  }

  async read(id, max) {
    const loc = this.locate(id);
    if (!loc) return null;
    if (loc.size > max) return null;
    if (loc.bytes) return Buffer.from(loc.bytes);
    if (loc.enc && this.vault) return await this.vault.readFile(loc.path, max);
    return await fsp.readFile(loc.path);
  }

  shutdown() {
    for (const rec of [...this.incoming.values(), ...this.legacyIn.values()]) {
      try { rec.fh && rec.fh.close(); } catch (e) {}
    }
  }
}

TransferManager.safeName = safeName;
TransferManager.LEGACY_CHUNK = LEGACY_CHUNK;
module.exports = TransferManager;
