/**
  //  DESIGN (inspired by Jitsi/Discord P2P mode):
  //
  //  The "already-there calls newcomer" rule:
  //  ┌───────────────────────────────────────────────────────────────┐
  //  │ When I join voice, I BROADCAST `VOICE_JOIN`.                  │
  //  │ When I receive `VOICE_JOIN` from someone else AND I'm already │
  //  │ in voice, I → call them. (I createOffer, they createAnswer.)  │
  //  │ When I send `VOICE_JOIN` and nobody is in voice yet, I wait.  │
  //  │ When someone else later joins, THEY call ME via this rule.    │
  //  └───────────────────────────────────────────────────────────────┘
  //  This eliminates glare. Exactly one side is ever the caller for
  //  any given pair, determined by join order — not by peer-id magic.
  //
  //  Heartbeat (`VOICE_JOIN` re-broadcast every 5s) is purely for
  //  reliability: if my initial broadcast was dropped (e.g. buffered
  //  during KEY_EXCHANGE), a re-broadcast catches it. Peers already
  //  connected to me ignore re-JOINs.
  //
  //  ERROR PHILOSOPHY: every try/catch logs via console.warn so real
  //  failures show up when you open devtools. Silent failure is what
  //  made earlier versions hard to debug.
  // ═══════════════════════════════════════════════════════════════════
 * Voice / video / file-send — the WebRTC stack, call screen, screen+cam
 * sharing, voice activity meters, and the chunked file sender. Owns its own
 * voice/video state internally; external code queries via the getters
 * (isOn / getRoom / getChannel / isMuted / …).
 *
 * Wiring (called once from app.js boot):
 *   SirrVoice.setDeps({...})  — supply state getters + cross-module fns
 *   SirrVoice.init()          — wire DOM listeners (mute/deaf/screen/cam buttons)
 *
 * Bridge handlers (from app.js's onVoiceSignal / onFileTransfer wiring):
 *   SirrVoice.handleVoiceSignal(i)
 *   SirrVoice.handleFileTransfer(ft)
 *   SirrVoice.handlePeerLeft(pid)
 *   SirrVoice.handleNewPeer(p, roomsList)
 *
 * Loaded via plain <script src> after toasts/admin-panel/peers, before app.js.
 */
