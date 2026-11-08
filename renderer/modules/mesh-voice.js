/**
 * Sirr Mesh Voice — the pipeline
 * ═══════════════════════════════════════════════════════════════════
 * Sirr's own audio path:
 *
 *   mic track → MediaStreamTrackProcessor → AudioEncoder (Opus)
 *     → RedundancyScheduler → encodePacket → LINK
 *     → JitterBuffer → AudioDecoder → mesh-playback worklet
 *
 * ─── LINKS ────────────────────────────────────────────────
 * A peer can be reached over two links, and packets are identical on
 * both, so the receive side doesn't care which one they came from:
 *
 *   'dc'     unordered, zero-retransmit RTCDataChannel inside the
 *            WebRTC connection. Lowest latency. Needs ICE to succeed.
 *   'swarm'  the Hyperswarm connection the chat already runs on —
 *            Noise-encrypted, holepunched by HyperDHT, no STUN, no
 *            third party. Reliable/ordered, so a lost packet delays
 *            the ones behind it; the jitter buffer runs deeper here and
 *            redundant copies are not sent (they'd be pure waste).
 *            If signaling reached us, this link works. That is the
 *            fallback for every "can't connect to this person" case.
 *
 * Sending prefers 'dc' when it's open and the peer has greeted us on
 * it, else 'swarm' if the voice module allows it for that peer.
 *
 * ─── HANDOVER ─────────────────────────────────────────────
 * Nothing is muted on a handshake any more. Each direction switches on
 * evidence:
 *   RX  we tell voice.js "mesh is carrying this peer" only while we are
 *       actually DECODING their audio (and "released" 300 ms after it
 *       stops). voice.js mutes/unmutes their WebRTC element from that.
 *   TX  every 400 ms while decoding a peer we send them RXOK. When we
 *       receive RXOK we tell voice.js it may idle our WebRTC sender to
 *       them; if RXOK stops for 1.2 s, it puts the mic back.
 * HELLO is only sent while our encoder is really running, so a peer never
 * engages mesh with a side that can't actually send.
 */

import * as state from './state.js';
import { encodePacket, decodePacket, RedundancyScheduler, FRAME_MS, MAGIC } from './mesh-packet.js';
import { JitterBuffer } from './mesh-jitter.js';
import * as devices from './devices.js';

const mlog  = (...a) => console.log('[mesh]', ...a);
const mwarn = (...a) => console.warn('[mesh]', ...a);

export const DC_LABEL = 'sirr-mesh-voice';

// 0x01 is a retired HELLO whose receivers muted WebRTC on the spot, even
// with a dead encoder. It is never sent or answered; HELLO is 0x04.
const CTL_HELLO_V1 = 0x01;
const CTL_BYE   = 0x02;
const CTL_RXOK  = 0x03;   // "I am decoding your audio"
const CTL_HELLO = 0x04;   // [0x04, version, flags]
const PROTO_VERSION = 2;

const BITRATES = { lowband: 24000, voice: 96000, studio: 160000 };
const SWARM_BITRATE_CAP = 64000;       // one encoder; clamp if any swarm link exists
const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

const RX_RELEASE_MS = 300;
const RXOK_EVERY_MS = 400;
const TX_RELEASE_MS = 1200;
const HELLO_EVERY_MS = 1500;
const SAMPLES_PER_FRAME = 48000 * FRAME_MS / 1000;   // decoder output @48k
const RING_FILL = SAMPLES_PER_FRAME * 2;             // keep ~40 ms queued in the worklet

let ctx = null;
let workletUrl = null;
let workletLoaded = false;

let encoder = null;
let encCfgKey = '';
let readerAbort = null;
let pumpGen = 0;
let scheduler = null;
let seq = 0;                 // monotonic for the whole call — survives device switches
let callStart = 0;
let sending = false;
let inputTrack = null;

let hooks = {
  onRxChange: () => {}, onTxChange: () => {},
  allowSwarm: () => false, sendSwarm: () => false,
};
let tickTimer = null;

