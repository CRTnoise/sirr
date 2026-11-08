/**
 * Build step: renderer/worklets/rnnoise-worklet.js
 *
 * AudioWorklet scripts are loaded from a single URL and cannot `import`
 * arbitrary modules, so we concatenate the RNNoise emscripten glue with
 * our processor into one file at build time.
 *
 * Run:  node build-worklet.js
 * (Only needed if you upgrade @jitsi/rnnoise-wasm — the generated file
 *  is committed.)
 */
const fs = require('fs');
const path = require('path');

const GLUE_SRC = process.argv[2] || 'node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.js';
const OUT = path.join(__dirname, '..', 'renderer', 'worklets', 'rnnoise-worklet.js');

let glue = fs.readFileSync(GLUE_SRC, 'utf8');
// Strip the ESM export — the worklet consumes the symbol directly from
// module scope, and a default export here confuses nothing but adds noise.
glue = glue.replace(/export default createRNNWasmModule;\s*$/, '');

const PROCESSOR = `
/* ─────────────────────────────────────────────────────────────────
 * Sirr RNNoise processor
 *
 * RNNoise is a recurrent-network noise suppressor. It runs on 480-sample
 * frames at 48 kHz and expects samples scaled to int16 range, not the
 * ±1.0 the Web Audio API hands us.
 *
 * AudioWorklet gives us 128 samples at a time, so we ring-buffer input
 * up to a full frame, denoise, and ring-buffer the result back out.
 * Net added latency: one frame, 10 ms.
 *
 * SAFETY: any failure at all — no wasm, bad build, throw mid-frame —
 * flips \`bypass\` and we become a straight passthrough forever. A
 * broken denoiser must never mean a broken microphone.
 * ───────────────────────────────────────────────────────────────── */

const RN_FRAME = 480;
const FIFO_LEN = RN_FRAME * 8;

class SirrRNNoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.bypass  = false;
    this.ready   = false;
    this.enabled = true;
    this.mix     = 1.0;

    this.inBuf  = new Float32Array(RN_FRAME);
    this.inIdx  = 0;
    this.dryBuf = new Float32Array(RN_FRAME);   // for wet/dry blending

    this.fifo   = new Float32Array(FIFO_LEN);
    this.rd = 0; this.wr = 0; this.count = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'enabled') this.enabled = !!d.value;
      if (d.type === 'mix' && typeof d.value === 'number') {
        this.mix = Math.max(0, Math.min(1, d.value));
      }
    };

    const binary = options && options.processorOptions && options.processorOptions.wasmBinary;
    if (!binary || typeof createRNNWasmModule !== 'function') {
      this.bypass = true;
      this.port.postMessage({ type: 'error', message: 'no wasm binary' });
      return;
    }

    try {
      createRNNWasmModule({ wasmBinary: binary })
        .then((m) => {
          try {
            this.m    = m;
            this.st   = m._rnnoise_create();
            this.pIn  = m._malloc(RN_FRAME * 4);
            this.pOut = m._malloc(RN_FRAME * 4);
            if (!this.st || !this.pIn || !this.pOut) throw new Error('alloc failed');
            this.ready = true;
            this.port.postMessage({ type: 'ready' });
          } catch (err) {
            this.bypass = true;
            this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
          }
        })
        .catch((err) => {
          this.bypass = true;
          this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
        });
    } catch (err) {
      this.bypass = true;
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }

  runFrame() {
    const m = this.m;
    // HEAPF32 is re-created whenever the wasm memory grows, so we must
    // read it fresh every frame rather than caching the view.
    const heap = m.HEAPF32;
    const base = this.pIn >> 2;
    for (let i = 0; i < RN_FRAME; i++) heap[base + i] = this.inBuf[i] * 32768;

    m._rnnoise_process_frame(this.st, this.pOut, this.pIn);

    const outHeap = m.HEAPF32;
    const ob = this.pOut >> 2;
    const wet = this.mix, dry = 1 - this.mix;
    for (let i = 0; i < RN_FRAME; i++) {
      const v = (outHeap[ob + i] / 32768) * wet + this.inBuf[i] * dry;
      this.fifo[this.wr] = v;
      this.wr = (this.wr + 1) % FIFO_LEN;
      if (this.count < FIFO_LEN) this.count++;
      else this.rd = (this.rd + 1) % FIFO_LEN;   // overrun: drop oldest
    }
  }

  passthrough(src) {
    for (let i = 0; i < src.length; i++) {
      this.fifo[this.wr] = src[i];
      this.wr = (this.wr + 1) % FIFO_LEN;
      if (this.count < FIFO_LEN) this.count++;
      else this.rd = (this.rd + 1) % FIFO_LEN;
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    const src = input && input.length ? input[0] : null;
    if (!src) { for (const ch of output) ch.fill(0); return true; }

    // Straight wire when disabled or unavailable — zero added latency.
    if (this.bypass || !this.ready || !this.enabled) {
      for (const ch of output) ch.set(src);
      return true;
    }

    try {
      for (let i = 0; i < src.length; i++) {
        this.inBuf[this.inIdx++] = src[i];
        if (this.inIdx === RN_FRAME) { this.runFrame(); this.inIdx = 0; }
      }
    } catch (err) {
      // One bad frame is all it takes — go passthrough and stay there.
      this.bypass = true;
      this.port.postMessage({ type: 'error', message: 'frame: ' + String(err && err.message || err) });
      for (const ch of output) ch.set(src);
      return true;
    }

    const dst = output[0];
    for (let i = 0; i < dst.length; i++) {
      if (this.count > 0) {
        dst[i] = this.fifo[this.rd];
        this.rd = (this.rd + 1) % FIFO_LEN;
        this.count--;
      } else {
        dst[i] = 0;   // priming: first ~10 ms only
      }
    }
    for (let c = 1; c < output.length; c++) output[c].set(dst);
    return true;
  }
}

registerProcessor('sirr-rnnoise', SirrRNNoiseProcessor);
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, glue + '\n' + PROCESSOR, 'utf8');
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