import * as state from './state.js';
import * as glyphs from './glyphs.js';
import * as toasts from './toasts.js';
import * as admin from './admin-panel.js';
import * as rooms from './rooms.js';
import * as chat from './chat.js';
import * as peers from './peers.js';
import * as audio from './audio-engine.js';
import * as denoise from './denoise.js';
import * as mesh from './mesh-voice.js';
import { mountFigure } from './figure.js';
import * as devices from './devices.js';

  // ─── Constants (mirror app.js values) ─────────────────────────────
  const RTC = state.RTC;
  const VM = state.VM;  // { OFFER: 0x10, ANSWER: 0x11, ICE: 0x12, LEAVE: 0x13, JOIN: 0x14 }
  const FT = state.FT;  // { START: 0x20, CHUNK: 0x21, END: 0x22 }
  const CHUNK = state.CHUNK;  // 512 * 1024
  const MAX_INBOUND_FILE_BYTES = 512 * 1024 * 1024;
  // Derive the chunk ceiling from the ACTUAL chunk size (+ generous slack), not
  // a hardcoded 1 KB assumption — otherwise a chunk-size change silently makes
  // this guard meaningless or wrong.
  const MAX_INBOUND_FILE_CHUNKS = Math.ceil(MAX_INBOUND_FILE_BYTES / CHUNK) + 16;
  const PC_STUCK_MS = state.PC_STUCK_MS;  // 8000
  // Levels are 0..128 on a dBFS scale (see levelOf): 0 = -60 dBFS or
  // quieter, 128 = -10 dBFS. Gate thresholds sit on that same scale:
  // low ≈ -50 dB, mid ≈ -42 dB, high ≈ -34 dB.
  const NOISE_GATE = { off: 0, low: 26, mid: 46, high: 67 };
  const SPEAKING = 40;            // ≈ -44 dBFS
  const _vaBuf = new Float32Array(512);
  /** RMS of the analyser's current window → 0..128 on a -60…-10 dBFS scale. */
  function levelOf(an) {
    an.getFloatTimeDomainData(_vaBuf);
    let e = 0; for (let i = 0; i < _vaBuf.length; i++) e += _vaBuf[i] * _vaBuf[i];
    const rms = Math.sqrt(e / _vaBuf.length);
    if (rms <= 1e-6) return 0;
    const db = 20 * Math.log10(rms);
    return Math.max(0, Math.min(1, (db + 60) / 50)) * 128;
  }

  // ─── Voice state (owned by this module) ───────────────────────────
  let voiceOn = state.state.voiceOn, voiceRoom = state.state.voiceRoom, voiceChannel = state.state.voiceChannel;
  let muted = state.state.muted, deafened = state.state.deafened, noMic = state.state.noMic;

  let localStream = state.vcState.localStream, screenStream = state.vcState.screenStream, camStream = state.vcState.camStream;
  // The untouched device stream. When RNNoise is on, `localStream` is
  // the processed output and this is the raw capture we must stop
  // separately or the mic light stays on.
  let rawMicStream = null;
  let screenSharing = state.vcState.screenSharing, camSharing = state.vcState.camSharing;
  let localAnalyser = state.vcState.localAnalyser, localSpeaking = state.vcState.localSpeaking, localLevel = state.vcState.localLevel;
  let vcHeartbeat = state.vcState.vcHeartbeat, vaPoller = state.vcState.vaPoller;
  let callScreenOpen = state.vcState.callScreenOpen, focusedTileKey = state.vcState.focusedTileKey;
  const voiceConns    = state.voiceConns;   // peerId -> { pc, audioEl, polite, makingOffer, ignoreOffer, ... }
  const voiceActivity = state.voiceActivity;   // peerId -> { analyser, level }
  const peerVideos    = state.peerVideos;   // peerId -> Map<key, { stream, kind, label }>
  const voicePeers    = state.voicePeers;   // peerId -> { room, channel }
  const incomingFiles = state.incomingFiles;   // fileId -> { chunks, received, total, ... }
  const fileBlobs     = state.fileBlobs;   // msgId -> blob URL (session-only)

  const pendingICE    = state.pendingICE;   // peerId -> RTCIceCandidateInit[]
  const screenPopups  = state.screenPopups;   // key -> { window, stream }
  let audioCtx = null;
  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function downloadUrl(u, fn) {
    const a = document.createElement('a');
    a.href = u; a.download = fn;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function beep() {
    if (state.state.notifSound !== 'on') return;
    try {
      const c = getCtx(), o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = 'sine'; o.frequency.setValueAtTime(880, c.currentTime);
      g.gain.setValueAtTime(0.07, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.25);
      o.start(); o.stop(c.currentTime + 0.25);
    } catch (e) {}
  }
  
  function notify() {
    try {
      const s = state.state;
      s.voiceOn       = voiceOn;
      s.voiceRoom     = voiceRoom;
      s.voiceChannel  = voiceChannel;
      s.muted         = muted;
      s.deafened      = deafened;
      s.noMic         = noMic;
      s.screenSharing = screenSharing;
      s.camSharing    = camSharing;
      s.callScreenOpen= callScreenOpen;
    } catch (e) {}
  }

  // ─── Local helpers ────────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function fmtSize(b) {
    if (!b) return '0B';
    return b < 1024 ? b + 'B'
         : b < 1048576 ? (b / 1024).toFixed(1) + 'KB'
         : (b / 1048576).toFixed(1) + 'MB';
  }
  function avatarHtmlLocal(nickname, emoji, image, seed) {
    return glyphs.avatarHtml(nickname, emoji, image, seed || nickname);
  }
  
  function vlog(...a)  { console.log('[voice]', ...a); }
  function vwarn(...a) { console.warn('[voice]', ...a); }

  // ─── State getters (for external queries) ─────────────────────────
  const isOn            = () => voiceOn;
  const getRoom         = () => voiceRoom;
  const getChannel      = () => voiceChannel;
  const isMuted         = () => muted;
  const isDeafened      = () => deafened;
  const isScreenSharing = () => screenSharing;
  const isCamSharing    = () => camSharing;
  const hasNoMic        = () => noMic;
  // Shared collections so peers.js can keep showing voice/video badges.
  const getVoicePeersMap = () => voicePeers;
  const getPeerVideosMap = () => peerVideos;
  const getVoiceActivity = () => voiceActivity;
  const getVoiceConns    = () => voiceConns;

  // ═══════════════════════════════════════════════════════════════════
  //  PEER CONNECTIONS — Perfect Negotiation, done correctly
  // ═══════════════════════════════════════════════════════════════════
  // WHY THIS WAS REWRITTEN
  // The previous version treated a PC in `have-local-offer` as "ready for
  // an offer". When two peers offered at the same time (simultaneous
  // join, or both re-calling after a network blip) BOTH sides rolled
  // back their own offer and answered the other's. Each side then held
  // an answer as its local description, both picked DTLS role `active`,
  // ICE used ufrags from offers that had been rolled back, and the PC
  // went connecting → failed → rebuilt → failed, forever. That is the
  // "voice bugs out with some people" loop, reproduced in a harness with
  // 120 ms of signaling latency.
  //
  // The rules now, straight from the W3C PN pattern:
  //   readyForOffer = !makingOffer && (stable || settingRemoteAnswer)
  //   impolite side IGNORES a colliding offer
  //   polite side rolls back (implicitly, via SRD) and answers
  //
  // SESSION IDS
  // Every PC carries a random `sid`, stamped on its OFFER / ANSWER / ICE.
  // If a peer tears down and rebuilds its PC, its next offer arrives with
  // a new sid and we rebuild ours to match instead of feeding a fresh
  // DTLS fingerprint into a stale connection (which Chromium rejects).
  // Stale ICE candidates from a dead PC are dropped by sid. Peers on
  // older builds send no sid and get exactly the old behaviour.
  function isPolite(pid) { return String(state.state.myPeerId) > String(pid); }
  const newSid = () => Math.random().toString(36).slice(2, 10);

  // Recovery bookkeeping that must outlive a single PC.
  const peerHealth = new Map();   // pid -> { failures, retryTimer, warned, lastJoinReplyAt }
  function health(pid) {
    let h = peerHealth.get(pid);
    if (!h) { h = { failures: 0, retryTimer: null, warned: false, lastJoinReplyAt: 0 }; peerHealth.set(pid, h); }
    return h;
  }
  function clearRetry(pid) {
    const h = peerHealth.get(pid);
    if (h && h.retryTimer) { clearTimeout(h.retryTimer); h.retryTimer = null; }
  }

  // Serialise all signaling work per peer. Handlers are async; without a
  // queue an ICE candidate or a second offer can run in the middle of an
  // SRD/SLD pair and see half-applied state.
  function enqueue(pid, fn) {
    const rec = voiceConns.get(pid);
    const run = () => fn().catch(e => vwarn('signal task failed for', pid, e?.message || e));
    if (!rec) return run();
    rec.chain = (rec.chain || Promise.resolve()).then(run, run);
    return rec.chain;
  }

  function sendSig(pid, type, obj) {
    try {
      window.sirr.sendVoiceSignal(pid, type, typeof obj === 'string' ? obj : JSON.stringify(obj), voiceRoom, voiceChannel);
    } catch (e) { vwarn('send signal failed', e); }
  }

  function currentMicTrack() {
    return (localStream && localStream.getAudioTracks()[0]) || null;
  }

  /**
   * @param {string} pid
   * @param {{asCaller?:boolean}} opts  asCaller → we are about to offer.
   *        A caller with nothing to send (listen-only, no mesh channel)
   *        still needs an m-line or no offer is ever generated.
   */
  function mkPC(pid, opts = {}) {
    const pc = new RTCPeerConnection(RTC);
    const rec = {
      pc, audioEl: null,
      sid: newSid(),
      remoteSid: null,
      polite: isPolite(pid),
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      chain: Promise.resolve(),
      screenSenders: [],
      camSenders: [],
      audioSender: null,
      meshTx: false,        // mesh carries our audio to this peer → WebRTC sender idle
      meshRx: false,        // mesh carries their audio to us → WebRTC element muted
      createdAt: Date.now(),
      lastProgress: Date.now(),
      everConnected: false,
      discTimer: null,
    };
    voiceConns.set(pid, rec);

    // A rebuilt PC inherits whatever mesh is already doing for this peer
    // (e.g. audio flowing over the swarm link while ICE retries).
    rec.meshTx = mesh.isTxActive(pid);
    rec.meshRx = mesh.isMeshActive(pid);
    const mic = currentMicTrack();
    if (mic) {
      rec.audioSender = pc.addTrack(mic, localStream);
      if (rec.meshTx) rec.audioSender.replaceTrack(null).catch(() => {});
    } else if (opts.asCaller) {
      // Listen-only caller: ask to receive audio so an offer exists.
      try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch (e) {}
    }
    if (screenStream) {
      for (const t of screenStream.getTracks()) rec.screenSenders.push(pc.addTrack(t, screenStream));
    }
    if (camStream) {
      for (const t of camStream.getTracks()) rec.camSenders.push(pc.addTrack(t, camStream));
    }

    // ─── Mesh voice channel ──────────────────────────────────────
    // Unordered, zero-retransmit: a datagram pipe. The impolite side
    // creates it, the polite side receives it — one channel per pair.
    if (mesh.isEnabled() && mesh.isSupported() && !rec.polite) {
      try {
        const dc = pc.createDataChannel(mesh.DC_LABEL, { ordered: false, maxRetransmits: 0 });
        mesh.attachDc(pid, dc);
      } catch (e) { vwarn('mesh channel create failed', e); }
    }
    pc.ondatachannel = (ev) => {
      if (ev.channel?.label !== mesh.DC_LABEL) return;
      if (!mesh.isEnabled() || !mesh.isSupported()) { try { ev.channel.close(); } catch (e) {} return; }
      mesh.attachDc(pid, ev.channel);
    };

    // Swarm fallback runs IN PARALLEL with ICE: if this PC hasn't
    // connected in 5 s, voice starts flowing over the Hyperswarm link
    // while WebRTC keeps trying. Once WebRTC connects, swarm goes idle.
    rec.fallbackTimer = setTimeout(() => {
      rec.fallbackTimer = null;
      if (voiceConns.get(pid) === rec && !rec.everConnected) enableSwarm(pid, 'no direct link after 5 s');
    }, 5000);

    // Codec preferences MUST be set before the first offer is built.
    audio.preferRedundantAudio(pc);

    pc.onnegotiationneeded = () => enqueue(pid, async () => {
      if (!voiceOn || !voiceRoom || voiceConns.get(pid) !== rec) return;
      if (pc.signalingState !== 'stable') return;   // PN re-fires once stable
      try {
        rec.makingOffer = true;
        audio.preferRedundantAudio(pc);
        await pc.setLocalDescription();
        if (!pc.localDescription || pc.localDescription.type !== 'offer') return;
        vlog('→ OFFER to', pid, 'sid', rec.sid);
        sendSig(pid, VM.OFFER, audio.wireDescription(pc.localDescription, rec.sid));
      } finally {
        rec.makingOffer = false;
      }
    });

    pc.ontrack = ev => {
      vlog('ontrack from', pid, 'kind=', ev.track.kind);
      audio.tuneReceiver(ev.receiver, ev.track.kind);
      if (ev.track.kind === 'video') {
        const stream = ev.streams[0] || new MediaStream([ev.track]);
        let isScreen = false;
        try {
          const st = ev.track.getSettings ? ev.track.getSettings() : {};
          isScreen = !!st.displaySurface;
        } catch (e) {}
        const nick = state.peers.get(pid)?.nickname || 'Peer';
        const label = nick + (isScreen ? ' — Screen' : ' — Camera');
        const key = String(pid) + '|' + String(stream.id || ev.track.id);
        if (!peerVideos.has(pid)) peerVideos.set(pid, new Map());
        peerVideos.get(pid).set(key, { stream, kind: isScreen ? 'screen' : 'cam', label });
        renderCallGrid();
        peers.updatePeers();
        const dropVideo = () => {
          closeScreenPopup(key);
          const pv = peerVideos.get(pid);
          if (pv) { pv.delete(key); if (!pv.size) peerVideos.delete(pid); }
          renderCallGrid();
          peers.updatePeers();
        };
        ev.track.addEventListener('ended', dropVideo);
        // A removed remote track goes `muted`, not `ended`, in Chromium.
        ev.track.addEventListener('mute', () => {
          if (ev.transceiver && /inactive|sendonly/.test(ev.transceiver.currentDirection || '')) dropVideo();
        });
        try { stream.addEventListener('removetrack', dropVideo); } catch (e) {}
        return;
      }
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      attachRemoteAudio(pid, stream);
      setupVA(pid, stream);
      renderVU();
      renderCallGrid();
    };

    pc.onicecandidate = ev => {
      if (!ev.candidate) return;
      const c = ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate;
      sendSig(pid, VM.ICE, { ...c, sid: rec.sid });
    };

    pc.onsignalingstatechange = () => {
      rec.lastProgress = Date.now();
      // Senders only have encodings after negotiation — re-apply the
      // bitrate ceilings every time a (re)negotiation lands, not just on
      // first connect, or a screen share added mid-call is never tuned.
      if (pc.signalingState === 'stable' && pc.connectionState === 'connected') {
        audio.tuneSenders(pc, { screen: rec.screenSenders, cam: rec.camSenders });
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      rec.lastProgress = Date.now();
      vlog('pc', pid, 'state →', st);
      if (voiceConns.get(pid) !== rec) return;
      if (st === 'connected') {
        rec.everConnected = true;
        const h = health(pid);
        h.failures = 0; h.warned = false;
        clearRetry(pid);
        if (rec.discTimer) { clearTimeout(rec.discTimer); rec.discTimer = null; }
        audio.tuneSenders(pc, { screen: rec.screenSenders, cam: rec.camSenders });
        audio.tuneAllReceivers(pc);
      } else if (st === 'disconnected') {
        // Usually a wifi hiccup that heals itself. If it doesn't within a
        // few seconds, the impolite side restarts ICE (one side only, so
        // the two restarts don't collide).
        if (rec.discTimer) clearTimeout(rec.discTimer);
        rec.discTimer = setTimeout(() => {
          rec.discTimer = null;
          if (voiceConns.get(pid) !== rec || pc.connectionState !== 'disconnected') return;
          if (!rec.polite && pc.restartIce) { vlog('ICE restart →', pid); try { pc.restartIce(); } catch (e) {} }
        }, 4000);
      } else if (st === 'failed') {
        onPcFailed(pid, rec);
      }
      renderVU();
    };

    return rec;
  }

  // A failed PC is torn down and rebuilt with exponential backoff. Before
  // this, a failure closed the PC and nothing re-called until a heartbeat
  // happened to line up, and both sides re-calling at once hit the glare
  // bug above.
  function onPcFailed(pid, rec) {
    const h = health(pid);
    h.failures++;
    vwarn('pc to', pid, 'failed (#' + h.failures + ')');
    closeVC(pid);
    if (!voiceOn || !voicePeers.has(pid)) return;
    const swarmOk = enableSwarm(pid, 'direct link failed');
    if (h.failures === 3 && !h.warned && !swarmOk) {
      h.warned = true;
      const nick = state.peers.get(pid)?.nickname || 'a peer';
      toasts.showToast({
        type: 'warn',
        title: 'VOICE LINK UNSTABLE',
        body: 'Cannot hold a direct voice link with <b>' + esc(nick) + '</b>. ' +
              'Usually a strict NAT or a firewall blocking UDP. Still retrying.',
        ttl: 8000,
      });
    }
    scheduleRecall(pid);
  }

  function scheduleRecall(pid, baseDelay) {
    const h = health(pid);
    if (h.retryTimer) return;
    const backoff = baseDelay != null ? baseDelay
      : Math.min(20000, 800 * Math.pow(2, Math.max(0, h.failures - 1)));
    const delay = backoff + Math.random() * 400;
    h.retryTimer = setTimeout(() => {
      h.retryTimer = null;
      if (!voiceOn || !voicePeers.has(pid)) return;
      const vp = voicePeers.get(pid);
      if (vp.room !== voiceRoom || vp.channel !== voiceChannel) return;
      if (voiceConns.has(pid)) return;
      callPeer(pid);
    }, delay);
  }

  // ═══════════════════════════════════════════════════════════════
  //  DEVICE PICKER UI
  // ═══════════════════════════════════════════════════════════════
  export function toggleDevicePicker() {
    const el = $('#call-devices');
    if (!el) return;
    const opening = el.classList.contains('hidden');
    el.classList.toggle('hidden', !opening);
    const btn = $('#btn-call-devices');
    if (btn) btn.classList.toggle('act', opening);
    if (opening) devices.list(true).then(renderDevicePicker);
  }

  export function renderDevicePicker() {
    const host = $('#call-devices');
    if (!host || host.classList.contains('hidden')) return;
    const { inputs, outputs } = devices.cached();
    const curIn  = state.state.audioInputId;
    const curOut = state.state.audioOutputId;
    const actual = devices.actualInputOf(localStream);

    const opt = (d, cur, kind) =>
      '<button class="dev-row' + ((d.id === cur) ? ' act' : '') + '"' +
      ' data-dev-kind="' + kind + '" data-dev-id="' + esc(d.id) + '">' +
      '<span class="dev-tick">' + ((d.id === cur) ? '●' : '○') + '</span>' +
      '<span class="dev-name">' + esc(d.label) + '</span></button>';

    const sysIn = '<button class="dev-row' + (!curIn ? ' act' : '') +
      '" data-dev-kind="in" data-dev-id=""><span class="dev-tick">' +
      (!curIn ? '●' : '○') + '</span><span class="dev-name">System default</span></button>';
    const sysOut = '<button class="dev-row' + (!curOut ? ' act' : '') +
      '" data-dev-kind="out" data-dev-id=""><span class="dev-tick">' +
      (!curOut ? '●' : '○') + '</span><span class="dev-name">System default</span></button>';

    host.innerHTML =
      '<div class="dev-col">' +
        '<div class="dev-hd">INPUT &middot; MICROPHONE</div>' +
        sysIn + inputs.map(d => opt(d, curIn, 'in')).join('') +
        (actual ? '<div class="dev-note">Live: ' + esc(actual.label) + '</div>' : '') +
        '<div class="dev-note dim">If you hear your own desktop audio, you are on a ' +
        '&ldquo;Stereo Mix&rdquo; or loopback device &mdash; pick a real microphone above.</div>' +
      '</div>' +
      '<div class="dev-col">' +
        '<div class="dev-hd">OUTPUT &middot; SPEAKERS</div>' +
        (devices.canSelectOutput()
          ? sysOut + outputs.map(d => opt(d, curOut, 'out')).join('')
          : '<div class="dev-note dim">Output switching is not available in this build. ' +
            'Change it in your OS sound settings.</div>') +
      '</div>';
  }

  async function onDevicePick(kind, id) {
    if (kind === 'in') {
      const r = await switchInputDevice(id);
      if (!r.ok) {
        toasts.showToast({ type: 'warn', title: 'MIC SWITCH FAILED',
          body: esc(r.error || 'Could not open that device.') + ' Still using the previous one.',
          ttl: 6000 });
      }
    } else {
      const r = await switchOutputDevice(id);
      if (!r.ok && r.failed) {
        toasts.showToast({ type: 'warn', title: 'OUTPUT SWITCH FAILED',
          body: 'That device could not be used for playback.', ttl: 5000 });
      }
    }
    renderDevicePicker();
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIVE DEVICE SWITCHING
  // ═══════════════════════════════════════════════════════════════
  /**
   * Swap the microphone mid-call without renegotiating.
   *
   * replaceTrack() on the sender changes the source behind an already
   * negotiated track, so no offer/answer round trip and no audio gap.
   * The denoiser chain and the mesh encoder both hold the old track, so
   * both are rebuilt against the new one.
   *
   * If anything fails we put the previous stream back rather than
   * leaving the call muted.
   */
  export async function switchInputDevice(deviceId) {
    const prevStream = localStream;
    const prevRaw    = rawMicStream;
    const prevId     = state.state.audioInputId;
    state.state.audioInputId = deviceId || '';

    if (!voiceOn) {
      // Not in a call — just remember it for next join.
      try { window.sirr.updateConfig({ audioInputId: state.state.audioInputId }); } catch (e) {}
      return { ok: true, applied: false };
    }

    let newRaw = null;
    try {
      newRaw = await navigator.mediaDevices.getUserMedia(audio.micConstraints());

      // denoise.attach() tears down the current chain first, so from here
      // on a failure must rebuild the chain on the previous device.
      const dn = await denoise.attach(newRaw);
      const newStream = dn.stream;
      audio.hintMicTrack(newStream);

      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) throw new Error('device produced no audio track');
      newTrack.enabled = !muted;

      localStream  = newStream;
      rawMicStream = newRaw;
      const wasNoMic = noMic;
      noMic = false;

      for (const [, c] of voiceConns) {
        const sender = c.audioSender || c.pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) {
          c.audioSender = sender;
          applyWebrtcAudioSender(c);
        } else {
          // Was listen-only on this link: attach to the existing audio
          // transceiver (or add one) and let PN renegotiate.
          const tr = c.pc.getTransceivers().find(t => t.receiver.track?.kind === 'audio' && !t.stopped);
          try {
            if (tr) {
              await tr.sender.replaceTrack(c.meshTx ? null : newTrack);
              tr.sender.setStreams?.(localStream);
              if (tr.direction === 'recvonly') tr.direction = 'sendrecv';
              else if (tr.direction === 'inactive') tr.direction = 'sendonly';
              c.audioSender = tr.sender;
            } else {
              c.audioSender = c.pc.addTrack(newTrack, localStream);
            }
          } catch (e) { vwarn('attach mic to link failed', e?.message); }
        }
      }

      if (prevStream && prevStream !== newStream) prevStream.getTracks().forEach(t => t.stop());
      if (prevRaw && prevRaw !== prevStream && prevRaw !== newRaw) prevRaw.getTracks().forEach(t => t.stop());

      setupLocalVA();

      // Mesh reads the mic through a track processor, which can't be
      // retargeted — swap its input. Peers and channels stay up.
      if (mesh.isEnabled()) {
        try { await mesh.setInput(localStream); } catch (e) { vwarn('mesh input swap', e); }
      }

      const actual = devices.actualInputOf(localStream);
      try { window.sirr.updateConfig({ audioInputId: state.state.audioInputId }); } catch (e) {}
      vlog('input switched →', actual?.label, wasNoMic ? '(was listen-only)' : '');
      notify(); updateVoiceUI(); renderVU();
      return { ok: true, applied: true, label: actual?.label };
    } catch (e) {
      vwarn('switchInputDevice failed —', e?.message);
      state.state.audioInputId = prevId;
      if (newRaw) { try { newRaw.getTracks().forEach(t => t.stop()); } catch (_) {} }
      // Put the previous chain back. With denoise off, prevStream is the
      // raw device and was never touched.
      if (prevRaw && localStream === prevStream && prevStream !== prevRaw) {
        try {
          const dn = await denoise.attach(prevRaw);
          localStream = dn.stream;
          localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
          for (const [, c] of voiceConns) applyWebrtcAudioSender(c);
          try { prevStream.getTracks().forEach(t => t.stop()); } catch (_) {}
          setupLocalVA();
          if (mesh.isEnabled()) mesh.setInput(localStream).catch(() => {});
        } catch (_) {}
      }
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /** Move all playback to a different output device, live. */
  export async function switchOutputDevice(deviceId) {
    state.state.audioOutputId = deviceId || '';
    try { window.sirr.updateConfig({ audioOutputId: state.state.audioOutputId }); } catch (e) {}
    let moved = 0, failed = 0;
    const pool = $('#voice-audio-pool');
    if (pool) {
      for (const el of pool.querySelectorAll('audio')) {
        (await devices.applySinkTo(el)) ? moved++ : failed++;
      }
    }
    // Mesh playback goes through an AudioContext, not an element.
    try { await mesh.setOutputDevice(); } catch (e) {}
    vlog('output switched —', moved, 'moved,', failed, 'failed');
    return { ok: failed === 0, moved, failed };
  }

  // ═══════════════════════════════════════════════════════════════
  //  MESH ↔ WEBRTC HANDOVER  (evidence-driven, per direction)
  // ═══════════════════════════════════════════════════════════════
  // Muting BOTH WebRTC directions as soon as the two sides swap a
  // HELLO — before a single mesh packet had been heard. If either encoder
  // wasn't actually running (unsupported config, a stereo mic in Studio
  // mode, a listen-only peer) the call went silent. That was the "mesh
  // makes VC unusable" report.
  //
  // Now each direction switches only on proof:
  //   RX: their WebRTC element is muted only while mesh audio is actually
  //       being DECODED from them. If it stops for 300 ms, it unmutes.
  //   TX: our WebRTC sender is idled only after THEY report (RXOK) that
  //       they are decoding our mesh audio. If the reports stop, the
  //       microphone goes straight back on the WebRTC sender.
  // No state exists in which mesh can make a peer inaudible.
  function installMeshHooks() {
    mesh.setHooks({
      onRxChange: (p, active) => {
        const c = voiceConns.get(p);
        if (c) {
          c.meshRx = !!active;
          if (c.audioEl) { try { c.audioEl.muted = deafened || c.meshRx; } catch (e) {} }
        }
        vlog('mesh rx', active ? 'engaged' : 'released', 'for', p, '(' + (mesh.rxLinkFor(p) || '-') + ')');
        renderVU(); renderCallGrid(); peers.updatePeers();
      },
      onTxChange: (p, active) => {
        const c = voiceConns.get(p);
        if (c) { c.meshTx = !!active; applyWebrtcAudioSender(c); }
        vlog('mesh tx', active ? 'engaged' : 'released', 'for', p, '(' + (mesh.linkFor(p) || '-') + ')');
        renderVU(); peers.updatePeers();
      },
      // Swarm carries audio only when WebRTC isn't doing the job.
      allowSwarm: (p) => {
        if (routeIsSwarm()) return true;
        const c = voiceConns.get(p);
        return !(c && c.pc.connectionState === 'connected');
      },
      sendSwarm: (p, bytes) => {
        if (!voiceOn || !voiceRoom || !window.sirr.sendVoiceMedia) return false;
        try { window.sirr.sendVoiceMedia(p, bytes, voiceRoom); return true; } catch (e) { return false; }
      },
    });
  }

  function routeIsSwarm() { return state.state.voiceRoute === 'swarm'; }

  // ═══════════════════════════════════════════════════════════════
  //  HYPERSWARM VOICE LINK
  // ═══════════════════════════════════════════════════════════════
  // The chat connection to every peer is already a holepunched,
  // Noise-encrypted Hyperswarm stream — the very stream our voice
  // signaling arrives on. So whenever ICE can't get through (symmetric
  // NAT, UDP blocked, STUN server down), voice rides that stream
  // instead. No STUN, no TURN, no third party, and it works for anyone
  // you can text. The far side switches on automatically when our
  // swarm HELLO arrives.
  const swarmAnnounced = new Set();
  function enableSwarm(pid, why) {
    if (!voiceOn || !mesh.isSupported() || !window.sirr.sendVoiceMedia) return false;
    const vp = voicePeers.get(pid);
    if (!vp || vp.room !== voiceRoom || vp.channel !== voiceChannel) return false;
    if (mesh.hasSwarm(pid)) return true;
    mesh.attachSwarm(pid);
    ensureMeshEncoder();
    vlog('swarm link enabled for', pid, why ? '— ' + why : '');
    if (!routeIsSwarm() && !swarmAnnounced.has(pid)) {
      swarmAnnounced.add(pid);
    }
    renderVU(); renderCallGrid();
    return true;
  }

  let meshStarting = null;
  function ensureMeshEncoder() {
    if (!voiceOn || !localStream || noMic || !mesh.isSupported()) return;
    if (mesh.isRunning() || meshStarting) return;
    meshStarting = mesh.start(localStream).then(ok => {
      if (!ok && mesh.getError()) vwarn('mesh encoder unavailable:', mesh.getError());
      return ok;
    }).finally(() => { meshStarting = null; });
  }

  /** Inbound mesh bytes that arrived over the Hyperswarm connection. */
  export function handleVoiceMedia(i) {
    if (!voiceOn || !i || !i.peerId) return;
    const bytes = i.data instanceof Uint8Array ? i.data
                : i.data && i.data.buffer ? new Uint8Array(i.data.buffer, i.data.byteOffset || 0, i.data.byteLength)
                : null;
    if (!bytes || !bytes.length) return;
    if (mesh.onSwarmBytes(i.peerId, bytes)) return;
    // Not linked yet: a HELLO from someone in our channel switches us on.
    if (bytes[0] === mesh.HELLO_BYTE && enableSwarm(i.peerId, 'peer greeted over swarm')) {
      mesh.onSwarmBytes(i.peerId, bytes);
    }
  }

  // Chromium quirk: after an implicit rollback
  // (polite side losing a glare during renegotiation, e.g. both people
  // turning cameras on at once) a sender can stay attached to a new SSRC
  // that never receives media — the other side hears you go silent.
  // Detaching and re-attaching the same track re-binds the source.
  async function rebindSenders(rec) {
    for (const s of rec.pc.getSenders()) {
      const t = s.track;
      if (!t) continue;
      try { await s.replaceTrack(null); await s.replaceTrack(t); } catch (e) { vwarn('rebind sender', e?.message); }
    }
    vlog('senders re-bound after rollback');
  }

  /** Put the right track on the WebRTC audio sender for this peer. */
  function applyWebrtcAudioSender(c) {
    const sender = c.audioSender || c.pc.getSenders().find(s => s.track?.kind === 'audio');
    if (!sender) return;
    const want = c.meshTx ? null : currentMicTrack();
    if (sender.track === want) return;
    sender.replaceTrack(want).catch(e => vwarn('replaceTrack', e?.message));
  }

  function attachRemoteAudio(pid, stream) {
    const pool = $('#voice-audio-pool');
    if (!pool) return;
    const prev = pool.querySelector(`[data-pid="${CSS.escape(String(pid))}"]`);
    if (prev) { try { prev.pause(); } catch (e) {} prev.srcObject = null; prev.remove(); }
    const el = document.createElement('audio');
    el.dataset.pid = pid;
    el.autoplay = true;
    el.playsInline = true;
    el.srcObject = stream;
    const c = voiceConns.get(pid);
    el.muted = deafened || !!(c && c.meshRx);
    pool.appendChild(el);
    // Route to the chosen speakers before playing, so a new peer joining
    // mid-call doesn't come out of the wrong device.
    devices.applySinkTo(el).finally(() => {
      el.play().catch(err => vwarn('audio.play() rejected for', pid, err?.message));
    });
    if (c) c.audioEl = el;
    applyPeerAudio(pid, el);
  }

  function detachRemoteAudio(pid) {
    const pool = $('#voice-audio-pool');
    if (!pool) return;
    const prev = pool.querySelector(`[data-pid="${CSS.escape(String(pid))}"]`);
    if (prev) { try { prev.pause(); } catch (e) {} prev.srcObject = null; prev.remove(); }
  }

  // Under PN, "calling" is creating the PC + adding tracks;
  // onnegotiationneeded produces the offer.
  export async function callPeer(pid) {
    if (!voiceOn || !voiceRoom) return;
    if (pid === state.state.myPeerId) return;
    clearRetry(pid);
    if (routeIsSwarm() || voicePeers.get(pid)?.route === 'swarm') { enableSwarm(pid, 'swarm route'); return; }
    const existing = voiceConns.get(pid);
    if (existing) {
      const st = existing.pc.connectionState;
      if (st === 'connected' || st === 'connecting' || st === 'new') {
        vlog('callPeer: already have PC to', pid, '(', st, ') — skipping');
        return;
      }
      closeVC(pid);
    }
    mkPC(pid, { asCaller: true });
  }

  function onOffer(pid, d, room) {
    if (!voiceOn) { vwarn('got OFFER from', pid, 'but voice is off; ignoring'); return; }
    if (routeIsSwarm()) { enableSwarm(pid, 'swarm route'); return; }   // never open WebRTC
    if (voiceRoom !== room) { vwarn('got OFFER from', pid, 'for room', room, 'but we are in', voiceRoom); return; }
    if (!voicePeers.has(pid)) voicePeers.set(pid, { room, channel: voiceChannel || 'default', seenAt: Date.now() });

    let rec = voiceConns.get(pid);
    // Their PC was rebuilt: ours is talking to a ghost. Start clean.
    if (rec && d.sid && rec.remoteSid && d.sid !== rec.remoteSid) {
      vlog('OFFER from', pid, 'carries new sid', d.sid, '(was', rec.remoteSid, ') — rebuilding');
      closeVC(pid);
      rec = null;
    }
    if (!rec) rec = mkPC(pid);
    clearRetry(pid);
    const pc = rec.pc;

    return enqueue(pid, async () => {
      if (voiceConns.get(pid) !== rec) return;
      const readyForOffer = !rec.makingOffer &&
        (pc.signalingState === 'stable' || rec.settingRemoteAnswer);
      const offerCollision = !readyForOffer;
      rec.ignoreOffer = !rec.polite && offerCollision;
      if (rec.ignoreOffer) {
        vlog('impolite: ignoring colliding OFFER from', pid, '(ss=', pc.signalingState, ')');
        return;
      }
      try {
        // Polite + collision: this SRD implicitly rolls back our offer.
        await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        if (d.sid) rec.remoteSid = d.sid;
        rec.lastProgress = Date.now();
        audio.preferRedundantAudio(pc);
        await pc.setLocalDescription();
        vlog('← OFFER from', pid, offerCollision ? '(glare, rolled back)' : '', ' → ANSWER');
        sendSig(pid, VM.ANSWER, audio.wireDescription(pc.localDescription, rec.sid));
        await drainPendingICE(pid);
        if (offerCollision) await rebindSenders(rec);
      } catch (e) {
        vwarn('onOffer failed for', pid, e?.message || e);
        onPcFailed(pid, rec);
      }
    });
  }

  function onAnswer(pid, d) {
    const rec = voiceConns.get(pid);
    if (!rec) { vwarn('got ANSWER from', pid, 'but no PC'); return; }
    return enqueue(pid, async () => {
      if (voiceConns.get(pid) !== rec) return;
      const pc = rec.pc;
      if (pc.signalingState !== 'have-local-offer') {
        vlog('ignoring ANSWER from', pid, '— ss=', pc.signalingState);
        return;
      }
      if (d.sid && rec.remoteSid && d.sid !== rec.remoteSid) {
        // The far end answered from a brand-new PC: our PC is the stale
        // one. Rebuild and offer again.
        vlog('ANSWER from', pid, 'from a new PC — rebuilding ours');
        closeVC(pid);
        scheduleRecall(pid, 0);
        return;
      }
      try {
        rec.settingRemoteAnswer = true;
        await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        if (d.sid) rec.remoteSid = d.sid;
        rec.lastProgress = Date.now();
        vlog('← ANSWER from', pid);
        await drainPendingICE(pid);
      } catch (e) {
        vwarn('setRemoteDescription(answer) failed for', pid, e?.message || e);
        onPcFailed(pid, rec);
      } finally {
        rec.settingRemoteAnswer = false;
      }
    });
  }

  async function drainPendingICE(pid) {
    const queue = pendingICE.get(pid);
    if (!queue || !queue.length) return;
    const rec = voiceConns.get(pid);
    if (!rec || !rec.pc.remoteDescription) return;
    pendingICE.delete(pid);
    let n = 0;
    for (const cand of queue) {
      if (cand.sid && rec.remoteSid && cand.sid !== rec.remoteSid) continue;  // from a dead PC
      try { await rec.pc.addIceCandidate(cand); n++; }
      catch (e) { if (!rec.ignoreOffer) vwarn('queued addIceCandidate failed for', pid, e?.message); }
    }
    if (n) vlog('drained', n, 'queued ICE for', pid);
  }

  function onICE(pid, cand) {
    const queue = () => {
      if (!pendingICE.has(pid)) pendingICE.set(pid, []);
      const q = pendingICE.get(pid);
      if (q.length < 64) q.push(cand);
    };
    const rec = voiceConns.get(pid);
    if (!rec) { queue(); return; }
    return enqueue(pid, async () => {
      if (voiceConns.get(pid) !== rec) { queue(); return; }
      if (cand.sid && rec.remoteSid && cand.sid !== rec.remoteSid) return;  // stale
      if (!rec.pc.remoteDescription) { queue(); return; }
      try { await rec.pc.addIceCandidate(cand); }
      catch (e) { if (!rec.ignoreOffer) vwarn('addIceCandidate failed for', pid, e?.message); }
    });
  }

  export function closeVC(pid) {
    const c = voiceConns.get(pid);
    if (!c) return;
    vlog('closeVC', pid);
    if (c.discTimer) { clearTimeout(c.discTimer); c.discTimer = null; }
    if (c.fallbackTimer) { clearTimeout(c.fallbackTimer); c.fallbackTimer = null; }
    voiceConns.delete(pid);
    try { c.pc.close(); } catch (e) {}
    mesh.detachDc(pid);
    detachRemoteAudio(pid);
    closePopupsForPeer(pid);
    voiceActivity.delete(pid);
    pendingICE.delete(pid);
    peerVideos.delete(pid);
    renderCallGrid();
  }

  export function closePopupsForPeer(pid) {
    const prefix = String(pid) + '|';
    for (const key of [...screenPopups.keys()]) {
      if (key.startsWith(prefix)) closeScreenPopup(key);
    }
  }

  // ─── Heartbeat — presence, late joiners, stuck-PC recovery ───────
  const VOICE_PEER_TTL_MS = 20000;   // 4 missed heartbeats
  export function startHeartbeat() {
    stopHeartbeat();
    vcHeartbeat = setInterval(() => {
      if (!voiceOn || !voiceRoom) return;
      sendSig(null, VM.JOIN, { room: voiceRoom, channel: voiceChannel, route: state.state.voiceRoute });

      const now = Date.now();
      // Forget voice presence that stopped heart-beating (crash, sleep,
      // killed process — anything that never sent LEAVE).
      for (const [pid, vp] of [...voicePeers]) {
        if (vp.seenAt && now - vp.seenAt > VOICE_PEER_TTL_MS && !voiceConns.get(pid)?.everConnected) {
          voicePeers.delete(pid);
          closeVC(pid);
          mesh.detachPeer(pid);
          peers.updatePeers(); rooms.renderChannels(); renderCallGrid();
        }
      }

      for (const [pid, c] of [...voiceConns]) {
        const cs = c.pc.connectionState;
        const ss = c.pc.signalingState;
        const idle = now - (c.lastProgress || c.createdAt || now);
        if (cs === 'connected' || cs === 'disconnected') {
          // A live call with a renegotiation that never got an answer:
          // roll it back and let negotiationneeded try again. Tearing
          // down a working call for this is worse.
          if (ss === 'have-local-offer' && idle > PC_STUCK_MS) {
            vwarn('renegotiation to', pid, 'stuck — rolling back');
            c.lastProgress = now;
            enqueue(pid, async () => { await c.pc.setLocalDescription({ type: 'rollback' }); await rebindSenders(c); });
          }
          continue;
        }
        if (idle > PC_STUCK_MS) {
          vwarn('stuck PC to', pid, `(cs=${cs} ss=${ss} idle=${idle}ms) — rebuilding`);
          onPcFailed(pid, c);
        }
      }
    }, 5000);
  }
  function stopHeartbeat() {
    if (vcHeartbeat) { clearInterval(vcHeartbeat); vcHeartbeat = null; }
  }

  // ─── Voice-activity meters ────────────────────────────────────────
  function setupVA(pid, stream) {
    try {
      const prev = voiceActivity.get(pid);
      if (prev && prev.src) { try { prev.src.disconnect(); } catch (e) {} }
      const c = getCtx();
      const src = c.createMediaStreamSource(stream);
      const an = c.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.5;
      src.connect(an);
      voiceActivity.set(pid, { analyser: an, src, level: 0 });
    } catch (e) { vwarn('setupVA failed for', pid, e); }
  }

  // The meter and the noise gate listen to a CLONE of the outgoing track.
  // Listening to the outgoing track itself fails — the gate works by
  // disabling that track. A disabled track reads as silence, so the
  // first time the gate closed it could never hear you again and stayed
  // shut for the rest of the call. The clone has its own `enabled` flag.
  let analysisTrack = null, analysisSrc = null;
  let gateOpen = true, gateHoldUntil = 0, gateLevel = 0;
  const GATE_HOLD_MS = 350;      // keep open briefly after speech so word tails survive
  function teardownLocalVA() {
    try { analysisSrc?.disconnect(); } catch (e) {}
    try { analysisTrack?.stop(); } catch (e) {}
    analysisSrc = null; analysisTrack = null; localAnalyser = null;
  }
  function setupLocalVA() {
    teardownLocalVA();
    const t = currentMicTrack();
    if (!t) return;
    try {
      analysisTrack = t.clone();
      analysisTrack.enabled = true;
      const c = getCtx();
      analysisSrc = c.createMediaStreamSource(new MediaStream([analysisTrack]));
      localAnalyser = c.createAnalyser();
      localAnalyser.fftSize = 512; localAnalyser.smoothingTimeConstant = 0.5;
      analysisSrc.connect(localAnalyser);
      // A context created before any user gesture (a notification beep,
      // say) can sit suspended; a suspended context feeds the analyser
      // silence and the meter never moves. Joining is a gesture: resume.
      if (c.state === 'suspended') c.resume().catch(() => {});
      gateOpen = true; gateHoldUntil = 0;
    } catch (e) { vwarn('setupLocalVA failed', e); }
  }

  function setOutgoingEnabled(on) {
    if (!localStream) return;
    for (const t of localStream.getAudioTracks()) if (t.enabled !== on) t.enabled = on;
  }

  function pollVA() {
    if (!voiceOn) return;
    if (localAnalyser) {
      // The average of a byte FFT across every bin up to 24 kHz barely
      // moves for speech, whose energy sits under 4 kHz: the meter looked
      // dead. RMS in dBFS reads like a mixing-desk meter instead.
      // Instant attack, ~300 ms fall: syllables read on the meter, and the
      // gate doesn't chatter between them.
      gateLevel = Math.max(levelOf(localAnalyser), gateLevel * 0.82);
      const avg = gateLevel;
      localLevel = muted ? 0 : avg;
      localSpeaking = !muted && avg > SPEAKING;
      if (!muted) {
        const thr = NOISE_GATE[state.state.noiseGate] || 0;
        if (thr > 0) {
          const now = performance.now();
          // Hysteresis: open at thr, close only below thr*0.7 and after the hold.
          if (avg >= thr) { gateOpen = true; gateHoldUntil = now + GATE_HOLD_MS; }
          else if (avg < thr * 0.7 && now > gateHoldUntil) gateOpen = false;
          setOutgoingEnabled(gateOpen);
        } else if (!gateOpen) {
          gateOpen = true; setOutgoingEnabled(true);
        }
      }
    } else {
      localLevel = 0;
      localSpeaking = false;
    }
    for (const [, va] of voiceActivity) va.level = Math.max(levelOf(va.analyser), (va.level || 0) * 0.82);
    renderVU();
    updateCallTilesVU();
  }
  // 50 ms instead of 100: the gate opening late clips the first syllable.
  function startVAPoller() { stopVAPoller(); vaPoller = setInterval(pollVA, 50); }
  function stopVAPoller()  { if (vaPoller) { clearInterval(vaPoller); vaPoller = null; } }

  // ═══════════════════════════════════════════════════════════════════
  //  PUBLIC: join / leave voice channel
  // ═══════════════════════════════════════════════════════════════════
  export async function joinVoiceChannel(chId) {
    const activeRoom = state.state.activeRoom;
    if (!activeRoom) return;
    const ch = rooms.getChannelRec(activeRoom, chId);
    if (!ch || ch.kind !== 'voice') return;
    // Click on the channel we're already in → open the call screen instead.
    if (voiceOn && voiceRoom === activeRoom && voiceChannel === chId) {
      toggleCallScreen();
      return;
    }
    if (voiceOn) {
      leaveVoice();
      await new Promise(r => setTimeout(r, 300));
    }
    noMic = false;
    try {
      if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
      if (rawMicStream) { rawMicStream.getTracks().forEach(t => t.stop()); rawMicStream = null; }
      denoise.teardown();
      // Profile-driven constraints instead of a bare `{audio:true}` —
      // this is where Studio mode turns off the browser's DSP.
      rawMicStream = await navigator.mediaDevices.getUserMedia(audio.micConstraints());
      // Optional RNNoise pass. ALWAYS returns a usable stream; on any
      // failure it hands back the raw one untouched.
      const dn = await denoise.attach(rawMicStream);
      localStream = dn.stream;
      if (dn.denoised) vlog('RNNoise chain active');
      audio.hintMicTrack(localStream);
      setupLocalVA();
    } catch (e) {
      localStream = null; rawMicStream = null; noMic = true;
      // Surface the specific failure reason so the user knows what to fix.
      const name = e && e.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        toasts.showToast({
          type: 'warn',
          title: 'MIC PERMISSION DENIED',
          body: 'Sirr cannot access your microphone. Check OS/app permissions, then rejoin the channel.',
          ttl: 8000,
        });
        chat.sysMsg('⚠ Mic permission denied — joining in listen-only mode');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        toasts.showToast({
          type: 'warn',
          title: 'NO MICROPHONE FOUND',
          body: 'No audio input device detected. Joining in listen-only mode.',
          ttl: 5000,
        });
        chat.sysMsg('⚠ No microphone found — listener mode');
      } else {
        toasts.showToast({
          type: 'warn',
          title: 'MIC ERROR',
          body: (e && e.message) ? String(e.message).slice(0, 120) : 'Could not open microphone — joining in listen-only mode.',
          ttl: 6000,
        });
        chat.sysMsg('⚠ Mic error (' + (name || 'unknown') + ') — listener mode');
      }
    }
    voiceOn = true;
    voiceRoom = activeRoom;
    voiceChannel = chId;
    if (state.state.vcAutoMute === 'on' && localStream && !noMic) {
      muted = true;
      localStream.getAudioTracks().forEach(t => { t.enabled = false; });
      const m = $('#btn-mute');
      if (m) {
        m.textContent = 'MUTED';
        m.classList.remove('act');
        m.classList.add('muted');
      }
    }
    notify();
    updateVoiceUI(); rooms.renderRail(); peers.updatePeers(); rooms.renderChannels();
    vlog('joined voice in', voiceRoom, '#', voiceChannel);
    installMeshHooks();
    mesh.setListenOnly(noMic);
    // Start the mesh encoder up front when this call may use it (mesh on,
    // or swarm route). In Auto it also starts lazily the moment any peer
    // needs the swarm fallback.
    if (mesh.isSupported() && localStream && (mesh.isEnabled() || routeIsSwarm())) ensureMeshEncoder();
    const announce = () => sendSig(null, VM.JOIN, { room: voiceRoom, channel: voiceChannel, route: state.state.voiceRoute });
    announce();
    setTimeout(announce, 400);
    startHeartbeat();
    startVAPoller();
    audio.setConnsGetter(() => voiceConns);
    audio.startStats();
    // Refresh the picker when a headset is plugged or pulled, and warn
    // if the device we are actually using just disappeared.
    devices.watch(() => {
      renderDevicePicker();
      const cur = state.state.audioInputId;
      if (cur && !devices.inputAvailable(cur)) {
        toasts.showToast({
          type: 'warn', title: 'INPUT DEVICE GONE',
          body: 'Your selected microphone was disconnected. Pick another in the call bar.',
          ttl: 7000,
        });
      }
    });
    devices.list(true).then(renderDevicePicker);
  }

  export function leaveVoice() {
    vlog('leaveVoice');
    const wasRoom = voiceRoom, wasChannel = voiceChannel;
    if (wasRoom) {
      try { window.sirr.sendVoiceSignal(null, VM.LEAVE, '{}', wasRoom, wasChannel); } catch (e) {}
    }
    for (const pid of [...voiceConns.keys()]) closeVC(pid);
    pendingICE.clear();
    for (const [, h] of peerHealth) if (h.retryTimer) clearTimeout(h.retryTimer);
    peerHealth.clear();
    swarmAnnounced.clear();
    teardownLocalVA();
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
    }
    // The processed stream and the device stream are different objects
    // when denoise is on — stopping only one leaves the mic hot.
    if (rawMicStream) {
      for (const t of rawMicStream.getTracks()) t.stop();
      rawMicStream = null;
    }
    denoise.dispose();
    mesh.dispose();
    audio.stopStats();
    stopScreenShare();
    stopCamShare();
    stopHeartbeat();
    stopVAPoller();
    localAnalyser = null;
    localLevel = 0; localSpeaking = false;
    voiceActivity.clear();
    voiceOn = false; voiceRoom = null; voiceChannel = null;
    muted = false; deafened = false; noMic = false;
    const bm = $('#btn-mute'); if (bm) { bm.textContent = 'MIC'; bm.classList.add('act'); bm.classList.remove('muted'); }
    const bd = $('#btn-deaf'); if (bd) { bd.textContent = 'OUT'; bd.classList.add('act'); bd.classList.remove('muted'); }
    focusedTileKey = null;
    renderCallGrid();
    if (callScreenOpen) closeCallScreen();
    notify();
    updateVoiceUI(); rooms.renderRail(); peers.updatePeers(); rooms.renderChannels();
  }

  export function toggleMute() {
    if (noMic) return;
    muted = !muted;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    const m = $('#btn-mute');
    if (m) {
      m.textContent = muted ? 'MUTED' : 'MIC';
      m.classList.toggle('act', !muted);
      m.classList.toggle('muted', muted);
    }
    syncCallControls();
    renderVU();
    notify();
  }
  export function toggleDeafen() {
    deafened = !deafened;
    const d = $('#btn-deaf');
    if (d) {
      d.textContent = deafened ? 'DEAF' : 'OUT';
      d.classList.toggle('act', !deafened);
      d.classList.toggle('muted', deafened);
    }
    for (const [, c] of voiceConns) {
      if (c.audioEl) c.audioEl.muted = deafened || !!c.meshRx;
    }
    mesh.setDeafened(deafened);
    syncCallControls();
    notify();
  }

  /** Everyone we have a voice link to — WebRTC, mesh, or swarm. */
  function callPeerIds() {
    const ids = new Set(voiceConns.keys());
    for (const pid of mesh.swarmPeers()) {
      const vp = voicePeers.get(pid);
      if (vp && vp.room === voiceRoom && vp.channel === voiceChannel) ids.add(pid);
    }
    return ids;
  }

  // ─── Mic check (settings) ─────────────────────────────────────────
  // Opens the selected input on its own — no call, no peers — and draws
  // it on a 24-segment meter with a dBFS readout.
  let micTest = null;
  export async function startMicTest(meterEl, dbEl) {
    stopMicTest();
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audio.micConstraints());
      const c = getCtx();
      if (c.state === 'suspended') await c.resume().catch(() => {});
      const src = c.createMediaStreamSource(stream);
      const an = c.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.5;
      src.connect(an);
      if (meterEl && !meterEl.children.length) meterEl.innerHTML = '<i></i>'.repeat(24);
      const segs = meterEl ? [...meterEl.children] : [];
      let lvl = 0, peak = 0, peakAt = 0;
      const tick = () => {
        if (!micTest) return;
        lvl = Math.max(levelOf(an), lvl * 0.82);
        const n = Math.round(lvl / 128 * segs.length), now = performance.now();
        if (n >= peak || now - peakAt > 900) { peak = n; peakAt = now; }
        segs.forEach((el, i) => { el.className = i < n ? (i >= 19 ? 'hi' : 'on') : (i === peak - 1 ? 'pk' : ''); });
        if (dbEl) dbEl.textContent = lvl > 0 ? Math.round(lvl / 128 * 50 - 60) + ' dB' : '−∞ dB';
        micTest.raf = requestAnimationFrame(tick);
      };
      micTest = { stream, src, raf: 0 };
      tick();
      return { ok: true };
    } catch (e) {
      if (dbEl) dbEl.textContent = (e && e.name === 'NotAllowedError') ? 'no permission' : 'no mic';
      return { ok: false, error: e && e.name };
    }
  }
  export function stopMicTest(meterEl, dbEl) {
    if (!micTest) return;
    cancelAnimationFrame(micTest.raf);
    try { micTest.src.disconnect(); } catch (e) {}
    micTest.stream.getTracks().forEach(t => t.stop());
    micTest = null;
    if (meterEl) [...meterEl.children].forEach(el => { el.className = ''; });
    if (dbEl) dbEl.textContent = '—';
  }
  export function micTestRunning() { return !!micTest; }

  // ─── VU rendering (compact toolbar) ──────────────────────────────
  export function renderVU() {
    if (!voiceOn) { const vu = $('#voice-users'); if (vu) vu.innerHTML = ''; return; }

    function meterHtml(level) {
      const clamped = Math.min(128, Math.max(0, level || 0));
      const segs = Math.round((clamped / 128) * 16);
      let out = '<div class="vu-meter">';
      for (let i = 0; i < 16; i++) {
        out += '<i class="' + (i < segs ? (i >= 12 ? 'hi' : 'on') : '') + '"></i>';
      }
      return out + '</div>';
    }

    const myLevel = muted ? 0 : localLevel;
    const myNickname = state.state.myNickname;
    let lab = 'ME';
    let nm  = myNickname + (muted ? ' · muted' : '') + (noMic ? ' · no mic' : '') + (screenSharing ? ' · 🖥' : '') + (camSharing ? ' · 📷' : '');
    let h = '<div class="vu-row me vu-click" data-fp="' + esc(state.state.myFingerprint || '') + '" title="Your profile">'
          + '<span class="lab">' + lab + '</span>'
          + '<span class="nm">' + esc(nm) + '</span>'
          + '<span class="lab">' + (muted ? '—' : 'live') + '</span>'
          + '</div>'
          + meterHtml(myLevel);

    let i = 2;
    for (const pid of callPeerIds()) {
      const c = voiceConns.get(pid);
      const p = state.peers.get(pid);
      const rtcOk = !!c && c.pc.connectionState === 'connected';
      const rxLink = mesh.rxLinkFor(pid);
      const ok = rtcOk || !!rxLink;
      const va = voiceActivity.get(pid);
      const level = Math.max(va && !(c && c.meshRx) ? va.level : 0, mesh.levelFor(pid));
      const tag = rxLink === 'swarm' ? 'swarm' : rxLink === 'dc' ? 'mesh' : (ok ? 'live' : '…');
      const label = String(i).padStart(2, '0');
      h += '<div class="vu-row vu-click' + (peerMuted.has(pid) ? ' lmuted' : '') + '" data-pid="' + esc(pid) + '" data-fp="' + esc(p ? p.fingerprint : '') + '" title="Click: profile · Right-click: volume, mute, DM">'
         + '<span class="lab">' + label + '</span>'
         + '<span class="nm">' + esc(p ? p.nickname : pid) + (peerMuted.has(pid) ? ' · muted for you' : '') + '</span>'
         + '<span class="lab">' + tag + '</span>'
         + '</div>'
         + meterHtml(ok ? level : 0);
      i++;
    }
    const vu = $('#voice-users'); if (vu) vu.innerHTML = h;
  }

  // ─── Voice toolbar UI (called from external events too) ──────────
  export function updateVoiceUI() {
    const activeRoom = state.state.activeRoom;
    const btn = $('#btn-voice-join'), ctrls = $('#voice-ctrls');
    const btnLeaveLabel = $('#voice-state-leave');
    if (!btn || !ctrls) return;

    if (voiceOn && voiceRoom === activeRoom) {
      btn.classList.add('active');
      const t = $('#voice-title'); if (t) t.textContent = noMic ? 'LISTENING' : 'CONNECTED';
      if (btnLeaveLabel) btnLeaveLabel.classList.add('hidden');
      ctrls.classList.remove('hidden');
      renderVU();
    } else if (voiceOn) {
      btn.classList.remove('active');
      const t = $('#voice-title'); if (t) t.textContent = 'IN ' + (voiceRoom || '—');
      if (btnLeaveLabel) { btnLeaveLabel.classList.remove('hidden'); btnLeaveLabel.textContent = 'SWITCH'; }
      ctrls.classList.add('hidden');
      renderVoicePresence();
    } else {
      btn.classList.remove('active');
      const t = $('#voice-title'); if (t) t.textContent = 'OFFLINE';
      if (btnLeaveLabel) { btnLeaveLabel.classList.remove('hidden'); btnLeaveLabel.textContent = 'JOIN'; }
      ctrls.classList.add('hidden');
      renderVoicePresence();
    }
  }
  export function renderVoicePresence() {
    const el = $('#voice-users'); if (!el) return;
    if (voiceOn && voiceRoom === state.state.activeRoom) return;  // renderVU owns it
    el.innerHTML = '';
  }

  // ─── Call screen overlay ─────────────────────────────────────────
  export function openCallScreen() {
    if (!voiceOn) return;
    callScreenOpen = true; notify();
    const cs = $('#call-screen');
    if (!cs) return;
    cs.classList.remove('hidden');
    requestAnimationFrame(() => cs.classList.add('visible'));
    const rd = voiceRoom ? state.roomData.get(voiceRoom) : null;
    const ch = rd && rd.channels ? rd.channels.get(voiceChannel) : null;
    const rn = $('#call-room-name'); if (rn) rn.textContent = (rd && rd.name) || voiceRoom || '—';
    const cn = $('#call-channel-name'); if (cn) cn.textContent = (ch && ch.name) || voiceChannel || '—';
    syncCallControls();
    renderCallGrid();
  }
  export function closeCallScreen() {
    callScreenOpen = false; notify();
    const cs = $('#call-screen');
    if (!cs) return;
    cs.classList.remove('visible');
    setTimeout(() => { if (!callScreenOpen) cs.classList.add('hidden'); }, 300);
  }
  // ─── Per-user local volume / mute (right-click a participant) ──
  const peerVol = new Map();     // pid → 0..100
  const peerMuted = new Set();   // pid
  function applyPeerAudio(pid, el) {
    if (!el) { const pool = $('#voice-audio-pool'); el = pool && pool.querySelector(`[data-pid="${CSS.escape(String(pid))}"]`); }
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, (peerVol.has(pid) ? peerVol.get(pid) : 100) / 100));
    if (peerMuted.has(pid)) el.muted = true;
    else if (!deafened) { const c = voiceConns.get(pid); el.muted = !!(c && c.meshRx); }
  }
  export function getPeerVolume(pid) { return peerVol.has(pid) ? peerVol.get(pid) : 100; }
  export function setPeerVolume(pid, v) { peerVol.set(pid, v); applyPeerAudio(pid); }
  export function isPeerLocallyMuted(pid) { return peerMuted.has(pid); }
  export function togglePeerLocalMute(pid) { peerMuted.has(pid) ? peerMuted.delete(pid) : peerMuted.add(pid); applyPeerAudio(pid); renderVU(); }
  export function isVoiceOn() { return voiceOn; }

  export function toggleCallScreen() {
    if (callScreenOpen) closeCallScreen();
    else openCallScreen();
  }
  export function syncCallControls() {
    const m = $('#btn-call-mute');
    if (m) {
      m.textContent = muted ? 'MUTED' : 'MIC';
      m.classList.toggle('muted', muted);
      m.classList.toggle('act', !muted && !noMic);
    }
    const d = $('#btn-call-deaf');
    if (d) {
      d.textContent = deafened ? 'DEAF' : 'OUT';
      d.classList.toggle('muted', deafened);
      d.classList.toggle('act', !deafened);
    }
    const c = $('#btn-call-cam');
    if (c) c.classList.toggle('act', camSharing);
    const s = $('#btn-call-screen');
    if (s) s.classList.toggle('act', screenSharing);
  }

  export function renderCallGrid() {
    const grid = $('#call-grid');
    if (!grid) return;

    const tiles = [];
    if (screenStream) tiles.push({ key: 'self|screen', stream: screenStream, label: 'You', tag: 'SCREEN', self: true, kind: 'screen' });
    if (camStream)    tiles.push({ key: 'self|cam',    stream: camStream,    label: 'You', tag: 'CAMERA', self: true, kind: 'cam' });
    for (const [pid, vmap] of peerVideos) {
      const p = state.peers.get(pid);
      const nick = p?.nickname || pid;
      for (const [vkey, v] of vmap) {
        tiles.push({
          key: vkey, stream: v.stream, label: nick,
          tag: v.kind === 'screen' ? 'SCREEN' : 'CAMERA',
          peerId: pid, kind: v.kind,
        });
      }
    }
    const inMyChannel = (vp) => vp.room === voiceRoom && vp.channel === voiceChannel;
    for (const [pid, vp] of voicePeers) {
      if (!inMyChannel(vp)) continue;
      if (peerVideos.has(pid) && peerVideos.get(pid).size) continue;
      const p = state.peers.get(pid);
      if (!p) continue;
      tiles.push({
        key: 'audio|' + pid,
        audioOnly: true,
        peerId: pid,
        label: p.nickname || pid,
        avatarEmoji: p.avatarEmoji,
        avatarImage: '',
        seed: p.fingerprint || pid,
      });
    }
    if (voiceOn && !screenStream && !camStream) {
      tiles.push({
        key: 'audio|self',
        audioOnly: true,
        label: state.state.myNickname + ' (you)',
        avatarEmoji: state.state.avatarEmoji,
        avatarImage: state.state.avatarImage,
        seed: state.state.myFingerprint,
        self: true,
      });
    }

    if (!tiles.length) {
      grid.classList.add('empty');
      grid.classList.remove('focus-mode');
      if (!grid.querySelector('.call-empty .figure-host')) {
        if (callFigure) { callFigure.destroy(); callFigure = null; }
        grid.innerHTML = '<div class="call-empty"><div class="figure-host"></div><p>No camera or screen streams in this channel yet.</p></div>';
        callFigure = mountFigure(grid.querySelector('.figure-host'), 'faders');
      }
      return;
    }
    if (callFigure) { callFigure.destroy(); callFigure = null; grid.innerHTML = ''; }
    grid.classList.remove('empty');
    // Alone in the call: say so, with the console figure, above your tile.
    const alone = $('#call-alone');
    if (alone) {
      const solo = tiles.length === 1 && tiles[0].self && tiles[0].audioOnly;
      alone.classList.toggle('hidden', !solo);
      if (solo && !aloneFigure) aloneFigure = mountFigure(alone.querySelector('.figure-host'), 'faders');
      if (!solo && aloneFigure) { aloneFigure.destroy(); aloneFigure = null; }
    }
    if (focusedTileKey && !tiles.some(t => t.key === focusedTileKey)) focusedTileKey = null;
    grid.classList.toggle('focus-mode', !!focusedTileKey);

    const want = new Set(tiles.map(t => t.key));
    for (const node of [...grid.children]) {
      if (!node.dataset || !node.dataset.key) { node.remove(); continue; }
      if (!want.has(node.dataset.key)) node.remove();
    }
    if (focusedTileKey) {
      const fi = tiles.findIndex(t => t.key === focusedTileKey);
      if (fi > 0) { const [f] = tiles.splice(fi, 1); tiles.unshift(f); }
    }

    for (const t of tiles) {
      let node = grid.querySelector('[data-key="' + CSS.escape(t.key) + '"]');
      const isFocus = focusedTileKey === t.key;

      if (!node) {
        node = document.createElement('div');
        node.dataset.key = t.key;
        node.className = 'call-tile' + (t.audioOnly ? ' audio-only' : '') + (t.self ? ' self' : '') + (isFocus ? ' focus' : '');
        if (t.audioOnly) {
          const mono = avatarHtmlLocal(t.label, t.avatarEmoji, t.avatarImage, t.seed);
          node.innerHTML = '<div class="call-mono">' + mono + '</div>'
            + '<div class="call-label"><span class="tag">VOICE</span>' + esc(t.label) + '</div>';
        } else {
          const v = document.createElement('video');
          v.autoplay = true;
          v.playsInline = true;
          v.muted = !!t.self;
          v.srcObject = t.stream;
          v.className = 'call-video';
          v.addEventListener('loadedmetadata', () => { v.play().catch(() => {}); });
          node.appendChild(v);
          const lbl = document.createElement('div');
          lbl.className = 'call-label';
          lbl.innerHTML = '<span class="tag">' + esc(t.tag) + '</span>' + esc(t.label);
          node.appendChild(lbl);
          const pop = document.createElement('button');
          pop.className = 'call-pop';
          pop.textContent = '⇱';
          pop.title = 'Pop out';
          pop.addEventListener('click', e => {
            e.stopPropagation();
            openScreenPopup(t.key, t.stream, t.label + ' — ' + t.tag);
          });
          node.appendChild(pop);
        }
        node.addEventListener('click', () => {
          focusedTileKey = focusedTileKey === t.key ? null : t.key;
          renderCallGrid();
        });
        grid.appendChild(node);
      } else {
        node.classList.toggle('focus', isFocus);
        if (!t.audioOnly) {
          const v = node.querySelector('video');
          if (v && v.srcObject !== t.stream) v.srcObject = t.stream;
        }
        grid.appendChild(node);
      }
    }
  }

  let callFigure = null, aloneFigure = null;
  function updateCallTilesVU() {
    const grid = $('#call-grid');
    if (!grid || !callScreenOpen) return;
    for (const node of grid.querySelectorAll('.call-tile.audio-only')) {
      const key = node.dataset.key || '';
      if (key === 'audio|self') {
        node.classList.toggle('speaking', !muted && localSpeaking);
        node.classList.toggle('muted-peer', muted);
      } else if (key.startsWith('audio|')) {
        const pid = key.slice(6);
        const va = voiceActivity.get(pid);
        const lvl = Math.max(va ? va.level : 0, mesh.levelFor(pid));
        node.classList.toggle('speaking', lvl > SPEAKING);
      }
    }
  }

  // ─── Screen-share popup windows (per source) ─────────────────────
  export function openScreenPopup(key, stream, label) {
    const existing = screenPopups.get(key);
    if (existing && existing.window && !existing.window.closed) {
      try {
        existing.window.document.querySelector('video').srcObject = stream;
        existing.window.document.title = String(label || '') + ' — Sirr';
      } catch (e) {}
      existing.stream = stream;
      return existing.window;
    }
    const winName = 'sirr-screen-' + String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeLabel = esc(String(label || ''));
    const w = window.open('', winName, 'width=900,height=560,resizable=yes');
    if (!w) { chat.sysMsg('⚠ Popup blocked'); return null; }
    w.document.write('<!DOCTYPE html><html><head><title>' + safeLabel + ' — Sirr</title>'
      + '<style>*{margin:0;padding:0;background:#000;overflow:hidden}'
      + 'video{width:100vw;height:100vh;object-fit:contain}</style></head>'
      + '<body><video autoplay playsinline></video></body></html>');
    w.document.close();
    try { w.document.querySelector('video').srcObject = stream; } catch (e) {}
    screenPopups.set(key, { window: w, stream });
    try { w.addEventListener('beforeunload', () => screenPopups.delete(key)); } catch (e) {}
    return w;
  }
  export function closeScreenPopup(key) {
    const rec = screenPopups.get(key);
    if (rec && rec.window && !rec.window.closed) {
      try { rec.window.close(); } catch (e) {}
    }
    screenPopups.delete(key);
  }
  export function closeAllScreenPopups() {
    for (const key of [...screenPopups.keys()]) closeScreenPopup(key);
  }

  // ─── Screen + cam share ───────────────────────────────────────────
  export async function startScreenShare() {
    if (screenSharing || !voiceOn) return;
    if (routeIsSwarm()) {
      toasts.showToast({ type: 'warn', title: 'VIDEO NEEDS WEBRTC',
        body: 'Screen share and camera are unavailable in Swarm-only voice. Switch Voice route to Auto in settings.', ttl: 6000 });
      return;
    }
    try {
      // 1080p60 ceiling instead of the browser's conservative default.
      // Combined with the 3 Mbit/s sender cap and 'maintain-resolution'
      // degradation, shared text stays readable instead of turning to mush.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      screenSharing = true;
      audio.hintVideoTrack(screenStream, 'screen');
      const b = $('#btn-screen'); if (b) b.classList.add('sharing');
      for (const [, c] of voiceConns) {
        for (const t of screenStream.getTracks()) {
          try { c.screenSenders.push(c.pc.addTrack(t, screenStream)); } catch (e) { vwarn('addTrack screen failed', e); }
        }
        // No tuneSenders() here: setParameters() in the middle of a
        // negotiation fails, and in a glare it left the audio sender dead.
        // onsignalingstatechange → stable re-applies it once it's safe.
      }
      screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
      renderVU(); renderCallGrid(); syncCallControls(); notify();
    } catch (e) {
    }
  }
  export function stopScreenShare() {
    if (!screenSharing) return;
    screenSharing = false;
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    const b = $('#btn-screen'); if (b) b.classList.remove('sharing');
    closeScreenPopup('self|screen');
    for (const [, c] of voiceConns) {
      for (const s of c.screenSenders) { try { c.pc.removeTrack(s); } catch (e) {} }
      c.screenSenders = [];
    }
    renderVU(); renderCallGrid(); syncCallControls(); notify();
  }
  export async function startCamShare() {
    if (camSharing || !voiceOn) return;
    if (routeIsSwarm()) {
      toasts.showToast({ type: 'warn', title: 'VIDEO NEEDS WEBRTC',
        body: 'Screen share and camera are unavailable in Swarm-only voice. Switch Voice route to Auto in settings.', ttl: 6000 });
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { frameRate: 30, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      camSharing = true;
      audio.hintVideoTrack(camStream, 'cam');
      const b = $('#btn-cam'); if (b) b.classList.add('sharing');
      for (const [, c] of voiceConns) {
        for (const t of camStream.getTracks()) {
          try { c.camSenders.push(c.pc.addTrack(t, camStream)); } catch (e) { vwarn('addTrack cam failed', e); }
        }
        // No tuneSenders() here: setParameters() in the middle of a
        // negotiation fails, and in a glare it left the audio sender dead.
        // onsignalingstatechange → stable re-applies it once it's safe.
      }
      camStream.getVideoTracks()[0].onended = () => stopCamShare();
      renderVU(); renderCallGrid(); syncCallControls(); notify();
    } catch (e) {
      chat.sysMsg('⚠ Camera unavailable');
    }
  }
  export function stopCamShare() {
    if (!camSharing) return;
    camSharing = false;
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    const b = $('#btn-cam'); if (b) b.classList.remove('sharing');
    closeScreenPopup('self|cam');
    for (const [, c] of voiceConns) {
      for (const s of c.camSenders) { try { c.pc.removeTrack(s); } catch (e) {} }
      c.camSenders = [];
    }
    renderVU(); renderCallGrid(); syncCallControls(); notify();
  }

  // ─── File send (image preview + chunked binary) ──────────────────
  const hasBolt = () => typeof window.sirr?.fileSend === 'function';

  export function processFile(file) {
    // BOLT streams from disk on both ends, so the old 200 MB ceiling (a
    // RAM limit — the whole file was base64'd in memory) no longer applies.
    const cap = hasBolt() ? 4 * 1024 * 1024 * 1024 : 200 * 1024 * 1024;
    if (file.size > cap) { chat.sysMsg('⚠ Max ' + (hasBolt() ? '4 GB' : '200MB')); return; }
    const isImg = file.type.startsWith('image/');
    // Inline-preview path only for images that are reasonably small. Larger
    // images go through the lossless chunked file transfer so quality is
    // preserved — no re-encoding, no downscaling.
    if (isImg && file.size < 2 * 1024 * 1024) {
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          // Preserve detail: cap at 2048px (was 600) so shared images stay
          // crisp on modern displays. Only downscale if genuinely huge.
          const MAX = 2048; let w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
          }
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          // PNG sources (screenshots, diagrams, transparency) keep PNG to
          // avoid JPEG artifacts. Photos use JPEG at high quality (0.92).
          const isPng = file.type === 'image/png';
          const b64 = isPng
            ? c.toDataURL('image/png')
            : c.toDataURL('image/jpeg', 0.92);
          $('#img-prev-src').src = b64;
          $('#img-prev-src').style.display = '';
          $('#img-prev-name').textContent = file.name;
          $('#img-prev').classList.remove('hidden');
          $('#btn-img-yes').onclick = async () => {
            $('#img-prev').classList.add('hidden');
            try {
              const room = state.state.activeRoom;
              const r = await window.sirr.sendMessage(room, b64, 'image', { fileName: file.name });
              chat.pushMsg(room, { ...r.message, fingerprint: state.state.myFingerprint });
            } catch (e) {}
          };
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    } else {
      // Large image OR non-image → lossless chunked transfer (full quality,
      // saved to disk on the receiving end via the save dialog).
      const sizeNote = isImg
        ? ' (' + fmtSize(file.size) + ') — sent at full quality'
        : ' (' + fmtSize(file.size) + ')' + (hasBolt() ? '' : ' — ⚠ Download before closing!');
      $('#img-prev-src').style.display = 'none';
      $('#img-prev-name').textContent = file.name + sizeNote;
      $('#img-prev').classList.remove('hidden');
      $('#btn-img-yes').onclick = () => {
        $('#img-prev').classList.add('hidden');
        if (hasBolt()) sendBoltFile(file);
        else sendChunkedFile(file);
      };
    }
  }

  // ─── BOLT: main streams it; we just draw progress ───────────
  export async function sendBoltFile(file) {
    const room = state.state.activeRoom;
    const channel = state.state.activeTextChannel || 'default';
    let r;
    try { r = await window.sirr.fileSend(file, { room, channel }); }
    catch (e) { r = { ok: false, error: e?.message || String(e) }; }
    if (!r || !r.ok) chat.sysMsg('⚠ ' + file.name + ' — ' + ((r && r.error) || 'could not send'));
  }

  const ftMeta = new Map();   // id -> { name, size, dir, room, channel }
  const fmtRate = (bps) => bps > 0 ? fmtSize(bps) + '/s' : '';

  /** Unified transfer events from main (BOLT and legacy, both directions). */
  export function handleFileEvent(e) {
    if (!e || !e.id) return;
    const meta = ftMeta.get(e.id);
    switch (e.ev) {
      case 'begin': {
        ftMeta.set(e.id, { name: e.name, size: e.size, dir: e.dir, room: e.room, channel: e.channel, from: e.from });
        chat.beginTransfer(e.id, e.dir, e.name, () => { window.sirr.fileCancel(e.id); });
        if (e.dir === 'recv' && e.from) chat.sysMsg('↓ ' + (e.from.nickname || 'someone') + ' is sending ' + e.name + ' (' + fmtSize(e.size) + ')', e.room);
        return;
      }
      case 'progress': {
        const pct = e.total ? Math.min(100, Math.floor(e.bytes / e.total * 100)) : 100;
        const extra = [fmtRate(e.rate), e.dir === 'send' && e.recipients > 1 ? e.done + '/' + e.recipients + ' done' : ''].filter(Boolean).join(' · ');
        chat.updateTransfer(e.id, pct, extra);
        return;
      }
      case 'paused':
        chat.updateTransfer(e.id, null, 'paused — waiting to resume');
        chat.sysMsg('⏸ ' + ((meta && meta.name) || 'transfer') + ' — ' + (e.reason || 'paused'), meta && meta.room);
        return;
      case 'resumed':
        chat.updateTransfer(e.id, null, 'resuming…');
        return;
      case 'delivered':
        if (!e.ok && e.reason !== 'cancelled') chat.sysMsg('⚠ ' + ((meta && meta.name) || 'file') + ' — not delivered to ' + e.peer + ': ' + e.reason, meta && meta.room);
        return;
      case 'failed':
        chat.endTransfer(e.id);
        ftMeta.delete(e.id);
        chat.sysMsg('⚠ ' + (e.name || (meta && meta.name) || 'file') + ' — ' + (e.reason || 'transfer failed'), meta && meta.room);
        return;
      case 'saved':
        chat.sysMsg('✓ Saved ' + e.name + ' to Downloads');
        return;
      case 'complete': {
        chat.endTransfer(e.id);
        ftMeta.delete(e.id);
        if (e.dir === 'send') {
          if (e.cancelled) { chat.sysMsg('✕ Cancelled ' + e.name, e.room); return; }
          chat.pushMsg(e.room, {
            nickname: state.state.myNickname, type: 'file', content: 'bolt:' + e.id, fileRef: e.id,
            timestamp: Date.now(), msgId: e.id, self: true, channel: e.channel,
            fingerprint: state.state.myFingerprint, fileName: e.name, fileSize: e.size,
          });
          if (e.recipients > 0 && e.delivered < e.recipients) {
            chat.sysMsg('⚠ ' + e.name + ' — delivered to ' + e.delivered + '/' + e.recipients, e.room);
          }
          return;
        }
        chat.pushMsg(e.room, {
          peerId: e.from && e.from.peerId,
          nickname: (e.from && e.from.nickname) || 'peer', type: 'file', content: 'bolt:' + e.id, fileRef: e.id,
          timestamp: Date.now(), msgId: e.id, self: false,
          fingerprint: (e.from && e.from.fingerprint) || '', fileName: e.name, fileSize: e.size,
          channel: e.channel || 'default',
          integrityWarning: e.verified === false,
          verified: e.verified === true,
        });
        beep();
        return;
      }
    }
  }

  export async function sendChunkedFile(file) {
    const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const total = Math.ceil(file.size / CHUNK);
    const room = state.state.activeRoom;

    let cancelled = false;
    chat.beginTransfer(fileId, 'send', file.name, () => { cancelled = true; });

    try {
      // Kick off the SHA-256 hash in the background (don't block the first
      // chunk on it). For files within the cap we await the result just
      // before sending END so integrity is still verified, but the transfer
      // body starts streaming immediately.
      const HASH_CAP = 50 * 1024 * 1024;
      let hashPromise = Promise.resolve('');
      if (file.size <= HASH_CAP) {
        hashPromise = (async () => {
          try {
            const buf = await file.arrayBuffer();
            const dg = await crypto.subtle.digest('SHA-256', buf);
            return Array.from(new Uint8Array(dg))
              .map(b => b.toString(16).padStart(2, '0')).join('');
          } catch (e) { return ''; }
        })();
      }

      await window.sirr.sendFileStart({
        room, channel: state.state.activeTextChannel || 'default', fileId, fileName: file.name, fileSize: file.size,
        totalChunks: total, sender: state.state.myNickname, fingerprint: state.state.myFingerprint,
      });

      // Adaptive pacing: yield to the event loop based on elapsed time, not a
      // fixed chunk count. This keeps the UI responsive on big transfers
      // without artificially throttling fast local-network sends. We only
      // pause if we've been running the loop for >16ms (one frame) since the
      // last yield — otherwise we push chunks back-to-back at full speed.
      let lastYield = performance.now();
      for (let i = 0; i < total; i++) {
        if (cancelled) throw new Error('cancelled');
        const start = i * CHUNK, end = Math.min(start + CHUNK, file.size);
        const ab = await file.slice(start, end).arrayBuffer();
        const u8 = new Uint8Array(ab);
        let binary = '';
        for (let j = 0; j < u8.length; j += 8192) {
          binary += String.fromCharCode.apply(null, u8.subarray(j, Math.min(j + 8192, u8.length)));
        }
        const b64 = btoa(binary);
        await window.sirr.sendFileChunk({ room, fileId, index: i, data: b64 });
        chat.updateTransfer(fileId, Math.round(((i + 1) / total) * 100));
        // Yield only when we've held the loop for a full frame, so the
        // progress bar and cancel button stay responsive.
        const now = performance.now();
        if (now - lastYield > 16) {
          await new Promise(r => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }

      const hashHex = await hashPromise;
      await window.sirr.sendFileEnd({ room, fileId, hash: hashHex, bytes: file.size });

      const url = URL.createObjectURL(file);
      fileBlobs.set(fileId, url);

      chat.pushMsg(room, {
        nickname: state.state.myNickname, content: url, type: 'file',
        timestamp: Date.now(), msgId: fileId, self: true, channel: state.state.activeTextChannel || 'default',
        fingerprint: state.state.myFingerprint, fileName: file.name, fileSize: file.size,
        blobUrl: true,
      });
    } catch (e) {
      if (String(e.message || '').includes('cancelled')) {
        chat.sysMsg('✕ Cancelled ' + file.name);
      }
    }
    chat.endTransfer(fileId);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Bridge handlers — called from app.js's IPC dispatch
  // ═══════════════════════════════════════════════════════════════════
  export function handleVoiceSignal(i) {
    let d = {};
    try { d = JSON.parse(i.data || '{}') || {}; } catch { /* ok for bare signals */ }
    if (typeof d !== 'object') d = {};
    const room    = i.room    || d.room    || '';
    const channel = i.channel || d.channel || 'default';
    const pid = i.peerId;
    if (!pid || pid === state.state.myPeerId) return;

    if (i.type === VM.JOIN) {
      const prev = voicePeers.get(pid);
      voicePeers.set(pid, { room, channel, seenAt: Date.now(), route: d.route === 'swarm' ? 'swarm' : 'auto' });
      if (!prev || prev.room !== room || prev.channel !== channel) {
        peers.updatePeers();
        rooms.renderChannels();
        renderCallGrid();
      }
      if (voiceOn && voiceRoom === room && voiceChannel === channel) {
        if (routeIsSwarm() || d.route === 'swarm') { enableSwarm(pid, 'swarm route'); return; }
        const existing = voiceConns.get(pid);
        const isHealthy = existing && ['connected', 'connecting', 'new'].includes(existing.pc.connectionState);
        if (isHealthy) return;
        if (health(pid).retryTimer) return;   // a backoff retry is already pending
        // One deterministic caller per pair: the impolite (lower id) side.
        // The polite side answers a JOIN with a direct JOIN so the
        // impolite side hears about us immediately instead of on its next
        // 5 s heartbeat. `reply` stops the two from ping-ponging.
        // Glare is still handled correctly if both do call (older builds
        // always call), this just makes it rare.
        if (!isPolite(pid)) {
          vlog('JOIN from', pid, '— we call them');
          callPeer(pid);
        } else {
          const h = health(pid);
          if (!d.reply && Date.now() - h.lastJoinReplyAt > 2000) {
            h.lastJoinReplyAt = Date.now();
            sendSig(pid, VM.JOIN, { room: voiceRoom, channel: voiceChannel, route: state.state.voiceRoute, reply: true });
          }
          // Fallback: if they never call (e.g. they think they're polite
          // because of a stale id), call them ourselves.
          scheduleRecall(pid, 2500);
        }
      }
      return;
    }

    if (i.type === VM.LEAVE) {
      const vp = voicePeers.get(pid);
      if (vp && (vp.room !== room || vp.channel !== channel)) return;  // stale LEAVE for an old channel
      voicePeers.delete(pid);
      clearRetry(pid);
      peerHealth.delete(pid);
      closeVC(pid);
      mesh.detachPeer(pid);
      swarmAnnounced.delete(pid);
      peers.updatePeers();
      rooms.renderChannels();
      renderVU();
      renderCallGrid();
      return;
    }

    if (!voiceOn || voiceRoom !== room || voiceChannel !== channel) return;

    if (i.type === VM.OFFER)  { if (d.sdp) onOffer(pid, d, room); return; }
    if (i.type === VM.ANSWER) { if (d.sdp) onAnswer(pid, d); return; }
    if (i.type === VM.ICE)    { if (d.candidate !== undefined) onICE(pid, d); return; }
  }

  export function handleFileTransfer(ft) {
    if (ft.aborted) {
      const f = incomingFiles.get(ft.fileId);
      if (f) {
        chat.endTransfer(ft.fileId);
        incomingFiles.delete(ft.fileId);
      }
      chat.sysMsg('⚠ ' + (ft.fileName || (f && f.name) || 'file') + ' — transfer rejected (' + (ft.reason || 'invalid') + ')');
      return;
    }

    if (ft.msgType === FT.START) {
      const total = Number(ft.totalChunks);
      if (!Number.isInteger(total) || total < 0 || total > MAX_INBOUND_FILE_CHUNKS) {
        chat.sysMsg('⚠ ' + (ft.fileName || 'file') + ' — invalid transfer metadata, discarded');
        return;
      }
      if ((Number(ft.fileSize) > 0) && total === 0) {
        chat.sysMsg('⚠ ' + (ft.fileName || 'file') + ' — invalid transfer metadata, discarded');
        return;
      }
      incomingFiles.set(ft.fileId, {
        chunks: new Map(), received: 0, total,
        name: ft.fileName, size: ft.fileSize, room: ft.room,
        channel: ft.channel || 'default',
        sender: ft.sender || '', fingerprint: ft.fingerprint || '',
        peerId: ft.peerId,
      });
      chat.beginTransfer(ft.fileId, 'recv', ft.fileName, () => {
        incomingFiles.delete(ft.fileId);
      });
      return;
    }

    if (ft.msgType === FT.CHUNK) {
      const f = incomingFiles.get(ft.fileId); if (!f) return;
      if (typeof ft.index !== 'number' || ft.index < 0 || ft.index >= f.total) return;
      if (f.chunks.has(ft.index)) return;  // duplicate
      f.chunks.set(ft.index, ft.data);
      f.received++;
      chat.updateTransfer(ft.fileId, f.total ? Math.round((f.received / f.total) * 100) : 100);
      return;
    }

    if (ft.msgType === FT.END) {
      const f = incomingFiles.get(ft.fileId); if (!f) return;
      chat.endTransfer(ft.fileId);
      incomingFiles.delete(ft.fileId);

      if (f.received !== f.total) {
        chat.sysMsg('⚠ ' + f.name + ' — transfer incomplete (' + f.received + '/' + f.total + ' chunks), discarded');
        return;
      }

      let bytes;
      try {
        const parts = new Array(f.total);
        let totalLen = 0;
        for (let i = 0; i < f.total; i++) {
          const chunk = f.chunks.get(i);
          if (chunk == null) throw new Error('missing chunk');
          const bin = atob(chunk);
          const u8 = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
          parts[i] = u8;
          totalLen += u8.length;
        }
        bytes = new Uint8Array(totalLen);
        let off = 0;
        for (const p of parts) { bytes.set(p, off); off += p.length; }
      } catch (e) {
        chat.sysMsg('⚠ ' + f.name + ' — could not decode, file corrupt');
        return;
      }

      (async () => {
        let integrityOK = true;
        if (ft.hash) {
          try {
            const dg = await crypto.subtle.digest('SHA-256', bytes);
            const got = Array.from(new Uint8Array(dg))
              .map(b => b.toString(16).padStart(2, '0')).join('');
            if (got !== ft.hash) integrityOK = false;
          } catch (e) {}
        }
        if (ft.bytes && ft.bytes !== bytes.byteLength) integrityOK = false;

        if (!integrityOK) {
          chat.sysMsg('⚠ ' + f.name + ' — integrity check failed, file may be corrupt');
        }

        const url = URL.createObjectURL(new Blob([bytes]));
        fileBlobs.set(ft.fileId, url);
        if (state.state.autoDownload === 'on') downloadUrl(url, f.name);

        chat.pushMsg(f.room, {
          peerId: f.peerId,
          nickname: f.sender, content: url, type: 'file',
          timestamp: Date.now(), msgId: ft.fileId, self: false,
          fingerprint: f.fingerprint, fileName: f.name, fileSize: f.size,
          channel: f.channel || 'default',
          blobUrl: true,
          integrityWarning: !integrityOK,
        });
        beep();
      })();
    }
  }

  export function handlePeerLeft(pid) {
    closeVC(pid);
    mesh.detachPeer(pid);
    voicePeers.delete(pid);
    clearRetry(pid);
    peerHealth.delete(pid);
    swarmAnnounced.delete(pid);
    renderVU();
    renderCallGrid();
  }

  // Send a direct VOICE_JOIN to a freshly-connected peer if we're in voice
  // and they're in our voice room. Lets them know to call us when ready.
  export function handleNewPeer(p, roomsList) {
    if (!voiceOn || !voiceRoom) return;
    if (!Array.isArray(roomsList) || !roomsList.includes(voiceRoom)) return;
    setTimeout(() => {
      try {
        window.sirr.sendVoiceSignal(p.peerId, VM.JOIN, JSON.stringify({ room: voiceRoom, channel: voiceChannel, route: state.state.voiceRoute }), voiceRoom, voiceChannel);
      } catch (e) { vwarn('direct JOIN to new peer failed', e); }
    }, 300);
  }

  // ─── DOM listeners (called once on boot) ─────────────────────────
  export function init() {
    const bm = $('#btn-mute'); if (bm) bm.addEventListener('click', toggleMute);
    const bd = $('#btn-deaf'); if (bd) bd.addEventListener('click', toggleDeafen);
    const bl = $('#btn-voice-leave'); if (bl) bl.addEventListener('click', leaveVoice);
    const bs = $('#btn-screen'); if (bs) bs.addEventListener('click', () => {
      if (screenSharing) stopScreenShare(); else startScreenShare();
    });
    const bc = $('#btn-cam'); if (bc) bc.addEventListener('click', () => {
      if (camSharing) stopCamShare(); else startCamShare();
    });
    const cm = $('#btn-call-mute');   if (cm) cm.addEventListener('click', toggleMute);
    const cd = $('#btn-call-deaf');   if (cd) cd.addEventListener('click', toggleDeafen);
    const cs = $('#btn-call-screen'); if (cs) cs.addEventListener('click', () => {
      if (screenSharing) stopScreenShare(); else startScreenShare();
    });
    const cc = $('#btn-call-cam');    if (cc) cc.addEventListener('click', () => {
      if (camSharing) stopCamShare(); else startCamShare();
    });
    const cv = $('#btn-call-devices'); if (cv) cv.addEventListener('click', toggleDevicePicker);
    const dp = $('#call-devices');
    if (dp) dp.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dev-kind]');
      if (!b) return;
      onDevicePick(b.dataset.devKind, b.dataset.devId || '');
    });
    const cn = $('#btn-call-stats');  if (cn) cn.addEventListener('click', audio.toggleHud);
    const cl = $('#btn-call-leave');  if (cl) cl.addEventListener('click', leaveVoice);
    const cx = $('#btn-call-close');  if (cx) cx.addEventListener('click', closeCallScreen);
    const sc = $('#btn-sv-close');    if (sc) sc.addEventListener('click', () => {
      closeAllScreenPopups();
      const sv = $('#screen-view'); if (sv) sv.classList.add('hidden');
    });
  }

  
  /** Diagnostics for bug reports / the test harness. No side effects. */
  export function debugState() {
    return {
      voiceOn, voiceRoom, voiceChannel, muted, deafened, noMic,
      micEnabled: localStream ? localStream.getAudioTracks().map(t => t.enabled) : null,
      gateOpen, localLevel: Math.round(localLevel),
      conns: [...voiceConns].map(([pid, c]) => ({ pid, cs: c.pc.connectionState, ss: c.pc.signalingState, meshRx: c.meshRx, meshTx: c.meshTx, sid: c.sid, remoteSid: c.remoteSid })),
      swarm: mesh.swarmPeers(),
    };
  }