const peers = new Map();
// pid -> {
//   dc, helloDc, helloSwarm, swarm,          link state
//   jb, decoder, node, gain, inflight, ringEst,
//   lastDecoded, rxActive, lastRxOkSent, lastRxLink,
//   lastRxOkFrom, txActive, level, stats
// }

let lastError = null;
let listenOnly = false;

/** No microphone: still greet so peers can send us mesh audio. */
export function setListenOnly(on) { listenOnly = !!on; if (on) greetAll(); }

export function isEnabled()  { return state.state.meshVoice === 'on'; }
export function isRunning()  { return sending; }
export function getError()   { return lastError; }

export function isSupported() {
  return typeof AudioEncoder !== 'undefined' &&
         typeof AudioDecoder !== 'undefined' &&
         typeof MediaStreamTrackProcessor !== 'undefined' &&
         typeof AudioWorkletNode !== 'undefined' &&
         typeof window.sirr?.getAudioAssets === 'function';
}

/** voice.js wires itself in once. */
export function setHooks(h) { hooks = { ...hooks, ...h }; ensureTick(); }

export async function selfTest() {
  const result = { supported: isSupported(), encoder: false, decoder: false, error: null };
  if (!result.supported) { result.error = 'WebCodecs or MediaStreamTrackProcessor missing'; return result; }
  try {
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 };
    result.encoder = (await AudioEncoder.isConfigSupported(cfg)).supported === true;
    result.decoder = (await AudioDecoder.isConfigSupported(cfg)).supported === true;
  } catch (e) { result.error = String(e && e.message || e); }
  return result;
}

// ═══════════════════════════════════════════════════════════════════
//  Playback context
// ═══════════════════════════════════════════════════════════════════
let ctxPromise = null;
function ensureCtx() {
  if (ctx && ctx.state !== 'closed' && workletLoaded) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return Promise.resolve(ctx);
  }
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
    workletLoaded = false;
    // resume() can stay pending until a gesture on some builds; never await it bare.
    if (ctx.state === 'suspended') await Promise.race([ctx.resume().catch(() => {}), sleep(500)]);
    devices.applySinkToContext(ctx).catch(() => {});
    const assets = await window.sirr.getAudioAssets();
    const src = assets && assets.meshPlayback;
    if (!src) throw new Error('mesh playback worklet unavailable');
    if (workletUrl) { try { URL.revokeObjectURL(workletUrl); } catch (e) {} }
    workletUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    workletLoaded = true;
    return ctx;
  })();
  ctxPromise.finally(() => { ctxPromise = null; });
  return ctxPromise;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
//  Capture + encode
// ═══════════════════════════════════════════════════════════════════
/**
 * Start (or restart) encoding from this microphone stream. Peers and
 * links are untouched — this can be called on a device switch.
 * Returns true once the encoder is actually producing packets' worth
 * of configuration; false (with getError()) if mesh can't send.
 */
export async function start(micStream) {
  lastError = null;
  if (!isSupported()) { lastError = 'WebCodecs unavailable in this build'; return false; }
  const track = micStream?.getAudioTracks?.()[0];
  if (!track) { lastError = 'no microphone track'; stopSending(); return false; }
  try { await ensureCtx(); } catch (e) { lastError = 'playback: ' + (e?.message || e); mwarn(lastError); }
  if (!callStart) callStart = performance.now();
  return pump(track);
}
export const setInput = start;

function currentProfileBitrate() {
  const profile = state.state.audioProfile || 'voice';
  let br = BITRATES[profile] || BITRATES.voice;
  for (const [, p] of peers) if (p.swarm) { br = Math.min(br, SWARM_BITRATE_CAP); break; }
  return br;
}

function makeScheduler() {
  return new RedundancyScheduler(
    state.state.meshRedundancy === 'off' ? 1 : (parseInt(state.state.meshCopies, 10) || 2),
    parseInt(state.state.meshSpacing, 10) || 3
  );
}

