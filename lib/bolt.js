'use strict';
/**
 * BOLT — Binary Optimized Link Transfer, as spoken inside Sirr (v1)
 * ═══════════════════════════════════════════════════════════════════
 * The original BOLT was a UDP protocol: 14-byte binary header, raw
 * payloads, LZ4, selective ACK and FEC for lossy long-range links.
 * Inside Sirr it rides the Hyperswarm stream the chat already uses,
 * which is reliable, ordered and Noise-encrypted — so SACK and FEC have
 * nothing to do and are left out. What carries over is everything that
 * was slow about the JSON transfer path:
 *
 *   JSON line per chunk, base64 (+33%)  →  14-byte header, raw bytes
 *   no compression                      →  adaptive LZ4 per chunk
 *   whole file buffered in RAM          →  streamed straight to disk
 *   hash only for files ≤ 50 MB         →  SHA-256 on every file
 *   restart from zero on a drop         →  resume from the last byte
 *   "sent" = written to our socket      →  "delivered" = ACKed by them
 *
 * WIRE FORMAT (same 14-byte layout as BOLT/UDP, little-endian)
 *
 *    0      2     3      4            8            12      14
 *   +------+-----+------+------------+------------+-------+-----------
 *   | B0 17| V|T | flags| session id | sequence   |  len  | payload…
 *   +------+-----+------+------------+------------+-------+-----------
 *   V = version (1), T = type (1 = DATA), flags: 0x01 LZ4, 0x02 LAST
 *   payload = AES-256-GCM(chunk) ‖ 16-byte tag, AAD = the header
 *
 * Frames and the existing newline-delimited JSON share one socket. A
 * JSON line always starts with '{'; a frame always starts with 0xB0, so
 * the reader can tell them apart byte-for-byte. Frames are only sent to
 * peers that advertised the `bolt1` capability, so older clients never
 * see a byte they can't parse.
 *
 * KEYS: per transfer and per resume epoch,
 *   k = HMAC-SHA256(session key, "sirr/bolt/1|" sender-fp "|" id "|" epoch)
 * where the session key is the same identity-bound, forward-secret key
 * the chat uses. Nonce = seq ‖ session id ‖ 0 — unique
 * per key because every (key, seq) pair is used once.
 */

const crypto = require('crypto');
const lz4 = require('./lz4');

const MAGIC0 = 0xB0, MAGIC1 = 0x17;
const VERSION = 1;
const HDR = 14;
const TAG = 16;
const T_DATA = 1;
const F_LZ4 = 0x01, F_LAST = 0x02;
const CHUNK = 60 * 1024;                   // 61440 raw bytes/frame, fits u16 len with tag
const MAX_PAYLOAD = CHUNK + TAG;
const CAP = 'bolt1';

// ─── keys & AEAD ───────────────────────────────────────────────────
function keyLabel(senderFp, id, epoch) {
  return 'sirr/bolt/1|' + senderFp + '|' + id + '|' + (epoch | 0);
}
function deriveKey(sessionKey, senderFp, id, epoch) {
  return crypto.createHmac('sha256', Buffer.from(sessionKey)).update(keyLabel(senderFp, id, epoch)).digest();
}

function nonceFor(sid, seq) {
  const n = Buffer.alloc(12);
  n.writeUInt32LE(seq >>> 0, 0);
  n.writeUInt32LE(sid >>> 0, 4);
  return n;
}

function writeHeader(buf, type, flags, sid, seq, len) {
  buf[0] = MAGIC0; buf[1] = MAGIC1;
  buf[2] = (VERSION << 4) | (type & 15);
  buf[3] = flags & 255;
  buf.writeUInt32LE(sid >>> 0, 4);
  buf.writeUInt32LE(seq >>> 0, 8);
  buf.writeUInt16LE(len, 12);
}

/**
 * Build one encrypted DATA frame.
 * @returns {Buffer} header ‖ ciphertext ‖ tag
 */
function sealFrame(key, sid, seq, flags, plain) {
  const len = plain.length + TAG;
  if (len > 0xFFFF) throw new Error('bolt: payload too large');
  const out = Buffer.allocUnsafe(HDR + len);
  writeHeader(out, T_DATA, flags, sid, seq, len);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(sid, seq), { authTagLength: TAG });
  c.setAAD(out.subarray(0, HDR));
  const a = c.update(plain);
  const b = c.final();
  a.copy(out, HDR);
  if (b.length) b.copy(out, HDR + a.length);
  c.getAuthTag().copy(out, HDR + plain.length);
  return out;
}

/** @returns {Buffer} plaintext, or throws if forged / corrupted */
function openFrame(key, hdr, headerBytes, payload) {
  if (payload.length < TAG) throw new Error('bolt: short payload');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(hdr.sid, hdr.seq), { authTagLength: TAG });
  d.setAAD(headerBytes);
  d.setAuthTag(payload.subarray(payload.length - TAG));
  const a = d.update(payload.subarray(0, payload.length - TAG));
  const b = d.final();                     // throws on auth failure
  return b.length ? Buffer.concat([a, b]) : a;
}

// ─── adaptive compression ─────────────────────────────────────────
// Already-compressed formats: LZ4 would only burn CPU.
const INCOMPRESSIBLE_EXT = new Set(('zip rar 7z gz tgz bz2 xz zst lz4 br ' +
  'jpg jpeg png gif webp avif heic heif jxl ' +
  'mp3 aac m4a ogg opus flac wma ' +
  'mp4 m4v mkv webm mov avi wmv flv ' +
  'pdf docx xlsx pptx odt ods odp epub apk ipa jar msi dmg iso cab woff woff2').split(' '));

