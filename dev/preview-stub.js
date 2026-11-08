/**
 * Renderer preview stub.
 *
 * Stands in for the preload bridge so the renderer can be opened in a plain
 * browser with believable data — no Electron, no network, no keys. Used by
 * dev/preview.mjs for screenshots and for quick UI work.
 *
 * Query string:  ?screen=join    start on the join screen (no saved rooms)
 *                ?screen=empty   rooms, but no messages yet
 *                ?screen=alone   rooms, no messages, nobody else online
 */
(() => {
  const q = new URLSearchParams(location.search);
  const empty = q.get('screen') === 'join';
  const alone = q.get('screen') === 'alone';
  const noHistory = q.get('screen') === 'empty' || alone;
  const now = Date.now();
  const FP = { me: '8F3A 21C9 7E04 B6D2', ana: '1C77 E0A4 93BF 5D20', ravi: 'D4E1 0B6A C83F 7712', kemal: '5A90 FF13 2C6E 84B1' };
  const rooms = empty ? [] : [
    { code: 'SR-7KQM3-XWP9T-RVHC4-N2BZD-QF8MA-K3RT9-VYH4K-PAXNE', name: 'field-notes', channels: null },
    { code: 'SR-M2RT8-VYH4K-PAXN6-EWQ3C-JD7KQ-M3XWP-9TRVH-C4N2B', name: 'press-desk', channels: null },
    { code: 'DM4F0A21C97E', name: 'ana', isDm: true, dmPeer: { fingerprint: FP.ana, nickname: 'ana' } },
  ];
  const channels = [
    { id: 'default', kind: 'text', name: 'general' },
    { id: 'text-notes', kind: 'text', name: 'sources' },
    { id: 'voice-1', kind: 'voice', name: 'briefing' },
  ];
  const m = (i, who, fp, txt, extra) => ({
    msgId: 'm' + i + 'a9f3c21d', nickname: who, fingerprint: fp, content: txt, type: 'text',
    timestamp: now - (40 - i) * 97000, self: who === 'nadia', channel: 'default', sig: 'x', ...(extra || {}),
  });
  const history = [
    m(1, 'ana', FP.ana, 'Checkpoint list for tonight is up. Nothing leaves this room.'),
    m(2, 'ravi', FP.ravi, 'Got it. The relay on the east side is down again, routing through the second node.'),
    m(3, 'nadia', FP.me, 'Confirmed on my end — fingerprints match what we compared in person.'),
    m(4, 'kemal', FP.kemal, 'Uploading the scans in a minute. `sha256` will be in the caption.'),
    m(5, 'ana', FP.ana, 'Thanks. Keep messages short, the room is set to vanish after one day.', { replyTo: { msgId: 'm4a9f3c21d', nick: 'kemal', preview: 'Uploading the scans in a minute.' } }),
    m(6, 'nadia', FP.me, 'Will do.'),
  ];
  const peers = (empty || alone) ? [] : [
    { peerId: 'p-ana', nickname: 'ana', fingerprint: FP.ana, status: 'active', forwardSecret: true, rooms: [rooms[0].code, rooms[2].code] },
    { peerId: 'p-ravi', nickname: 'ravi', fingerprint: FP.ravi, status: 'away', statusText: 'on the road', forwardSecret: true, rooms: [rooms[0].code] },
    { peerId: 'p-kemal', nickname: 'kemal', fingerprint: FP.kemal, status: 'active', forwardSecret: true, rooms: [rooms[0].code, rooms[1].code] },
  ];
  const listeners = {};
  const known = {
    getVersion: () => '1.1.0',
    getIdentity: () => ({ nickname: 'nadia', fingerprint: FP.me, publicKey: 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq8M=', peerId: 'a1b2c3d4e5f6', dataDir: '/tmp' }),
    lockStatus: () => ({ enabled: false, keystore: true }), lockEnable: () => ({ ok: true }), lockDisable: () => ({ ok: true }), lockNow: () => ({ ok: false }), panicWipe: () => ({ ok: true }),
    getConfig: () => ({ nickname: 'nadia', linkPreview: 'off' }),
    getRooms: () => rooms,
    getDmRooms: () => rooms.filter(r => r.isDm),
    getChannels: () => channels,
    getHistory: (code, ch) => (!noHistory && code === rooms[0]?.code && ch === 'default') ? history : [],
    getPeers: () => peers,
    getStats: () => ({ peers: peers.length, sessions: peers.length, rooms: rooms.length, uptime: 4521000, storage: {} }),
    getNetworkStatus: () => ({ initialized: true }),
    getContacts: () => ({ [FP.ana]: { fingerprint: FP.ana, nickname: 'ana' } }),
    getBlocklist: () => ({}),
    getAllRosters: () => ({}),
    getRoster: () => ({}),
    getPins: () => ({}),
    getRoomTtl: () => ({ ttl: 86400000 }),
    pathwaysStats: () => ({ bridge: '', remembered: 41, relays: 3, relayMode: 'auto', volunteering: false, nearby: { links: 2, reach: 5, circuits: 1 }, ble: 'unavailable', servingBridge: false }), noteInviteHints: () => true, restartApp: () => true, moveRoom: () => ({ ok: false, error: 'preview' }),
    getRoomEphemeral: () => ({ on: false }), setRoomEphemeral: (r, on) => ({ ok: true, on }),
    getRoomAdmin: () => ({ owner: { fingerprint: FP.me }, myFingerprint: FP.me, isOwner: true, admins: {}, perms: {}, permKeys: [] }),
    generateRoomCode: () => 'SR-7KQM3-XWP9T-RVHC4-N2BZD-QF8MA-K3RT9-VYH4K-PAXNE',
    buildInviteUrl: (c) => 'sirr://join/' + c,
    generateQr: () => null,
    getAudioAssets: () => ({ wasm: null, worklet: null }),
  };
  window.sirr = window.sirr = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      if (name.startsWith('on')) return (cb) => { (listeners[name] = listeners[name] || []).push(cb); };
      if (name === 'sendVoiceMedia') return () => {};
      if (known[name]) return async (...a) => known[name](...a);
      return async () => ({ ok: true });
    },
  });
  window.__previewEmit = (name, data) => (listeners[name] || []).forEach(cb => cb(data));
})();