function pump(track) {
  stopCapture();
  inputTrack = track;
  if (!scheduler) scheduler = makeScheduler();
  const gen = ++pumpGen;
  let reader;
  try {
    const proc = new MediaStreamTrackProcessor({ track });
    reader = proc.readable.getReader();
  } catch (e) {
    lastError = 'capture: ' + (e?.message || e);
    mwarn(lastError);
    return false;
  }
  readerAbort = () => { try { reader.cancel(); } catch (e) {} };

  return new Promise((resolveStarted) => {
    let announced = false;
    const announce = (ok) => { if (!announced) { announced = true; resolveStarted(ok); } };
    (async () => {
      try {
        while (gen === pumpGen) {
          const { value, done } = await reader.read();
          if (done) break;
          try {
            if (gen !== pumpGen) break;
            if (!ensureEncoder(value)) { announce(false); break; }
            encoder.encode(value);
            if (!sending) {
              sending = true;
              mlog('encoder live @', value.sampleRate, 'Hz ×', value.numberOfChannels);
              announce(true);
              greetAll();
            }
          } finally {
            value.close();
          }
        }
      } catch (e) {
        if (gen === pumpGen) { lastError = 'capture: ' + String(e && e.message || e); mwarn(lastError); }
      } finally {
        if (gen === pumpGen) { stopSending(); announce(false); }
      }
    })();
    setTimeout(() => announce(sending), 3000);
  });
}

// Configure from the ACTUAL frames, not from what we asked getUserMedia
// for. A stereo interface (Studio mode asks for 2 ch) or a 44.1 kHz
// device used to make encode() throw on the first frame, which killed
// the encoder while the peer still believed we were sending.
function ensureEncoder(frame) {
  const sr = frame.sampleRate, ch = Math.min(2, frame.numberOfChannels || 1);
  const br = currentProfileBitrate();
  const key = sr + '/' + ch + '/' + br;
  if (encoder && encoder.state === 'configured' && key === encCfgKey) return true;
  if (!OPUS_RATES.has(sr)) {
    lastError = 'mic runs at ' + sr + ' Hz, which Opus cannot take directly';
    mwarn(lastError);
    return false;
  }
  try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) {}
  const profile = state.state.audioProfile || 'voice';
  encoder = new AudioEncoder({
    output: (chunk) => onEncoded(chunk),
    error:  (e) => { lastError = 'encoder: ' + String(e && e.message || e); mwarn(lastError); stopSending(); },
  });
  encoder.configure({
    codec: 'opus', sampleRate: sr, numberOfChannels: ch, bitrate: br,
    opus: {
      frameDuration: FRAME_MS * 1000,
      // WebCodecs gives the receiver no way to decode Opus in-band FEC,
      // so it was pure overhead. Our own redundancy covers loss.
      useinbandfec: false,
      // DTX would stop packets during silence — and packet flow is how the
      // receiver knows mesh is alive. Always off here.
      usedtx: false,
      complexity: 10,
      application: profile === 'studio' ? 'audio' : 'voip',
    },
  });
  encCfgKey = key;
  return true;
}

function onEncoded(chunk) {
  try {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const s = seq; seq = (seq + 1) >>> 0;
    const ts = Math.round(performance.now() - callStart);
    const frames = scheduler.push(s, data);
    let full = null, primary = null;

    for (const [pid, p] of peers) {
      const link = pickLink(pid, p);
      if (!link) continue;
      if (link === 'dc') {
        if (p.dc.bufferedAmount > 32 * 1024) { p.stats.dropped++; continue; }
        full = full || encodePacket(s, ts, frames);
        try { p.dc.send(full); p.stats.sent++; } catch (e) { p.stats.dropped++; }
      } else {
        primary = primary || encodePacket(s, ts, frames.slice(0, 1));
        if (hooks.sendSwarm(pid, primary)) p.stats.sent++; else p.stats.dropped++;
      }
    }
  } catch (e) {
    mwarn('onEncoded', e);
  }
}

