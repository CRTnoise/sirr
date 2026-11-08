/**
 * Mobile bridge — Capacitor + nodejs-mobile-cordova
 * ===================================================
 * Detects whether the renderer is running inside a Capacitor WebView. When
 * it is, attaches a `window.sirr` whose surface matches preload.js (the
 * Electron desktop bridge), but routes every call through the nodejs-mobile
 * channel instead of Electron IPC.
 *
 * Wire format (mirrors nodejs-mobile/index.js):
 *   →  { id, method, args }
 *   ←  { id, ok, result?, error? }    (response to a request)
 *   ←  { event, data }                 (network event broadcast)
 *
 * On desktop (no Capacitor global) this script is a complete no-op — the
 * Electron preload still owns `window.sirr`.
 *
 * IMPORTANT: load this BEFORE app.js so app.js's first read of
 * `window.sirr.getIdentity()` resolves through the bridge.
 */
(function () {
  'use strict';

  // ─── Platform gate ───────────────────────────────────────────────
  // Capacitor injects `window.Capacitor` synchronously. If it's not there
  // we're on Electron — leave window.sirr alone.
  const isCap = !!(window.Capacitor && typeof window.Capacitor.getPlatform === 'function');
  if (!isCap) return;

  // The cordova plugin attaches `cordova.plugins.nodejs` once `deviceready`
  // fires. We queue calls during the gap and flush on ready.
  let nodejs = null;
  let ready = false;
  const pendingSends = [];
  const pendingResponses = new Map();   // id -> { resolve, reject }
  const eventListeners = new Map();     // event -> Array<cb>
  let nextReqId = 1;

  function _ensureFlush() {
    if (!ready || !nodejs) return;
    while (pendingSends.length) {
      const env = pendingSends.shift();
      try { nodejs.channel.send(env); } catch (e) {}
    }
  }

  function _onChannelMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (msg.id != null) {
      const pend = pendingResponses.get(msg.id);
      if (!pend) return;
      pendingResponses.delete(msg.id);
      if (msg.ok) pend.resolve(msg.result);
      else pend.reject(new Error(String(msg.error || 'IPC error')));
      return;
    }
    if (msg.event) {
      const ls = eventListeners.get(msg.event);
      if (!ls) return;
      for (const cb of ls) {
        try { cb(msg.data); } catch (e) { console.error('[mobile-bridge] listener for', msg.event, e); }
      }
    }
  }

  function invoke(method, args) {
    const id = nextReqId++;
    const env = JSON.stringify({ id, method, args });
    return new Promise((resolve, reject) => {
      pendingResponses.set(id, { resolve, reject });
      if (ready && nodejs) {
        try { nodejs.channel.send(env); }
        catch (e) { pendingResponses.delete(id); reject(e); }
      } else {
        pendingSends.push(env);
      }
    });
  }

  function on(event, cb) {
    if (typeof cb !== 'function') return;
    if (!eventListeners.has(event)) eventListeners.set(event, []);
    eventListeners.get(event).push(cb);
  }

  // ─── window.sirr — surface matches preload.js verbatim ─────────
  // Each entry maps to the same IPC channel name nodejs-mobile/index.js
  // routes via its `methods` table.
  window.sirr = {
    // Clipboard — Capacitor Clipboard plugin handles this in the renderer
    // directly. Keep the API shape; just ignore on mobile.
    copyText: (text) => {
      try {
        if (window.Capacitor?.Plugins?.Clipboard) {
          return window.Capacitor.Plugins.Clipboard.write({ string: String(text || '') });
        }
      } catch (e) {}
      try { return navigator.clipboard.writeText(String(text || '')); } catch (e) {}
      return Promise.resolve(false);
    },

    // Identity / config
    getIdentity:  () => invoke('get-identity'),
    getConfig:    () => invoke('get-config'),
    updateConfig: (p) => invoke('update-config', p),
    getVersion:   () => invoke('get-version'),

    // Rooms
    getRooms:         () => invoke('get-rooms'),
    joinRoom:         (code) => invoke('join-room', code),
    createRoom:       (code) => invoke('create-room', code),
    leaveRoom:        (code) => invoke('leave-room', code),
    renameRoom:       (code, name) => invoke('rename-room', { code, name }),
    generateRoomCode: () => invoke('generate-room-code'),
    buildInviteUrl:   (code) => invoke('build-invite-url', code),

    // Room admin / permissions
    getRoomAdmin: (code) => invoke('get-room-admin', code),
    setAdmin:     (code, fingerprint, perms) => invoke('set-admin',    { code, fingerprint, perms }),
    removeAdmin:  (code, fingerprint) => invoke('remove-admin', { code, fingerprint }),

    // Channels
    getChannels:   (code) => invoke('get-channels', code),
    createChannel: (room, kind, name) => invoke('create-channel', { room, kind, name }),
    renameChannel: (room, channelId, name) => invoke('rename-channel', { room, channelId, name }),
    deleteChannel: (room, channelId) => invoke('delete-channel', { room, channelId }),

    // History
    getHistory:   (code, channel) => invoke('get-history',   { code, channel }),
    clearHistory: (code, channel) => invoke('clear-history', { code, channel }),

    // Messages
    sendMessage:   (room, content, type, extra) => invoke('send-message', { room, content, type, extra }),
    sendFileStart: (d) => invoke('send-file-start', d),
    sendFileChunk: (d) => invoke('send-file-chunk', d),
    sendFileEnd:   (d) => invoke('send-file-end',   d),
    deleteMessage: (room, channel, msgId) => invoke('delete-message', { room, channel, msgId }),
    editMessage:   (room, channel, msgId, content) => invoke('edit-message', { room, channel, msgId, content }),
    deleteForAll:  (room, channel, msgId) => invoke('delete-for-all', { room, channel, msgId }),
    sendTyping:    (room, channel) => invoke('send-typing', { room, channel }),

    // Voice
    sendVoiceSignal: (peerId, signalType, data, room, channel) =>
      invoke('voice-signal', { peerId, signalType, data, room, channel }),

    // Contacts / DMs
    getContacts:   () => invoke('get-contacts'),
    addContact:    (fingerprint, nickname, avatarEmoji) => invoke('add-contact', { fingerprint, nickname, avatarEmoji }),
    removeContact: (fingerprint) => invoke('remove-contact', { fingerprint }),
    openDm:        (fingerprint, nickname) => invoke('open-dm', { fingerprint, nickname }),
    getDmRooms:    () => invoke('get-dm-rooms'),

    // Roster + blocklist
    getRoster:     (code) => invoke('get-roster', code),
    getAllRosters: () => invoke('get-all-rosters'),
    getBlocklist:  () => invoke('get-blocklist'),
    blockPeer:     (fingerprint, nickname) => invoke('block-peer',   { fingerprint, nickname }),
    unblockPeer:   (fingerprint) => invoke('unblock-peer', { fingerprint }),

    // Backup / restore — TODO Android-native (SAF) impl
    exportAllData: () => invoke('export-all-data'),
    importAllData: () => invoke('import-all-data'),

    // Idle / order
    setIdleStatus: (status) => invoke('set-idle-status', { status }),
    reorderRooms:  (codes) => invoke('reorder-rooms', { codes }),

    // Link preview — TODO mobile impl (use Capacitor HTTP plugin once enabled)
    fetchLinkPreview: (url) => invoke('fetch-link-preview', url),

    // Pinned messages
    getPins:   (room, channel) => invoke('get-pins', { room, channel }),
    togglePin: (room, channel, msgId, pinned, preview, nick, ts) =>
      invoke('toggle-pin', { room, channel, msgId, pinned, preview, nick, ts }),

    // Introspection
    getPeers: () => invoke('get-peers'),
    getStats: () => invoke('get-stats'),

    // Network event listeners — same names preload uses, routed through
    // the channel envelope dispatched in _onChannelMessage above.
    onMessage:        (cb) => on('network:message',         cb),
    onPeerJoined:     (cb) => on('network:peer-joined',     cb),
    onPeerUpdated:    (cb) => on('network:peer-updated',    cb),
    onPeerLeft:       (cb) => on('network:peer-left',       cb),
    onRoomJoined:     (cb) => on('network:room-joined',     cb),
    onCryptoError:    (cb) => on('network:crypto-error',    cb),
    onPeerTyping:     (cb) => on('network:peer-typing',     cb),
    onVoiceSignal:    (cb) => on('network:voice-signal',    cb),
    onFileTransfer:   (cb) => on('network:file-transfer',   cb),
    onRoomRenamed:    (cb) => on('network:room-renamed',    cb),
    onChannelCreated: (cb) => on('network:channel-created', cb),
    onChannelRenamed: (cb) => on('network:channel-renamed', cb),
    onChannelDeleted: (cb) => on('network:channel-deleted', cb),
    onChannelsSync:   (cb) => on('network:channels-sync',   cb),
    onContactAdd:     (cb) => on('network:contact-add',     cb),
    onPinToggle:      (cb) => on('network:pin-toggle',      cb),
    onPinsSync:       (cb) => on('network:pins-sync',       cb),
    onRoomCharter:    (cb) => on('network:room-charter',    cb),
    onAdminUpdate:    (cb) => on('network:admin-update',    cb),
    onAdminSync:      (cb) => on('network:admin-sync',      cb),
    onMessageEdited:        (cb) => on('network:msg-edit',           cb),
    onMessageDeletedForAll: (cb) => on('network:msg-delete-for-all', cb),

    // Deep link — Capacitor App plugin's appUrlOpen feeds this. We bridge
    // it in the boot block below so app.js can subscribe identically.
    onDeepLinkJoin:   (cb) => on('deep-link:join', cb),
  };

  // ─── Boot ────────────────────────────────────────────────────────
  document.addEventListener('deviceready', () => {
    nodejs = window.cordova?.plugins?.nodejs;
    if (!nodejs) {
      console.error('[mobile-bridge] nodejs-mobile-cordova not present at deviceready');
      return;
    }
    nodejs.channel.setListener({}, _onChannelMessage);
    nodejs.start('index.js', (err) => {
      if (err) {
        console.error('[mobile-bridge] nodejs.start failed:', err);
        return;
      }
      ready = true;
      _ensureFlush();
    });
  }, { once: true });

  // Capacitor App plugin pipes sirr://join/<code> intent here. Decode +
  // re-broadcast on the same channel name app.js subscribes to, so the
  // deep-link path is identical to desktop.
  try {
    const App = window.Capacitor?.Plugins?.App;
    if (App && App.addListener) {
      App.addListener('appUrlOpen', (data) => {
        if (!data || !data.url) return;
        const m = /^sirr:\/\/(?:join\/)?([A-Z0-9-]+)/i.exec(data.url);
        if (!m) return;
        const code = m[1].toUpperCase();
        const ls = eventListeners.get('deep-link:join');
        if (ls) for (const cb of ls) { try { cb({ code }); } catch (e) {} }
      });
    }
  } catch (e) {}
})();
