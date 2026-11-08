/**
 * Sirr Mesh Voice — wire format
 * ═══════════════════════════════════════════════════════════════════
 * A compact binary framing for encoded Opus frames, deliberately kept
 * free of any dependency on how the bytes actually travel. Today they
 * ride an unordered/unreliable RTCDataChannel; tomorrow they ride a
 * UDX stream. Neither this file nor the jitter buffer needs to know.
 *
 * ─── PACKET LAYOUT ───────────────────────────────────────────────
 *
 *   offset  size  field
 *   0       1     magic     0xP1 → 0xB1, cheap "is this ours" gate
 *   1       1     version   currently 1
 *   2       1     flags     bit0: redundancy present
 *   3       1     nFrames   1..4  (1 primary + up to 3 older copies)
 *   4       4     seq       uint32 BE, primary frame's sequence number
 *   8       4     tsMs      uint32 BE, capture timestamp, ms since call start
 *   12      ...   frames
 *
 *   each frame:
 *     0     1     seqDelta  0 = primary, k = the frame from seq-k
 *     1     2     len       uint16 BE
 *     3     len   payload   raw Opus packet
 *
 * Header is 12 bytes, each frame adds 3. At 96 kbit/s and 20 ms frames
 * a primary payload is ~240 bytes, so single-frame overhead is ~6%.
 *
 * ─── WHY seqDelta AND NOT AN ABSOLUTE SEQ ────────────────────────
 * Redundant copies are always recent — within a handful of frames — so
 * a byte is plenty, and it keeps the per-frame cost at 3 bytes rather
 * than 6. It also makes an out-of-range delta obviously corrupt.
 *
 * ─── ON THE "OBJECT/GROUP" SHAPE ─────────────────────────────────
 * This is NOT Media over QUIC and does not claim to be. But MoQ models
 * media as tracks → groups → objects, and a sequence-numbered,
 * independently-decodable, individually-addressable frame is exactly an
 * MoQ object. Keeping that shape means a future MoQ transport is a
 * re-encoding of the same units rather than a redesign. That is the
 * honest extent of the relationship.
 */

export const MAGIC   = 0xB1;
export const VERSION = 1;
export const HDR     = 12;
export const FRAME_HDR = 3;

export const FLAG_REDUNDANT = 0x01;

export const MAX_FRAMES   = 4;
export const MAX_PAYLOAD  = 1400;   // single-frame ceiling (decoder sanity bound)
export const MAX_PACKET   = HDR + MAX_FRAMES * (FRAME_HDR + MAX_PAYLOAD);
// what we actually put on the wire. An unreliable data channel
// fragments anything above the path MTU, and losing ANY fragment loses
// the whole message — so a 5 KB packet with three redundant copies was
// far more fragile than the single frame it was meant to protect.
// ~1150 bytes leaves room for SCTP/DTLS/UDP/IP headers on a 1280 path.
export const PACKET_BUDGET = 1150;

/**
 * Encode one packet.
 * @param {number} seq       sequence number of the primary frame
 * @param {number} tsMs      capture timestamp of the primary frame
 * @param {Array<{seqDelta:number, data:Uint8Array}>} frames
 *        frames[0] MUST be the primary (seqDelta 0). Older copies follow.
 * @returns {Uint8Array}
 */
export function encodePacket(seq, tsMs, frames) {
  if (!frames || !frames.length) throw new Error('no frames');
  if (frames.length > MAX_FRAMES) frames = frames.slice(0, MAX_FRAMES);

  let total = HDR;
  for (const f of frames) {
    if (f.data.length > MAX_PAYLOAD) throw new Error('frame too large');
    total += FRAME_HDR + f.data.length;
  }

  const buf = new Uint8Array(total);
  const dv  = new DataView(buf.buffer);
  buf[0] = MAGIC;
  buf[1] = VERSION;
  buf[2] = frames.length > 1 ? FLAG_REDUNDANT : 0;
  buf[3] = frames.length;
  dv.setUint32(4, seq >>> 0, false);
  dv.setUint32(8, tsMs >>> 0, false);

  let o = HDR;
  for (const f of frames) {
    buf[o] = f.seqDelta & 0xff;
    dv.setUint16(o + 1, f.data.length, false);
    buf.set(f.data, o + FRAME_HDR);
    o += FRAME_HDR + f.data.length;
  }
  return buf;
}