function pickLink(pid, p) {
  if (!sending) return null;
  if (p.dc && p.dc.readyState === 'open' && p.helloDc) return 'dc';
  if (p.swarm && p.helloSwarm && hooks.allowSwarm(pid)) return 'swarm';
  return null;
}

function stopCapture() {
  pumpGen++;
  try { readerAbort?.(); } catch (e) {}
  readerAbort = null;
}

function stopSending() {
  const was = sending;
  sending = false;
  stopCapture();
  try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (e) {}
  encoder = null; encCfgKey = '';
  if (was) {
    // Tell everyone to stop expecting us; take our WebRTC path back.
    for (const [pid, p] of peers) {
      sendCtl(pid, p, new Uint8Array([CTL_BYE]));
      if (p.txActive) { p.txActive = false; safe(() => hooks.onTxChange(pid, false)); }
    }
  }
}

/** Full stop: encoder, every peer, every link. */
export function stop() {
  stopSending();
  for (const pid of [...peers.keys()]) detachPeer(pid);
  scheduler?.reset();
  scheduler = null;
  inputTrack = null;
}

export function dispose() {
  stop();
  listenOnly = false;
  seq = 0; callStart = 0;
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch (e) {}
  ctx = null;
  workletLoaded = false;
}

// ═══════════════════════════════════════════════════════════════════
//  Links
// ═══════════════════════════════════════════════════════════════════
function getPeer(pid) {
  let p = peers.get(pid);
  if (!p) {
    p = {
      dc: null, helloDc: 0, helloSwarm: 0, swarm: false,
      jb: new JitterBuffer(state.state.meshBuffer || 'balanced'),
      decoder: null, node: null, gain: null, playbackPromise: null,
      inflight: 0, ringEst: 0,
      lastDecoded: 0, rxActive: false, lastRxOkSent: 0, lastRxLink: null,
      lastRxOkFrom: 0, txActive: false,
      lastHelloDc: 0, lastHelloSwarm: 0,
      level: 0, played: 0,
      stats: { sent: 0, dropped: 0, rxPackets: 0, rxBad: 0, underruns: 0, rxDc: 0, rxSwarm: 0 },
    };
    peers.set(pid, p);
    ensureTick();
  }
  return p;
}

/** Bind the WebRTC data channel for a peer (created or received). */
export function attachDc(pid, dc) {
  const p = getPeer(pid);
  if (p.dc && p.dc !== dc) { try { p.dc.close(); } catch (e) {} }
  p.dc = dc; p.helloDc = 0;
  dc.binaryType = 'arraybuffer';
  const greet = () => { mlog('channel open →', pid); helloOn(pid, p, 'dc'); };
  dc.onopen = greet;
  dc.onclose = () => { if (p.dc === dc) { mlog('channel closed →', pid); p.dc = null; p.helloDc = 0; } };
  dc.onerror = () => {};
  dc.onmessage = (ev) => onMessage(pid, ev.data, 'dc');
  if (dc.readyState === 'open') greet();
}
// Alias kept for existing call sites.
export function attach(pid, dc) { attachDc(pid, dc); }

export function detachDc(pid) {
  const p = peers.get(pid);
  if (!p || !p.dc) return;
  try { p.dc.close(); } catch (e) {}
  p.dc = null; p.helloDc = 0;
  if (!p.swarm) detachPeer(pid);
}

/** Enable the Hyperswarm link for a peer. Idempotent. */
export function attachSwarm(pid) {
  if (!isSupported()) return false;
  const p = getPeer(pid);
  if (p.swarm) return true;
  p.swarm = true;
  p.jb.setFloor(80);             // reliable/ordered transport: bursts after retransmits
  mlog('swarm link →', pid);
  helloOn(pid, p, 'swarm');
  return true;
}
export function hasSwarm(pid) { return !!peers.get(pid)?.swarm; }

