/**
 * Sirr — Audio Engine
 * ═══════════════════════════════════════════════════════════════════
 * Everything that makes Sirr calls sound better than the default
 * WebRTC stack. Nothing here changes the *transport* — we still use
 * ICE/DTLS-SRTP — but every knob that WebRTC leaves on a conservative
 * default is turned up deliberately.
 *
 * The four levers, in order of audible impact:
 *
 *  1. OPUS PARAMETERS (sdp munging of the fmtp line)
 *     Browsers negotiate ~32 kbit/s mono Opus with no in-band FEC.
 *     That is a 2011 default. We ask for up to 320 kbit/s stereo with
 *     in-band FEC on. Per RFC 7587, fmtp params on the SDP *we send*
 *     declare what WE want to RECEIVE — so both sides munge and both
 *     sides get the good stream.
 *
 *  2. RED — REDUNDANT AUDIO (RFC 2198)
 *     Each RTP packet carries a copy of the previous N audio frames.
 *     Lose a packet, the next one reconstructs it. This is the single
 *     biggest quality difference on a flaky connection and it is the
 *     available-today cousin of Opus 1.5's DRED (which Chromium does
 *     not expose yet). Costs ~2x audio bitrate. On P2P that's free.
 *     Negotiated with setCodecPreferences(), NOT sdp munging —
 *     Chromium rejects reordering a munged local description.
 *
 *  3. JITTER BUFFER TARGET
 *     Chromium's NetEq defaults to "never stutter", which parks
 *     100-200 ms of latency in the buffer. receiver.jitterBufferTarget
 *     lets us trade some of that back for responsiveness. Still
 *     adaptive — NetEq grows the buffer if the network deserves it.
 *
 *  4. ENCODER PARAMETERS
 *     maxBitrate + networkPriority on the sender, degradationPreference
 *     on video. Screen share stops being a 720p smear.
 *
 * ERROR PHILOSOPHY: every single one of these is a best-effort
 * enhancement. If a browser doesn't support a knob, we log and move
 * on — a call must NEVER fail because the audio engine got ambitious.
 */

import * as state from './state.js';
import * as mesh from './mesh-voice.js';
import * as devices from './devices.js';

const alog  = (...a) => console.log('[audio]', ...a);
const awarn = (...a) => console.warn('[audio]', ...a);

// ─── Profiles ─────────────────────────────────────────────────────
// `bitrate` is the Opus target in bit/s. `stereo` costs roughly double
// but is what makes music / room tone actually sound like a room.
export const PROFILES = {
  // Default. Mono, all browser DSP on, 96k — already ~1.5x what
  // Discord gives a non-Nitro user, and with FEC + RED on top.
  voice: {
    label: 'Voice',
    bitrate: 96000,
    stereo: false,
    dtx: false,
    ptime: 20,
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    },
    contentHint: 'speech',
  },
  // Full fidelity. Browser DSP OFF — no echo canceller mangling the
  // low end, no AGC pumping. REQUIRES HEADPHONES or you will echo.
  studio: {
    label: 'Studio',
    bitrate: 320000,
    stereo: true,
    dtx: false,
    ptime: 20,
    constraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
    },
    contentHint: 'music',
  },
  // Tethering / bad hotel wifi. DTX on so silence costs nothing.
  lowband: {
    label: 'Low bandwidth',
    bitrate: 24000,
    stereo: false,
    dtx: true,
    ptime: 40,
    constraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
    },
    contentHint: 'speech',
  },
};

// Jitter buffer targets in ms. `balanced` is roughly Chromium's own
// behaviour; `low` is the one to demo on a decent connection.
// `balanced` is now null = leave NetEq alone. jitterBufferTarget
// acts as a FLOOR in Chromium, so the old 100 ms added latency on every
// good connection instead of matching the browser's own behaviour.
export const LATENCY_TARGETS = { low: 40, balanced: null, stable: 250 };

// Video send ceilings. Screen share gets the lion's share because a
// blurry screen share is the #1 thing people complain about elsewhere.
const VIDEO_BITRATE = { screen: 3_000_000, cam: 1_500_000 };

export function profile() {
  return PROFILES[state.state.audioProfile] || PROFILES.voice;
}
function redundancyOn()  { return state.state.audioRedundancy !== 'off'; }
function latencyTarget() {
  const k = state.state.audioLatency;
  return (k in LATENCY_TARGETS) ? LATENCY_TARGETS[k] : LATENCY_TARGETS.balanced;
}

