/**
 * Sirr Mesh Voice — playback worklet
 * ═══════════════════════════════════════════════════════════════════
 * The audio thread is the clock. When the ring holds less than
 * `lowWater` samples we ask the main thread for more ('need'); the
 * main thread pops exactly as many 20 ms slots from the jitter buffer
 * as it takes to refill. The jitter buffer does the buffering; this
 * ring only absorbs main-thread scheduling (~30 ms).
 *
 * CONCEALMENT
 * A lost frame ('conceal' from the main thread) or an underrun is
 * filled by repeating the last pitch period of real audio, decaying
 * over ~60 ms, instead of a cut to silence. On a voice this turns a
 * click into something most people never notice. Recovery crossfades
 * back into real audio.
 */

const SR_NOMINAL = 48000;
const RING      = 48000;            // 1 s ceiling
const HIST      = 1024;             // last real samples, for concealment
const MIN_LAG   = 96;               // 500 Hz
const MAX_LAG   = 720;              // ~67 Hz
const PLC_DECAY_SAMPLES = 2880;     // 60 ms to silence

class MeshPlaybackProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const po = (opts && opts.processorOptions) || {};
    this.lowWater = po.lowWater || 1440;       // 30 ms
    this.ring  = new Float32Array(RING);
    this.rd = 0; this.wr = 0; this.count = 0;

    this.hist = new Float32Array(HIST);        // circular history of output
    this.hpos = 0;
    this.plcLag = 0; this.plcPos = 0; this.plcDone = 0;  // concealment state
    this.inPlc = false;
    this.xfade = 0;                            // samples left of crossfade out of PLC
    this.lastNeedAt = -1;

    this.stats = { underruns: 0, overruns: 0, played: 0, concealed: 0 };
    this.tick = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'pcm' && d.samples) this.write(d.samples);
      else if (d.type === 'conceal') this.writeConceal(d.n || 960);
      else if (d.type === 'flush') { this.rd = this.wr = this.count = 0; }
    };
  }

  push(v) {
    if (this.count === RING) { this.rd = (this.rd + 1) % RING; this.count--; this.stats.overruns++; }
    this.ring[this.wr] = v;
    this.wr = (this.wr + 1) % RING;
    this.count++;
  }

  write(samples) {
    for (let i = 0; i < samples.length; i++) this.push(samples[i]);
  }

  // Fill `n` samples of concealment INTO the ring, so the timeline keeps
  // its shape (a lost frame occupies its 20 ms; latency doesn't shrink).
  writeConceal(n) {
    // Base the synthesis on the tail of what's queued if there is any,
    // otherwise on what we last played.
    this.startPlc();
    for (let i = 0; i < n; i++) this.push(this.nextPlcSample());
    this.stats.concealed += n;
    // Next real audio after this should crossfade in.
    this.xfade = 240;
  }

  startPlc() {
    if (this.inPlc) return;
    this.inPlc = true;
    this.plcLag = this.findLag();
    this.plcPos = 0;
    this.plcDone = 0;
  }
  nextPlcSample() {
    if (!this.plcLag) return 0;
    // Repeat the last `lag` samples of history, fading out.
    const idx = (this.hpos - this.plcLag + (this.plcPos % this.plcLag) + HIST * 4) % HIST;
    const g = Math.max(0, 1 - this.plcDone / PLC_DECAY_SAMPLES);
    this.plcPos++; this.plcDone++;
    return this.hist[idx] * g;
  }
  findLag() {
    // Normalised autocorrelation over the last ~20 ms of output, coarse
    // stride for speed. Cheap enough to run once per concealment event.
    const N = 480;
    let best = 0, bestLag = 0, energy = 0;
    for (let i = 0; i < N; i++) { const v = this.hist[(this.hpos - 1 - i + HIST) % HIST]; energy += v * v; }
    if (energy < 1e-6) return 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 2) {
      let c = 0;
      for (let i = 0; i < N; i += 2) {
        c += this.hist[(this.hpos - 1 - i + HIST) % HIST] * this.hist[(this.hpos - 1 - i - lag + HIST * 2) % HIST];
      }
      if (c > best) { best = c; bestLag = lag; }
    }
    return bestLag || 240;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const ch = out[0];
    const n  = ch.length;

    for (let i = 0; i < n; i++) {
      let v;
      if (this.count > 0) {
        v = this.ring[this.rd];
        this.rd = (this.rd + 1) % RING;
        this.count--;
        if (this.inPlc && this.xfade === 0) this.xfade = 240;
        if (this.xfade > 0) {
          // Crossfade from concealment back to real audio.
          const t = 1 - this.xfade / 240;
          v = v * t + this.nextPlcSample() * (1 - t);
          if (--this.xfade === 0) this.inPlc = false;
        } else {
          this.inPlc = false;
        }
        this.stats.played++;
      } else {
        if (!this.inPlc) { this.stats.underruns++; this.startPlc(); }
        v = this.nextPlcSample();
      }
      ch[i] = v;
      if (!this.inPlc || this.count > 0) { this.hist[this.hpos] = v; this.hpos = (this.hpos + 1) % HIST; }
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);

    // Ask for more — at most every 4 quanta (~10 ms) while low.
    if (this.count < this.lowWater && (currentFrame - this.lastNeedAt) >= 512) {
      this.lastNeedAt = currentFrame;
      this.port.postMessage({ type: 'need', ring: this.count });
    }
    if (++this.tick % 37 === 0) {
      this.port.postMessage({
        type: 'stats',
        bufferedMs: (this.count / (sampleRate || SR_NOMINAL)) * 1000,
        underruns: this.stats.underruns,
        overruns: this.stats.overruns,
        played: this.stats.played,
        concealed: this.stats.concealed,
      });
    }
    return true;
  }
}

registerProcessor('mesh-playback', MeshPlaybackProcessor);