export function detachSwarm(pid) {
  const p = peers.get(pid);
  if (!p || !p.swarm) return;
  sendCtl(pid, p, new Uint8Array([CTL_BYE]), 'swarm');
  p.swarm = false; p.helloSwarm = 0;
  if (!p.dc) detachPeer(pid);
}

export function detachPeer(pid) {
  const p = peers.get(pid);
  if (!p) return;
  peers.delete(pid);
  if (p.rxActive) safe(() => hooks.onRxChange(pid, false));
  if (p.txActive) safe(() => hooks.onTxChange(pid, false));
  try { p.decoder && p.decoder.state !== 'closed' && p.decoder.close(); } catch (e) {}
  try { p.node?.port.close?.(); p.node?.disconnect(); } catch (e) {}
  try { p.gain?.disconnect(); } catch (e) {}
  if (p.swarm) sendCtl(pid, p, new Uint8Array([CTL_BYE]), 'swarm');
  try { p.dc?.close(); } catch (e) {}
}
// Back-compat
export function detach(pid) { detachPeer(pid); }

function helloOn(pid, p, link) {
  // Only greet when we can really send — or when we have no mic at all
  // (nothing of ours can go silent, and we still want their audio).
  if (!sending && !listenOnly) return;
  const now = performance.now();
  if (link === 'dc') p.lastHelloDc = now; else p.lastHelloSwarm = now;
  sendCtl(pid, p, new Uint8Array([CTL_HELLO, PROTO_VERSION, sending ? 1 : 0]), link);
}
function greetAll() {
  for (const [pid, p] of peers) {
    if (p.dc && p.dc.readyState === 'open') helloOn(pid, p, 'dc');
    if (p.swarm) helloOn(pid, p, 'swarm');
  }
}

function sendCtl(pid, p, bytes, only) {
  if ((!only || only === 'dc') && p.dc && p.dc.readyState === 'open') { try { p.dc.send(bytes); } catch (e) {} }
  if ((!only || only === 'swarm') && p.swarm) { try { hooks.sendSwarm(pid, bytes); } catch (e) {} }
}

export const HELLO_BYTE = CTL_HELLO;

/** Inbound bytes from the Hyperswarm link (voice.js routes them here). */
export function onSwarmBytes(pid, bytes) {
  const p = peers.get(pid);
  if (!p || !p.swarm) return false;
  onMessage(pid, bytes, 'swarm');
  return true;
}

