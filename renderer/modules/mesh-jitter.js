/**
 * Sirr Mesh Voice — jitter buffer
 * ═══════════════════════════════════════════════════════════════════
 * Frames arrive out of order, duplicated (redundancy and dual transport
 * send the same frame more than once) and sometimes not at all.
 *
 * PLAYOUT IS DRIVEN BY THE AUDIO CLOCK
 * Draining on a timer as fast as frames arrive keeps the buffer empty,
 * so the adaptive target does nothing: network jitter goes straight into
 * the playback ring as underruns and clock drift overflows it (clicks).
 *
 * Instead the playback worklet asks for audio when its small ring runs low,
 * and each `pop()` means "the next 20 ms slot is due NOW". So:
 *
 *   • the frame for this slot is here      → play it
 *   • it isn't, but later frames are       → it's lost: conceal, move on
 *   • nothing is buffered at all           → underflow: stop, re-prime
 *   • more buffered than target + slack    → trim one frame (latency
 *                                            creep from bursts / drift)
 *   • well under target                    → stretch: play one concealment
 *                                            slot without advancing, which
 *                                            adds 20 ms of real buffer
 *
 * Buffer depth is measured as the SPAN from the next slot to the newest
 * frame held, not a count of frames — with loss, a count underestimates
 * how much time is actually queued. A frame that arrives after its slot
 * ('late') is direct evidence the buffer is too shallow and grows the
 * target; stretching then makes the new target real.
 *
 * Holding `targetMs` of audio before starting is what gives a late
 * frame time to arrive. After an underflow we re-prime and jump to the
 * oldest frame actually held, so a lost burst costs one gap, not a
 * backlog of concealment frames played one by one.
 *
 * Pure logic, no browser APIs — see test-mesh.mjs.
 */

import { FRAME_MS } from './mesh-packet.js';

export const PRESETS = {
  tight:    { minMs: 20,  maxMs: 120, startMs: 40 },
  balanced: { minMs: 40,  maxMs: 260, startMs: 60 },
  robust:   { minMs: 80,  maxMs: 500, startMs: 140 },
};

// A sequence jump bigger than this (either way) means the sender
// restarted or we missed a long stretch: start over rather than treat
// thousands of slots as lost or late.
const RESYNC_FRAMES = 50;
const MAX_HELD = 200;          // 4 s — anything more is a stuck consumer
const TRIM_SLACK_MS = 3 * FRAME_MS;

export class JitterBuffer {
  constructor(preset = 'balanced') {
    this.applyPreset(preset);
    this.frames    = new Map();   // seq -> {seq, tsMs, data, at}
    this.nextSeq   = null;
    this.maxSeq    = null;
    this.started   = false;
    this.sinceStretch = 0;
    // Loss-aware floor: a spare copy sent `d` frames later only helps if
    // we buffer at least (d+1) frames. Hold that much while loss is
    // actually happening; drop back once it stops.
    this.redDelta = 0;
    this.lossEwma = 0;

    this.lastArrival = 0;
    this.lastSeqSeen = null;
    this.meanIat     = FRAME_MS;
    this.jitterEst   = 0;

    this.stats = {
      received: 0, duplicates: 0, late: 0,
      concealed: 0, emitted: 0, reordered: 0,
      recovered: 0, underflows: 0, trimmed: 0, resyncs: 0, stretched: 0,
    };
  }

  applyPreset(name) {
    const p = PRESETS[name] || PRESETS.balanced;
    this.minMs    = p.minMs;
    this.maxMs    = p.maxMs;
    this.targetMs = Math.max(p.startMs, this.minMs);
    this.preset   = PRESETS[name] ? name : 'balanced';
  }

  /** Raise the floor without losing adaptation state (e.g. on a reliable, bursty transport). */
  setFloor(ms) {
    this.minMs = Math.max(this.minMs, ms);
    if (this.targetMs < this.minMs) this.targetMs = this.minMs;
  }

