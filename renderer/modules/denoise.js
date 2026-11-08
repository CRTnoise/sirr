/**
 * Sirr — Neural noise suppression (RNNoise)
 * ═══════════════════════════════════════════════════════════════════
 * Chromium ships its own noise suppressor. It is fine for speech and
 * awful for everything else — it ducks room tone, chews transients,
 * and its AGC pumps. RNNoise is a small recurrent network trained
 * specifically to separate voice from stationary noise, and it sounds
 * markedly better on keyboards, fans, and street noise.
 *
 * SHAPE OF THE CHAIN:
 *   mic track → MediaStreamSource → AudioWorklet('sirr-rnnoise')
 *             → MediaStreamDestination → processed track → WebRTC
 *
 * We run this in a dedicated 48 kHz AudioContext because RNNoise is
 * hard-wired to 48 kHz frames and resampling underneath it would be
 * both wasteful and wrong.
 *
 * ═══ FAILURE POLICY ═══
 * This module is ENTIRELY optional and defaults to OFF. Every entry
 * point returns the ORIGINAL stream on any failure. If the wasm is
 * missing, the CSP blocks it, the worklet throws, or the browser is
 * having a bad day, you get your untouched microphone and a console
 * warning. There is no path where enabling this can leave you mute.
 */

import * as state from './state.js';

const dlog  = (...a) => console.log('[denoise]', ...a);
const dwarn = (...a) => console.warn('[denoise]', ...a);

let ctx = null;             // dedicated 48 kHz context
let node = null;            // AudioWorkletNode
let srcNode = null;
let dstNode = null;
let wasmBinary = null;      // cached ArrayBuffer
let workletUrl = null;      // cached blob: URL for the processor module
let workletLoaded = false;
let lastError = null;
let active = false;

export function isActive()   { return active; }
export function getError()   { return lastError; }
export function isSupported() {
  return typeof AudioWorkletNode !== 'undefined' &&
         typeof WebAssembly !== 'undefined' &&
         typeof window.sirr?.getAudioAssets === 'function';
}

/**
 * Pull the wasm bytes and worklet source from the main process.
 *
 * The renderer's origin is file:// (Electron loadFile), and Chromium
 * refuses fetch() and module-worklet loads from there. Main reads both
 * off disk instead and passes them over IPC; we turn the worklet source
 * into a blob: URL, which addModule() will accept.
 */
async function loadAssets() {
  if (wasmBinary && workletUrl) return;

  const assets = await window.sirr.getAudioAssets();
  if (!assets || assets.error) {
    throw new Error(assets?.error || 'assets unavailable');
  }
  if (!assets.wasm) throw new Error('rnnoise.wasm missing');
  if (!assets.worklet) throw new Error('worklet source missing');

  // IPC gives us a Buffer / Uint8Array view; the wasm loader wants a
  // plain ArrayBuffer it can hand straight to WebAssembly.
  const view = assets.wasm instanceof Uint8Array
    ? assets.wasm
    : new Uint8Array(assets.wasm);
  if (!view.byteLength) throw new Error('rnnoise.wasm empty');
  wasmBinary = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

  if (workletUrl) { try { URL.revokeObjectURL(workletUrl); } catch (e) {} }
  workletUrl = URL.createObjectURL(
    new Blob([assets.worklet], { type: 'text/javascript' })
  );
}

async function ensureCtx() {
  if (ctx && ctx.state !== 'closed') {
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    return ctx;
  }
  // RNNoise assumes 48 kHz. Ask for it explicitly rather than hoping
  // the default device rate happens to match.
  ctx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 48000,
    latencyHint: 'interactive',
  });
  workletLoaded = false;
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
  return ctx;
}

/**
 * Wrap a microphone MediaStream in the RNNoise chain.
 * @returns {Promise<{stream: MediaStream, denoised: boolean}>}
 *          `stream` is ALWAYS usable — the original one on any failure.
 */
export async function attach(micStream) {
  teardown();
  lastError = null;

  if (!micStream) return { stream: micStream, denoised: false };
  if (state.state.denoise !== 'on') return { stream: micStream, denoised: false };
  if (!isSupported()) {
    lastError = 'AudioWorklet or WebAssembly unavailable';
    dwarn(lastError);
    return { stream: micStream, denoised: false };
  }

  try {
    await loadAssets();
    const binary = wasmBinary;
    const c = await ensureCtx();

    if (!workletLoaded) {
      await c.audioWorklet.addModule(workletUrl);
      workletLoaded = true;
    }

    srcNode = c.createMediaStreamSource(micStream);
    dstNode = c.createMediaStreamDestination();
    node = new AudioWorkletNode(c, 'sirr-rnnoise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { wasmBinary: binary },
    });

    // The processor tells us when the network is live, or why it isn't.
    node.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'ready') dlog('RNNoise online');
      if (d.type === 'error') {
        lastError = d.message;
        dwarn('processor fell back to passthrough:', d.message);
      }
    };
    node.onprocessorerror = (e) => {
      lastError = 'processor crashed';
      dwarn('onprocessorerror', e);
    };

    srcNode.connect(node);
    node.connect(dstNode);

    const out = dstNode.stream;
    const track = out.getAudioTracks()[0];
    if (!track) throw new Error('no output track');

    // Carry the mute state across: WebRTC reads .enabled off the track
    // it actually holds, and that is now the processed one.
    const inTrack = micStream.getAudioTracks()[0];
    if (inTrack) track.enabled = inTrack.enabled;

    active = true;
    dlog('chain attached @', c.sampleRate, 'Hz');
    // Keep a handle so teardown() can stop the raw device too.
    out._sirrSource = micStream;
    return { stream: out, denoised: true };
  } catch (e) {
    lastError = String(e && e.message || e);
    dwarn('attach failed — using raw mic:', lastError);
    teardown();
    return { stream: micStream, denoised: false };
  }
}

/** Toggle processing without rebuilding the graph (instant A/B test). */
export function setEnabled(on) {
  try { node?.port.postMessage({ type: 'enabled', value: !!on }); } catch (e) {}
}

export function teardown() {
  try { srcNode?.disconnect(); } catch (e) {}
  try { node?.disconnect(); } catch (e) {}
  try { dstNode?.disconnect(); } catch (e) {}
  srcNode = null; node = null; dstNode = null;
  active = false;
}

/** Release the audio context entirely (call on leaveVoice). */
export function dispose() {
  teardown();
  try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (e) {}
  ctx = null;
  workletLoaded = false;
}