function onMessage(pid, raw, link) {
  const p = peers.get(pid);
  if (!p) return;
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw)
              : raw instanceof Uint8Array ? raw
              : (raw && raw.buffer) ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength) : null;
  if (!bytes || !bytes.length) return;

  const t = bytes[0];
  if (t === CTL_HELLO_V1) {
    if (!p.warnedV1) { p.warnedV1 = true; mlog(pid, 'runs mesh v1 — staying on standard voice with them'); }
    return;
  }
  if (t === CTL_HELLO) {
    const ver = bytes[1] || 1;
    const first = link === 'dc' ? !p.helloDc : !p.helloSwarm;
    if (link === 'dc') p.helloDc = ver; else p.helloSwarm = ver;
    if (first) {
      mlog('HELLO v' + ver, 'from', pid, 'via', link);
      // Answer so they can start sending too (they may have greeted
      // before our encoder was up).
      helloOn(pid, p, link);
    }
    return;
  }
  if (t === CTL_BYE) {
    if (link === 'dc') p.helloDc = 0; else p.helloSwarm = 0;
    p.lastRxOkFrom = 0;
    updateTx(pid, p, performance.now());
    return;
  }
  if (t === CTL_RXOK) {
    p.lastRxOkFrom = performance.now();
    updateTx(pid, p, p.lastRxOkFrom);
    return;
  }
  if (t !== MAGIC) return;

  const pkt = decodePacket(bytes);
  if (!pkt) { p.stats.rxBad++; return; }
  p.stats.rxPackets++;
  if (link === 'dc') p.stats.rxDc++; else p.stats.rxSwarm++;
  p.lastRxLink = link;
  const now = performance.now();
  pkt.frames.forEach((f, i) => p.jb.push(f, i > 0, now));
  if (!p.node && !p.playbackPromise) {
    p.playbackPromise = ensurePlayback(pid).catch(e => mwarn('playback setup failed for', pid, e?.message || e))
      .finally(() => { p.playbackPromise = null; });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Decode + playback (demand-driven)
// ═══════════════════════════════════════════════════════════════════
async function ensurePlayback(pid) {
  const p = peers.get(pid);
  if (!p || p.node) return;
  const c = await ensureCtx();
  if (peers.get(pid) !== p) return;

  p.node = new AudioWorkletNode(c, 'mesh-playback', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { lowWater: SAMPLES_PER_FRAME * 1.5 },
  });
  p.gain = c.createGain();
  p.gain.gain.value = state.state.deafened ? 0 : 1;
  p.node.connect(p.gain).connect(c.destination);

  p.node.port.onmessage = (e) => {
    const d = e.data;
    if (!d) return;
    if (d.type === 'need') { p.ringEst = d.ring; feed(pid, p); }
    else if (d.type === 'stats') {
      p.playbackMs = d.bufferedMs;
      p.stats.underruns = d.underruns;
      p.played = d.played;
    }
  };

  p.decoder = new AudioDecoder({
    output: (audioData) => {
      try {
        const n = audioData.numberOfFrames;
        const pcm = new Float32Array(n);
        audioData.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
        let e = 0; for (let i = 0; i < n; i += 4) e += pcm[i] * pcm[i];
        p.level = Math.sqrt(e / (n / 4));
        p.node?.port.postMessage({ type: 'pcm', samples: pcm }, [pcm.buffer]);
        p.lastDecoded = performance.now();
      } catch (e) {
        mwarn('decode output', e);
      } finally {
        p.inflight = Math.max(0, p.inflight - 1);
        audioData.close();
      }
    },
    error: (e) => { mwarn('decoder error for', pid, e?.message || e); resetDecoder(p); },
  });
  p.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
  mlog('playback ready for', pid);
  feed(pid, p);
}

function resetDecoder(p) {
  try {
    if (p.decoder && p.decoder.state !== 'closed') {
      p.decoder.reset();
      p.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    }
  } catch (e) {}
  p.inflight = 0;
}

// The worklet said it's running low: fill it to ~40 ms, one 20 ms slot
// per jitter-buffer pop. Loss becomes an explicit concealment slot so
// the timeline keeps its length.
function feed(pid, p) {
  if (!p.decoder || p.decoder.state !== 'configured' || !p.node) return;
  const now = performance.now();
  let queued = p.ringEst + p.inflight * SAMPLES_PER_FRAME;
  let guard = 0;
  while (queued < RING_FILL && guard++ < 6) {
    const r = p.jb.pop(now);
    if (!r) break;
    if (r.gap) {
      p.node.port.postMessage({ type: 'conceal', n: SAMPLES_PER_FRAME });
    } else {
      try {
        p.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: r.frame.tsMs * 1000, data: r.frame.data }));
        p.inflight++;
      } catch (e) { mwarn('decode failed', e?.message); }
    }
    queued += SAMPLES_PER_FRAME;
  }
  p.ringEst = queued - p.inflight * SAMPLES_PER_FRAME;
}

// ═══════════════════════════════════════════════════════════════════
//  Evidence tick: rx/tx state, RXOK, HELLO retries, safety feed
// ═══════════════════════════════════════════════════════════════════
function ensureTick() {
  if (tickTimer) return;
  tickTimer = setInterval(tick, 100);
}