/**
 * Decode a packet into individual frames with absolute sequence numbers.
 * Returns null on anything malformed — a corrupt packet is a dropped
 * packet, never a thrown exception in the receive path.
 *
 * @returns {null | {seq:number, tsMs:number, frames:Array<{seq:number, tsMs:number, data:Uint8Array}>}}
 */
export function decodePacket(bytes) {
  try {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (buf.length < HDR) return null;
    if (buf[0] !== MAGIC || buf[1] !== VERSION) return null;

    const n = buf[3];
    if (n < 1 || n > MAX_FRAMES) return null;

    const dv   = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const seq  = dv.getUint32(4, false);
    const tsMs = dv.getUint32(8, false);

    const frames = [];
    let o = HDR;
    for (let i = 0; i < n; i++) {
      if (o + FRAME_HDR > buf.length) return null;
      const delta = buf[o];
      const len   = dv.getUint16(o + 1, false);
      o += FRAME_HDR;
      if (len > MAX_PAYLOAD || o + len > buf.length) return null;
      // The primary must be first and must be the newest frame.
      if (i === 0 && delta !== 0) return null;
      frames.push({
        seq:  (seq - delta) >>> 0,
        delta,
        // Older frames were captured earlier; 20 ms per frame is the
        // encoder's configured cadence.
        tsMs: (tsMs - delta * FRAME_MS) >>> 0,
        data: buf.subarray(o, o + len),
      });
      o += len;
    }
    return { seq, tsMs, frames };
  } catch (e) {
    return null;
  }
}

/** Encoder frame duration in ms. Must match the AudioEncoder config. */
export const FRAME_MS = 20;

/**
 * Redundancy scheduler.
 * ═══════════════════════════════════════════════════════════════════
 * Holds the last few encoded frames so each outgoing packet can carry
 * older copies alongside the current one.
 *
 * The `offset` is the important parameter and it is why doing this
 * ourselves beats RED. RED duplicates the *immediately* previous frame,
 * which is useless against the failure mode that actually ruins calls:
 * a burst that swallows several consecutive packets. Spacing the copy
 * further back — frame N carrying a copy of N-3 — means a burst has to
 * be longer than the offset to cause an audible gap.
 *
 * Cost is linear in `count`: 2 copies at 96 kbit/s is ~192 kbit/s of
 * audio. On a direct peer link with no per-GB billing, that is a
 * trade worth making by default.
 */
export class RedundancyScheduler {
  /**
   * @param {number} count   total frames per packet (1 = redundancy off)
   * @param {number} offset  how many frames back each extra copy sits
   */
  constructor(count = 2, offset = 3) {
    this.setConfig(count, offset);
    this.history = [];   // newest first: [{seq, data}]
  }

  setConfig(count, offset) {
    this.count  = Math.max(1, Math.min(MAX_FRAMES, count | 0));
    this.offset = Math.max(1, Math.min(60, offset | 0));
    // Keep enough history for the furthest-back copy we might send.
    this.depth = (this.count - 1) * this.offset + 1;
  }

  /**
   * Record a freshly encoded frame and return the frame list for the
   * packet that should carry it.
   */
  push(seq, data) {
    this.history.unshift({ seq, data });
    if (this.history.length > this.depth + 2) this.history.length = this.depth + 2;

    const out = [{ seqDelta: 0, data }];
    let budget = PACKET_BUDGET - HDR - FRAME_HDR - data.length;

    for (let i = 1; i < this.count; i++) {
      const delta = i * this.offset;
      const past  = this.history.find(h => h.seq === (seq - delta));
      if (!past) continue;                       // not enough history yet
      if (past.data.length + FRAME_HDR > budget) break;   // would fragment
      if (delta > 255) break;                    // seqDelta is one byte
      out.push({ seqDelta: delta, data: past.data });
      budget -= past.data.length + FRAME_HDR;
    }
    return out;
  }

  reset() { this.history.length = 0; }

  /** Bandwidth multiplier this configuration implies, for the HUD. */
  get overhead() { return this.count; }
}
