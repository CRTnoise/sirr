
export const state = {
  myNickname: 'anon', myFingerprint: '', myPeerId: '',
  activeRoom: null, activeTextChannel: 'default',
  railMode: 'rooms', voiceChannel: null, voiceOn: false, voiceRoom: null,
  muted: false, deafened: false, screenSharing: false, camSharing: false,
  noMic: false, callScreenOpen: false,
  accentColor: '#4ff0a0', fontScale: 1, density: 'default', bubble: 'flat',
  chatBg: 'none', timeFormat: '12', notifSound: 'on',
  avatarEmoji: '', avatarImage: '', statusText: '', autoDownload: 'off',
  desktopNotifs: 'all', mentionToasts: 'on', sendTypingPref: 'on',
  highContrast: 'off', largeTargets: 'off', linkPreview: 'off',
  vcAutoMute: 'off', noiseGate: 'off', reduceMotion: 'off',
  // ─ Audio engine ─
  // audioProfile:    'voice' | 'studio' | 'lowband'
  // audioRedundancy: 'on' | 'off'   — RFC 2198 RED packet duplication
  // audioLatency:    'low' | 'balanced' | 'stable' — jitter buffer target
  // denoise:         'on' | 'off'   — RNNoise neural suppression
  audioProfile: 'voice', audioRedundancy: 'on',
  audioLatency: 'balanced', denoise: 'off',
  // ─ Mesh voice (experimental) ─
  // Sirr's own audio pipeline: WebCodecs Opus + our jitter buffer
  // + our redundancy, over an unreliable data channel. Opt-in.
  meshVoice: 'off', meshBuffer: 'balanced',
  // ─ Voice route ─ 'auto' = WebRTC, Hyperswarm fallback per peer
  //                        'swarm' = never open WebRTC (no STUN contact)
  voiceRoute: 'auto',
  meshRedundancy: 'on', meshCopies: '2', meshSpacing: '3',
  // ─ Audio devices ─ real deviceIds, deliberately not 'default'
  audioInputId: '', audioOutputId: '',
  lastActivity: Date.now(), idleState: 'active',
  inviteTargetFp: null,
};

export const vcState = {
  localStream: null, screenStream: null, camStream: null,
  screenSharing: false, camSharing: false,
  localAnalyser: null, localSpeaking: false, localLevel: 0,
  vcHeartbeat: null, vaPoller: null,
  callScreenOpen: false, focusedTileKey: null,
};

export const peers           = new Map();
export const roomData        = new Map();
export const roomPeers       = new Map();
export const roomLedger      = new Map();
export const roomRoster      = new Map();
export const voiceConns      = new Map();
export const voicePeers      = new Map();
export const voiceActivity   = new Map();
export const peerVideos      = new Map();
export const pendingICE      = new Map();   // peerId -> RTCIceCandidateInit[]
export const screenPopups    = new Map();   //
export const incomingFiles   = new Map();
export const fileBlobs       = new Map();
export const reactions       = new Map();
export const activeTransfers = new Map();
export const contacts        = new Map();
export const blocklist       = new Set();
export const pinnedMessages  = new Map();
export const roomAdminState  = new Map();
export const ROOM_PERM_LABELS = {
    createChannel: 'Create channels',
    renameChannel: 'Rename channels',
    deleteChannel: 'Delete channels',
    renameRoom:    'Rename the room',
  };


  // WebRTC
// ─── ICE configuration ────────────────────────────────────────────
// STUN is how a peer learns its own public address, which means whoever
// runs the STUN server learns that you are about to place a call, roughly
// to whom (by timing), and from what IP. The defaults below are operators
// outside the ad business; set `stunServers` in config (comma-separated
// URLs) to use your own — a self-hosted coturn makes call setup depend on
// nobody — or set the voice route to "swarm" to never open WebRTC at all.
//
// Note there is deliberately NO TURN server here. TURN relays media
// through a third party, which would break the "no server ever sees
// your traffic" guarantee. If a NAT is strict enough that direct
// connection fails, we fail loudly instead of quietly relaying.
export const DEFAULT_STUN = [
  { urls: 'stun:stun.nextcloud.com:443' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const RTC = {
  iceServers: DEFAULT_STUN,
  // Pre-gather candidates so the first offer already carries them —
  // shaves a round trip (typically 200-400 ms) off call setup.
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

/** Swap in user-configured STUN servers (called at boot from app.js). */
export function setIceServers(list) {
  if (Array.isArray(list) && list.length) RTC.iceServers = list;
  else RTC.iceServers = DEFAULT_STUN;
}
export const VM = { OFFER: 0x10, ANSWER: 0x11, ICE: 0x12, LEAVE: 0x13, JOIN: 0x14 };
  // File-transfer message type codes — mirror MSG.* in lib/network.js
export const FT = { START: 0x20, CHUNK: 0x21, END: 0x22 };
export const CHUNK = 512 * 1024;

  // Stuck-PC detection: if a PC is still 'connecting' or 'have-local-offer'
  // after this many ms, we consider it dead and rebuild.
export const PC_STUCK_MS = 8000;

// ─── Simple Subscription System ───
const listeners = new Set();

export const subscribe = (fn) => listeners.add(fn);
export const unsubscribe = (fn) => listeners.delete(fn);

// This replaces your old 'notify' logic
export const emitStateChange = () => {
  listeners.forEach(fn => fn(state));
};