function tick() {
  const now = performance.now();
  for (const [pid, p] of peers) {
    // RX: are we genuinely playing their mesh audio?
    const rx = !!p.node && (now - p.lastDecoded) < RX_RELEASE_MS;
    if (rx !== p.rxActive) {
      p.rxActive = rx;
      if (!rx) { p.level = 0; }
      safe(() => hooks.onRxChange(pid, rx));
    }
    if (rx && now - p.lastRxOkSent >= RXOK_EVERY_MS && p.lastRxLink) {
      p.lastRxOkSent = now;
      sendCtl(pid, p, new Uint8Array([CTL_RXOK]), p.lastRxLink);
    }
    updateTx(pid, p, now);

    // HELLO retries: control frames ride the same unreliable channel as
    // media and can be lost. Keep greeting until they greet back.
    if (sending || listenOnly) {
      if (p.dc && p.dc.readyState === 'open' && !p.helloDc && now - p.lastHelloDc > HELLO_EVERY_MS) helloOn(pid, p, 'dc');
      if (p.swarm && !p.helloSwarm && now - p.lastHelloSwarm > HELLO_EVERY_MS) helloOn(pid, p, 'swarm');
    }
    // Safety net if a 'need' message was ever missed.
    if (p.node && p.ringEst < SAMPLES_PER_FRAME) feed(pid, p);
  }
}

function updateTx(pid, p, now) {
  const tx = sending && !!pickLink(pid, p) && p.lastRxOkFrom > 0 && (now - p.lastRxOkFrom) < TX_RELEASE_MS;
  if (tx !== p.txActive) {
    p.txActive = tx;
    safe(() => hooks.onTxChange(pid, tx));
  }
}

function safe(fn) { try { fn(); } catch (e) { mwarn('hook', e); } }

// ═══════════════════════════════════════════════════════════════════
//  Controls + telemetry
// ═══════════════════════════════════════════════════════════════════
export function setDeafened(on) {
  for (const [, p] of peers) { try { if (p.gain) p.gain.gain.value = on ? 0 : 1; } catch (e) {} }
}
export async function setOutputDevice() {
  if (!ctx || ctx.state === 'closed') return false;
  return devices.applySinkToContext(ctx);
}
export function setBufferPreset(name) {
  for (const [, p] of peers) {
    try { p.jb.applyPreset(name); if (p.swarm) p.jb.setFloor(80); } catch (e) {}
  }
}
/** Is mesh audio from this peer actually playing right now? */
export function isMeshActive(pid) { return !!peers.get(pid)?.rxActive; }
/** Is mesh carrying OUR audio to this peer (confirmed by them)? */
export function isTxActive(pid) { return !!peers.get(pid)?.txActive; }
/** 'dc' | 'swarm' | null — which link our packets to this peer use. */
export function linkFor(pid) { const p = peers.get(pid); return p ? pickLink(pid, p) : null; }
export function rxLinkFor(pid) { const p = peers.get(pid); return p && p.rxActive ? p.lastRxLink : null; }
/** 0..128 VU level from decoded PCM RMS, on the same -60…-10 dBFS scale as voice.js. */
export function levelFor(pid) {
  const p = peers.get(pid);
  if (!p || !p.rxActive || !(p.level > 1e-6)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(p.level) + 60) / 50)) * 128;
}
export function swarmPeers() { return [...peers].filter(([, p]) => p.swarm).map(([pid]) => pid); }
export function debugPlayed(pid) { const p = peers.get(pid); return p ? p.played : null; }

export function statsFor(pid) {
  const p = peers.get(pid);
  if (!p || (!p.rxActive && !p.txActive)) return null;
  const jb = p.jb.snapshot();
  return {
    mesh: true,
    link:       p.lastRxLink || pickLink(pid, p),
    targetMs:   jb.targetMs,
    bufferedMs: Math.round(p.playbackMs || 0),
    lossPct:    jb.lossPct,
    recovered:  jb.recovered,
    duplicates: jb.duplicates,
    late:       jb.late,
    underruns:  p.stats.underruns,
    rxPackets:  p.stats.rxPackets,
    rxBad:      p.stats.rxBad,
    sent:       p.stats.sent,
    dropped:    p.stats.dropped,
    copies:     scheduler?.count ?? 1,
    spacing:    scheduler?.offset ?? 0,
    preset:     jb.preset,
  };
}