  /**
   * @returns {'accepted'|'duplicate'|'late'|'resync'}
   */
  push(frame, isRedundant, now) {
    now = now ?? Date.now();
    this.stats.received++;

    if (this.nextSeq !== null) {
      const d = seqDiff(frame.seq, this.nextSeq);
      // Far behind: could be a stale duplicate from a slower transport,
      // so only believe it after several in a row. Far ahead: resync now.
      if (d < -RESYNC_FRAMES) this.farBehind = (this.farBehind || 0) + 1;
      else this.farBehind = 0;
      if (d > RESYNC_FRAMES + this.frames.size || this.farBehind >= 8) {
        this.farBehind = 0;
        this.stats.resyncs++;
        this._clear();
        this.frames.set(frame.seq, { ...frame, at: now });
        this.nextSeq = frame.seq; this.maxSeq = frame.seq;
        this.lastArrival = 0; this.lastSeqSeen = null;
        if (!isRedundant) this._observe(frame.seq, now);
        return 'resync';
      }
    }

    if (this.farBehind) { this.stats.late++; return 'late'; }
    if (this.frames.has(frame.seq)) { this.stats.duplicates++; return 'duplicate'; }
    if (isRedundant && frame.delta) this.redDelta = Math.max(this.redDelta, Math.min(frame.delta, 12));
    if (this.nextSeq !== null && this.started && seqLt(frame.seq, this.nextSeq)) {
      this.stats.late++;
      if (isRedundant) this._lossSignal(1);
      // It missed its slot: the buffer is shallower than the network needs.
      this.targetMs = clamp(this.targetMs + FRAME_MS / 2, this.minMs, this.maxMs);
      return 'late';
    }

    this.frames.set(frame.seq, { ...frame, at: now });
    if (isRedundant) { this.stats.recovered++; this._lossSignal(1); }
    else { this._lossSignal(0); this._observe(frame.seq, now); }

    if (this.nextSeq === null) this.nextSeq = frame.seq;
    else if (!this.started && seqLt(frame.seq, this.nextSeq)) this.nextSeq = frame.seq;
    if (this.maxSeq === null || seqLt(this.maxSeq, frame.seq)) this.maxSeq = frame.seq;

    if (this.frames.size > MAX_HELD) this._trimOldest(this.frames.size - MAX_HELD);
    return 'accepted';
  }

  _observe(seq, now) {
    if (this.lastArrival && this.lastSeqSeen !== null) {
      const gapFrames = seqDiff(seq, this.lastSeqSeen);
      if (gapFrames > 0) {
        const iat = now - this.lastArrival;
        const dev = Math.abs(iat - gapFrames * FRAME_MS);
        this.jitterEst += (dev - this.jitterEst) / 16;       // RFC 3550 estimator
        this.meanIat   += (iat / gapFrames - this.meanIat) / 16;
      } else {
        this.stats.reordered++;
        return;
      }
    }
    this.lastArrival = now;
    this.lastSeqSeen = seq;
    this._adapt();
  }

  _lossSignal(v) { this.lossEwma += (v - this.lossEwma) / 32; }

  _adapt() {
    let want = this.jitterEst * 3 + FRAME_MS;
    if (this.redDelta && this.lossEwma > 0.01) want = Math.max(want, (this.redDelta + 1) * FRAME_MS + FRAME_MS / 2);
    want = clamp(want, this.minMs, this.maxMs);
    if (want > this.targetMs) this.targetMs = want;              // grow fast
    else this.targetMs += (want - this.targetMs) * 0.02;         // shrink slow
  }

  /** Time queued from the next slot to the newest frame held, in ms. */
  get depthMs() {
    if (!this.frames.size || this.nextSeq === null || this.maxSeq === null) return 0;
    const span = seqDiff(this.maxSeq, this.nextSeq) + 1;
    return span > 0 ? span * FRAME_MS : 0;
  }