// ═══════════════════════════════════════════════════════════════════
//  1. MIC CONSTRAINTS
// ═══════════════════════════════════════════════════════════════════
/**
 * Build the getUserMedia audio constraints for the active profile.
 * When the RNNoise denoiser is enabled we force the browser's own
 * noise suppression OFF — stacking two suppressors sounds worse than
 * either one alone, and RNNoise is the better of the two.
 */
export function micConstraints() {
  const p = profile();
  const c = { ...p.constraints };
  if (state.state.denoise === 'on') c.noiseSuppression = false;
  // Chromium-only extras. Unknown keys in the top-level dict would
  // throw, so they live under a vendor-prefixed sub-object which
  // Chromium reads and every other engine ignores.
  return {
    audio: {
      ...c,
      // Explicit device beats the OS default. The OS default is how you
      // end up recording Stereo Mix instead of a microphone.
      ...devices.inputConstraint(),
      // Ask for the smallest buffer the device will give us.
      latency: 0.01,
      googAudioMirroring: false,
    },
    video: false,
  };
}

/** Tag the mic track so Chromium's encoder knows what it's carrying. */
export function hintMicTrack(stream) {
  if (!stream) return;
  const hint = state.state.denoise === 'on' ? 'music' : profile().contentHint;
  for (const t of stream.getAudioTracks()) {
    try { t.contentHint = hint; } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════════════
//  2. SDP MUNGING — Opus fmtp
// ═══════════════════════════════════════════════════════════════════
/**
 * Rewrite the Opus fmtp line in an outgoing offer/answer.
 *
 * IMPORTANT: this is applied ONLY to the SDP string we put on the
 * wire, never fed back into setLocalDescription(). Chromium tolerates
 * fmtp munging on the remote side; it rejects several kinds of munged
 * *local* descriptions, and we don't need it locally anyway.
 */
export function mungeOpus(sdpText) {
  if (!sdpText || typeof sdpText !== 'string') return sdpText;
  const p = profile();
  try {
    const lines = sdpText.split(/\r\n|\n/);
    // Find every Opus payload type (there can be more than one m-line).
    const opusPts = [];
    for (const l of lines) {
      const m = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(l);
      if (m) opusPts.push(m[1]);
    }
    if (!opusPts.length) return sdpText;

    const params = [
      'minptime=10',
      'useinbandfec=1',                       // Opus's own FEC, always on
      `usedtx=${p.dtx ? 1 : 0}`,
      'maxplaybackrate=48000',
      'sprop-maxcapturerate=48000',
      `maxaveragebitrate=${p.bitrate}`,
      `stereo=${p.stereo ? 1 : 0}`,
      `sprop-stereo=${p.stereo ? 1 : 0}`,
      'cbr=0',
    ].join(';');

    const out = [];
    for (const line of lines) {
      let l = line;
      for (const pt of opusPts) {
        if (l.startsWith(`a=fmtp:${pt} `)) {
          l = `a=fmtp:${pt} ${params}`;
        }
      }
      out.push(l);
      // Some SDPs omit the fmtp line entirely — synthesise it right
      // after the rtpmap so our params still land.
      const rm = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line);
      if (rm && !lines.some(x => x.startsWith(`a=fmtp:${rm[1]} `))) {
        out.push(`a=fmtp:${rm[1]} ${params}`);
      }
    }

    let sdp = out.join('\r\n');
    // ptime tells the peer how much audio to pack per packet. 20 ms is
    // the sweet spot; 40 ms halves header overhead for low-bandwidth.
    if (p.ptime && !/a=ptime:/.test(sdp)) {
      sdp = sdp.replace(/(a=rtpmap:\d+\s+opus\/48000[^\r\n]*\r\n)/i,
                        `$1a=ptime:${p.ptime}\r\n`);
    }
    return sdp;
  } catch (e) {
    awarn('mungeOpus failed, sending untouched SDP', e);
    return sdpText;
  }
}

/** Convenience: munge a description object into a wire-ready JSON string. */
export function wireDescription(desc, sid) {
  try {
    // `sid` identifies the PC this description came from. Older
    // peers ignore the extra field.
    return JSON.stringify({ type: desc.type, sdp: mungeOpus(desc.sdp), ...(sid ? { sid } : {}) });
  } catch (e) {
    awarn('wireDescription failed', e);
    return JSON.stringify(desc);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  3. RED — redundant audio encoding
// ═══════════════════════════════════════════════════════════════════
let _redAvailable = null;
export function redAvailable() {
  if (_redAvailable !== null) return _redAvailable;
  try {
    const caps = RTCRtpSender.getCapabilities('audio');
    _redAvailable = !!caps?.codecs?.some(c => /red$/i.test(c.mimeType));
  } catch (e) { _redAvailable = false; }
  return _redAvailable;
}

/**
 * Put RED (and then Opus) at the front of the audio codec list for
 * every audio transceiver on this PC. Must be called BEFORE the
 * offer/answer for that transceiver is created.
 *
 * If RED isn't available or the call throws, negotiation simply falls
 * back to plain Opus — which is exactly what we had before.
 */
export function preferRedundantAudio(pc) {
  if (!redundancyOn() || !redAvailable()) return false;
  let applied = false;
  try {
    const caps = RTCRtpSender.getCapabilities('audio');
    if (!caps?.codecs) return false;
    const red   = caps.codecs.filter(c => /red$/i.test(c.mimeType));
    const opus  = caps.codecs.filter(c => /opus$/i.test(c.mimeType));
    const rest  = caps.codecs.filter(c => !/red$|opus$/i.test(c.mimeType));
    const order = [...red, ...opus, ...rest];
    for (const t of pc.getTransceivers()) {
      const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
      if (kind && kind !== 'audio') continue;
      if (!t.setCodecPreferences) continue;
      try { t.setCodecPreferences(order); applied = true; }
      catch (e) { awarn('setCodecPreferences rejected', e?.message); }
    }
    if (applied) alog('RED preferred for audio');
  } catch (e) {
    awarn('preferRedundantAudio failed', e);
  }
  return applied;
}

// ═══════════════════════════════════════════════════════════════════
//  4. RECEIVER + SENDER TUNING
// ═══════════════════════════════════════════════════════════════════
/** Shrink the playout buffer on an inbound audio receiver. */
export function tuneReceiver(receiver, kind) {
  if (!receiver || kind !== 'audio') return;
  const ms = latencyTarget();
  try {
    // Standardised (Chromium 114+). Milliseconds; null = browser default.
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = ms;
    // Legacy name, seconds. Only touch it where the standard one is missing.
    else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = ms == null ? null : ms / 1000;
  } catch (e) { awarn('jitterBufferTarget rejected', e?.message); }
}

export function tuneAllReceivers(pc) {
  try {
    for (const r of pc.getReceivers()) tuneReceiver(r, r.track?.kind);
  } catch (e) {}
}

/**
 * Raise the send ceiling and mark our media as latency-sensitive.
 * Encodings only exist once the transceiver has been negotiated, so
 * this is called again on connectionstatechange → connected.
 */
export async function tuneSenders(pc, senderKinds) {
  if (!pc) return;
  const p = profile();
  for (const sender of pc.getSenders?.() || []) {
    const track = sender.track;
    if (!track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const e0 = params.encodings[0];

      if (track.kind === 'audio') {
        e0.maxBitrate = p.bitrate;
        e0.networkPriority = 'high';
        e0.priority = 'high';
        delete e0.scaleResolutionDownBy;
      } else {
        const isScreen = senderKinds?.screen?.includes(sender) ||
                         track.contentHint === 'detail' ||
                         track.contentHint === 'text';
        e0.maxBitrate = isScreen ? VIDEO_BITRATE.screen : VIDEO_BITRATE.cam;
        e0.networkPriority = 'high';
        e0.priority = 'high';
        // Screen shares should stay sharp and drop frames; cameras
        // should stay smooth and drop pixels.
        params.degradationPreference = isScreen
          ? 'maintain-resolution'
          : 'maintain-framerate';
      }
      await sender.setParameters(params);
    } catch (e) {
      awarn('setParameters failed for', track.kind, e?.message);
    }
  }
}

/** Tag video tracks so the encoder picks the right strategy. */
export function hintVideoTrack(stream, kind) {
  if (!stream) return;
  for (const t of stream.getVideoTracks()) {
    try { t.contentHint = kind === 'screen' ? 'detail' : 'motion'; } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════════════
//  5. LIVE CALL STATS
// ═══════════════════════════════════════════════════════════════════
// Per-peer link telemetry, sampled once a second. This is both a
// debugging tool and — bluntly — the demo weapon: it shows the call is
// direct peer-to-peer with no server in the path.

const statsCache = new Map();   // pid -> snapshot
const statsPrev  = new Map();   // pid -> raw counters from last poll
let statsTimer = null;
let getConns = null;

export function setConnsGetter(fn) { getConns = fn; }
export function getStatsFor(pid)   { return statsCache.get(pid) || null; }
export function allStats()         { return statsCache; }

export function startStats() {
  stopStats();
  statsTimer = setInterval(pollStats, 1000);
}
export function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  statsCache.clear();
  statsPrev.clear();
  renderHud();
}

async function pollStats() {
  if (!getConns) return;
  const conns = getConns();
  if (!conns || !conns.size) { statsCache.clear(); renderHud(); return; }

  for (const [pid, rec] of conns) {
    try {
      const report = await rec.pc.getStats();
      const snap = summarise(report, pid);
      if (snap) statsCache.set(pid, snap);
    } catch (e) { /* pc may have closed mid-poll */ }
  }
  for (const pid of [...statsCache.keys()]) {
    if (!conns.has(pid)) { statsCache.delete(pid); statsPrev.delete(pid); }
  }
  renderHud();
}

function summarise(report, pid) {
  let inAudio = null, outAudio = null, pair = null, remoteIn = null;
  const codecs = new Map();

  report.forEach(r => {
    if (r.type === 'codec') codecs.set(r.id, r);
    else if (r.type === 'inbound-rtp'  && r.kind === 'audio') inAudio  = r;
    else if (r.type === 'outbound-rtp' && r.kind === 'audio') outAudio = r;
    else if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') remoteIn = r;
    else if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) {
      if (!pair || (r.bytesSent || 0) > (pair.bytesSent || 0)) pair = r;
    }
  });

  const prev = statsPrev.get(pid) || {};
  const now  = Date.now();
  const dt   = prev.at ? (now - prev.at) / 1000 : 0;

  const kbps = (cur, was) =>
    dt > 0 && was != null && cur != null
      ? Math.max(0, Math.round(((cur - was) * 8) / dt / 1000))
      : null;

  // Packet loss over the sampling window, not since the call started —
  // a cumulative figure hides a burst that just happened.
  let lossPct = null;
  if (inAudio && prev.pktRecv != null && prev.pktLost != null) {
    const dRecv = (inAudio.packetsReceived || 0) - prev.pktRecv;
    const dLost = (inAudio.packetsLost || 0) - prev.pktLost;
    const total = dRecv + dLost;
    if (total > 0) lossPct = Math.max(0, (dLost / total) * 100);
  }

  const codecName = (rtp) => {
    const c = rtp && codecs.get(rtp.codecId);
    if (!c) return null;
    return String(c.mimeType || '').split('/')[1]?.toUpperCase() || null;
  };

  // Buffer delay is reported as a running total over emitted samples.
  let jbMs = null;
  if (inAudio && inAudio.jitterBufferEmittedCount > 0) {
    jbMs = (inAudio.jitterBufferDelay / inAudio.jitterBufferEmittedCount) * 1000;
  }

  const snap = {
    pid,
    rttMs:   pair?.currentRoundTripTime != null
               ? pair.currentRoundTripTime * 1000
               : (remoteIn?.roundTripTime != null ? remoteIn.roundTripTime * 1000 : null),
    jitterMs: inAudio?.jitter != null ? inAudio.jitter * 1000 : null,
    lossPct,
    jbMs,
    inKbps:  kbps(inAudio?.bytesReceived, prev.bytesIn),
    outKbps: kbps(outAudio?.bytesSent,    prev.bytesOut),
    codecIn:  codecName(inAudio),
    codecOut: codecName(outAudio),
    // 'host' = same LAN, 'srflx'/'prflx' = direct across the internet,
    // 'relay' = going through a TURN server (we ship none, so this
    // should never appear — if it does, something is misconfigured).
    path: pair?.remoteCandidateType || pair?.localCandidateType || null,
    localType: pair?.localCandidateType || null,
    fecPackets: inAudio?.fecPacketsReceived ?? null,
    concealMs: inAudio?.concealedSamples != null && inAudio?.totalSamplesReceived
      ? (inAudio.concealedSamples / inAudio.totalSamplesReceived) * 100
      : null,
    at: now,
  };

  statsPrev.set(pid, {
    at: now,
    bytesIn:  inAudio?.bytesReceived,
    bytesOut: outAudio?.bytesSent,
    pktRecv:  inAudio?.packetsReceived,
    pktLost:  inAudio?.packetsLost,
  });

  return snap;
}

// ─── HUD rendering ────────────────────────────────────────────────
function grade(s) {
  // Simple traffic light so the number-blind still get the message.
  const loss = s.lossPct ?? 0, rtt = s.rttMs ?? 0;
  if (loss > 5 || rtt > 300) return 'bad';
  if (loss > 1.5 || rtt > 150) return 'warn';
  return 'good';
}
const n1 = v => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
const n0 = v => (v == null ? '—' : Math.round(v).toString());

export function renderHud() {
  const host = document.querySelector('#call-stats');
  if (!host) return;
  if (host.classList.contains('hidden')) return;

  // Peers reached only over the Hyperswarm link have no PC and no RTP
  // stats — show them from mesh telemetry alone.
  const rowsSrc = [...statsCache.values()];
  for (const pid of mesh.swarmPeers()) {
    if (!statsCache.has(pid) && mesh.statsFor(pid)) rowsSrc.push({ pid, path: 'swarm' });
  }
  if (!rowsSrc.length) {
    host.innerHTML = '<div class="cs-empty">No active links.</div>';
    return;
  }

  const nameFor = pid => {
    const p = state.peers.get(pid);
    return (p && p.nickname) ? p.nickname : String(pid).slice(0, 8);
  };
  const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };

  const rows = rowsSrc.map(s => {
    const m0 = mesh.statsFor(s.pid);
    const viaSwarm = m0 && m0.link === 'swarm';
    const direct = viaSwarm || (s.path && s.path !== 'relay');
    const red = /RED/.test(s.codecIn || '');
    // When mesh owns this peer's audio, the WebRTC audio counters are
    // measuring an idle track. Show OUR numbers instead — they are the
    // ones that describe what the person is actually hearing.
    const m = mesh.statsFor(s.pid);

    const audioRow = m ? `
        <div class="cs-grid">
          <span><i>ping</i>${n0(s.rttMs)} ms</span>
          <span><i>gaps</i>${n1(m.lossPct)} %</span>
          <span><i>target</i>${n0(m.targetMs)} ms</span>
          <span><i>buffer</i>${n0(m.bufferedMs)} ms</span>
          <span><i>rescued</i>${n0(m.recovered)}</span>
          <span><i>spares</i>${n0(m.duplicates)}</span>
          <span><i>too late</i>${n0(m.late)}</span>
          <span><i>underrun</i>${n0(m.underruns)}</span>
          <span><i>rx pkts</i>${n0(m.rxPackets)}</span>
          <span><i>tx pkts</i>${n0(m.sent)}</span>
          <span><i>tx drop</i>${n0(m.dropped)}</span>
          <span><i>malformed</i>${n0(m.rxBad)}</span>
        </div>` : `
        <div class="cs-grid">
          <span><i>ping</i>${n0(s.rttMs)} ms</span>
          <span><i>loss</i>${n1(s.lossPct)} %</span>
          <span><i>jitter</i>${n1(s.jitterMs)} ms</span>
          <span><i>buffer</i>${n0(s.jbMs)} ms</span>
          <span><i>down</i>${n0(s.inKbps)} kb/s</span>
          <span><i>up</i>${n0(s.outKbps)} kb/s</span>
          <span><i>codec</i>${esc(s.codecIn || '—')}</span>
          <span><i>gaps</i>${n1(s.concealMs)} %</span>
        </div>`;

    const g = m ? (m.lossPct > 5 ? 'bad' : m.lossPct > 1.5 ? 'warn' : 'good') : grade(s);

    return `
      <div class="cs-row cs-${g}">
        <div class="cs-peer">
          <span class="cs-dot"></span>${esc(nameFor(s.pid))}
          <span class="cs-tag ${direct ? 'ok' : 'warn'}">${viaSwarm ? 'SWARM LINK' : direct ? 'DIRECT P2P' : 'RELAYED'}</span>
          ${m ? (viaSwarm ? '<span class="cs-tag mesh">MESH · NOISE</span>'
                          : `<span class="cs-tag mesh">MESH ${m.copies}\u00d7@${m.spacing}</span>`)
               : (red ? '<span class="cs-tag ok">RED</span>' : '')}
        </div>
        ${audioRow}
      </div>`;
  }).join('');

  host.innerHTML =
    `<div class="cs-hd">LINK TELEMETRY · ${PROFILES[state.state.audioProfile]?.label || 'Voice'}` +
    `${redundancyOn() && redAvailable() ? ' · redundancy on' : ''}` +
    `${state.state.denoise === 'on' ? ' · denoise on' : ''}` +
    `${state.state.meshVoice === 'on' ? ' · mesh armed' : ''}</div>` + rows;
}

export function toggleHud() {
  const host = document.querySelector('#call-stats');
  if (!host) return;
  host.classList.toggle('hidden');
  const btn = document.querySelector('#btn-call-stats');
  if (btn) btn.classList.toggle('act', !host.classList.contains('hidden'));
  renderHud();
}

/** One-line summary for logs / bug reports. */
export function summaryLine() {
  const parts = [];
  for (const s of statsCache.values()) {
    parts.push(`${String(s.pid).slice(0, 6)} rtt=${n0(s.rttMs)}ms loss=${n1(s.lossPct)}% ` +
               `jb=${n0(s.jbMs)}ms ${s.codecIn || '?'} ${s.path || '?'}`);
  }
  return parts.join(' | ') || 'no links';
}