class Compressor {
  constructor(name) {
    const ext = String(name || '').toLowerCase().split('.').pop();
    this.enabled = !INCOMPRESSIBLE_EXT.has(ext);
    this.misses = 0;          // consecutive chunks that didn't shrink
    this.skip = 0;            // chunks left to skip before probing again
    this.rawBytes = 0;
    this.wireBytes = 0;
    this.scratch = new Uint8Array(lz4.compressBound(CHUNK));
  }
  /** @returns {{flags:number, data:Buffer}} */
  pack(chunk) {
    this.rawBytes += chunk.length;
    if (this.enabled && this.skip === 0 && chunk.length >= 512) {
      const c = lz4.compress(chunk, this.scratch);
      if (c.length < chunk.length * 0.92) {
        this.misses = 0;
        this.wireBytes += c.length;
        return { flags: F_LZ4, data: Buffer.from(c) };
      }
      if (++this.misses >= 4) { this.skip = 64; this.misses = 0; }   // back off, probe again later
    } else if (this.skip > 0) {
      this.skip--;
    }
    this.wireBytes += chunk.length;
    return { flags: 0, data: chunk };
  }
  get ratio() { return this.rawBytes ? this.wireBytes / this.rawBytes : 1; }
}

function unpack(flags, plain, expectedLen) {
  if (flags & F_LZ4) return Buffer.from(lz4.decompress(plain, expectedLen));
  if (plain.length !== expectedLen) throw new Error('bolt: length mismatch');
  return plain;
}

// ─── stream demultiplexer ─────────────────────────────────────────
/**
 * Splits one socket's byte stream into JSON lines and BOLT frames.
 * Replaces the old string-concat line splitter: it works on bytes, so a
 * multi-byte UTF-8 character split across packets is decoded only once
 * its line is complete, and binary frames pass through untouched.
 */
class StreamDemux {
  constructor({ maxLine = 4 * 1024 * 1024, maxBuffer = 32 * 1024 * 1024 } = {}) {
    this.maxLine = maxLine;
    this.maxBuffer = maxBuffer;
    this.parts = [];
    this.len = 0;
    this.need = 0;          // bytes required before a parse attempt is useful
    this.scanned = 0;       // bytes already searched for '\n' (line mode)
  }

  /**
   * @param {Buffer} chunk
   * @param {(text:string)=>void} onLine
   * @param {(hdr:object, header:Buffer, payload:Buffer)=>void} onFrame
   * @returns {boolean} false if the stream is corrupt/hostile (drop peer)
   */
  push(chunk, onLine, onFrame) {
    if (!chunk || !chunk.length) return true;
    this.parts.push(chunk);
    this.len += chunk.length;
    if (this.len > this.maxBuffer) return false;
    if (this.need && this.len < this.need) return true;
    return this._drain(onLine, onFrame);
  }

  _flat() {
    if (this.parts.length > 1) this.parts = [Buffer.concat(this.parts, this.len)];
    return this.parts[0] || Buffer.alloc(0);
  }

  _drain(onLine, onFrame) {
    let buf = this._flat();
    let off = 0;
    this.need = 0;
    while (off < buf.length) {
      const b0 = buf[off];
      if (b0 === MAGIC0) {
        if (buf.length - off < HDR) { this.need = HDR; break; }
        if (buf[off + 1] !== MAGIC1 || (buf[off + 2] >>> 4) !== VERSION) return false;
        const len = buf.readUInt16LE(off + 12);
        if (buf.length - off < HDR + len) { this.need = HDR + len; break; }
        const header = buf.subarray(off, off + HDR);
        const hdr = {
          type: buf[off + 2] & 15, flags: buf[off + 3],
          sid: buf.readUInt32LE(off + 4), seq: buf.readUInt32LE(off + 8), len,
        };
        onFrame(hdr, header, buf.subarray(off + HDR, off + HDR + len));
        off += HDR + len;
        this.scanned = 0;
        continue;
      }
      const from = off + Math.max(0, this.scanned);
      const nl = buf.indexOf(0x0A, from);
      if (nl < 0) {
        this.scanned = buf.length - off;
        if (this.scanned > this.maxLine) return false;
        this.need = buf.length - off + 1;   // relative to the unconsumed remainder
        break;
      }
      this.scanned = 0;
      if (nl - off <= this.maxLine) {
        const text = buf.toString('utf8', off, nl);
        if (text.trim()) onLine(text);
      }
      off = nl + 1;
    }
    if (off >= buf.length) { this.parts = []; this.len = 0; this.scanned = 0; }
    else if (off > 0) {
      // Copy the remainder so the (possibly large) consumed prefix can be freed.
      const rest = Buffer.from(buf.subarray(off));
      this.parts = [rest]; this.len = rest.length;
    }
    return true;
  }
}

module.exports = {
  CAP, CHUNK, HDR, TAG, MAX_PAYLOAD, T_DATA, F_LZ4, F_LAST, VERSION,
  deriveKey, keyLabel, sealFrame, openFrame, Compressor, unpack, StreamDemux,
  INCOMPRESSIBLE_EXT,
};