  /**
   * The next 20 ms slot is due. What plays in it?
   * @returns {null | {frame:object|null, gap:boolean}}
   *   null                    nothing to play (priming or underflow)
   *   {frame, gap:false}      decode and play this
   *   {frame:null, gap:true}  this slot's frame is lost — conceal
   */
  pop(now) {
    now = now ?? Date.now();
    if (this.nextSeq === null) return null;

    if (!this.started) {
      if (this.depthMs < this.targetMs) return null;
      this.started = true;
      // Skip any hole left by the underflow: start at what we hold.
      const oldest = this._oldestSeq();
      if (oldest !== null) this.nextSeq = oldest;
    }

    this.sinceStretch++;
    // Latency creep (a burst after a stall, or clock drift): shed one
    // frame per slot until we're back near target.
    if (this.depthMs > this.targetMs + TRIM_SLACK_MS && this.frames.size > 1) {
      if (this.frames.has(this.nextSeq)) this.frames.delete(this.nextSeq);
      this.nextSeq = (this.nextSeq + 1) >>> 0;
      this.stats.trimmed++;
    } else if (this.frames.size && this.depthMs + FRAME_MS < this.targetMs && this.sinceStretch >= 4) {
      // Too shallow for the jitter we've seen: insert one concealment slot
      // WITHOUT advancing. Spread out (≥ 4 slots apart) so it's inaudible.
      this.sinceStretch = 0;
      this.stats.stretched++;
      return { frame: null, gap: true, stretch: true };
    }

    const want = this.frames.get(this.nextSeq);
    if (want) {
      this.frames.delete(this.nextSeq);
      this.nextSeq = (this.nextSeq + 1) >>> 0;
      this.stats.emitted++;
      return { frame: want, gap: false };
    }

    if (this.frames.size) {
      this.nextSeq = (this.nextSeq + 1) >>> 0;
      this.stats.concealed++;
      return { frame: null, gap: true };
    }

    // Ran dry. Either the peer went quiet (muted, left) or the network
    // stalled. Re-prime, and treat it as evidence we need more buffer.
    this.started = false;
    this.stats.underflows++;
    this.targetMs = clamp(this.targetMs + FRAME_MS, this.minMs, this.maxMs);
    return null;
  }

  _oldestSeq() {
    let best = null;
    for (const s of this.frames.keys()) if (best === null || seqLt(s, best)) best = s;
    return best;
  }
  _trimOldest(n) {
    for (let i = 0; i < n; i++) {
      const o = this._oldestSeq();
      if (o === null) break;
      this.frames.delete(o);
      this.stats.trimmed++;
      if (this.nextSeq !== null && !seqLt(o, this.nextSeq)) this.nextSeq = (o + 1) >>> 0;
    }
  }
  _clear() {
    this.frames.clear();
    this.nextSeq = null;
    this.maxSeq = null;
    this.started = false;
  }

  reset() {
    this._clear();
    this.lastArrival = 0;
    this.lastSeqSeen = null;
  }

  snapshot() {
    const s = this.stats;
    const total = s.emitted + s.concealed;
    return {
      targetMs:  Math.round(this.targetMs),
      depthMs:   this.depthMs,
      jitterMs:  Math.round(this.jitterEst * 10) / 10,
      lossPct:   total ? (s.concealed / total) * 100 : 0,
      recovered: s.recovered,
      duplicates: s.duplicates,
      late:      s.late,
      emitted:   s.emitted,
      concealed: s.concealed,
      underflows: s.underflows,
      trimmed:   s.trimmed,
      stretched: s.stretched,
      primaryLossPct: Math.round(this.lossEwma * 1000) / 10,
      preset:    this.preset,
    };
  }
}

// ─── sequence-number helpers (uint32, wraparound-safe) ────────────
export function seqLt(a, b)   { return ((a - b) >>> 0) > 0x80000000; }
export function seqDiff(a, b) {
  const d = (a - b) >>> 0;
  return d > 0x80000000 ? d - 0x100000000 : d;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
