/**
 * Sirr — Preload bridge
 * Exposes a safe IPC surface to the renderer via contextBridge.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sirr', {
  // ─ Clipboard
  copyText: text => ipcRenderer.invoke('clipboard-write', text),

  // ─ Identity / config
  getIdentity: ()  => ipcRenderer.invoke('get-identity'),
  // ─ App lock / panic
  lockStatus:  ()  => ipcRenderer.invoke('lock-status'),
  lockEnable:  p   => ipcRenderer.invoke('lock-enable', p),
  lockDisable: p   => ipcRenderer.invoke('lock-disable', p),
  lockNow:     ()  => ipcRenderer.invoke('lock-now'),
  panicWipe:   ()  => ipcRenderer.invoke('panic-wipe'),
  getConfig:   ()  => ipcRenderer.invoke('get-config'),
  updateConfig: p  => ipcRenderer.invoke('update-config', p),
  // Resolve the real app version from package.json via main's app.getVersion().
  getVersion:  ()  => ipcRenderer.invoke('get-version'),

  // ─ Rooms
  getRooms:        ()          => ipcRenderer.invoke('get-rooms'),
  joinRoom:        code        => ipcRenderer.invoke('join-room', code),
  // createRoom: like joinRoom but records the caller as the room's owner.
  // Use this only in the "Create new room" flow — paste/invite joins stay
  // on joinRoom so they don't accidentally claim ownership.
  createRoom:      code        => ipcRenderer.invoke('create-room', code),
  leaveRoom:       code        => ipcRenderer.invoke('leave-room', code),
  moveRoom:        (code, evict) => ipcRenderer.invoke('move-room', { code, evict }),
  onRoomMoved:     cb => ipcRenderer.on('network:room-moved', (_, d) => cb(d)),
  onRoomMovePending: cb => ipcRenderer.on('network:room-move-pending', (_, d) => cb(d)),
  renameRoom:      (code, name) => ipcRenderer.invoke('rename-room', { code, name }),
  generateRoomCode: ()           => ipcRenderer.invoke('generate-room-code'),
  buildInviteUrl:   code         => ipcRenderer.invoke('build-invite-url', code),
  noteInviteHints:  url          => ipcRenderer.invoke('note-invite-hints', url),
  pathwaysStats:    ()           => ipcRenderer.invoke('pathways-stats'),
  restartApp:       ()           => ipcRenderer.invoke('restart-app'),

  // ─ Room admin / permissions
  getRoomAdmin:    code                                => ipcRenderer.invoke('get-room-admin', code),
  setAdmin:        (code, fingerprint, perms)          => ipcRenderer.invoke('set-admin',    { code, fingerprint, perms }),
  removeAdmin:     (code, fingerprint)                 => ipcRenderer.invoke('remove-admin', { code, fingerprint }),

  // ─ Channels
  getChannels:   code                         => ipcRenderer.invoke('get-channels', code),
  createChannel: (room, kind, name)           => ipcRenderer.invoke('create-channel', { room, kind, name }),
  renameChannel: (room, channelId, name)      => ipcRenderer.invoke('rename-channel', { room, channelId, name }),
  deleteChannel: (room, channelId)            => ipcRenderer.invoke('delete-channel', { room, channelId }),

  // ─ History (per channel)
  getHistory:   (code, channel) => ipcRenderer.invoke('get-history', { code, channel }),
  clearHistory: (code, channel) => ipcRenderer.invoke('clear-history', { code, channel }),

  // ─ Messages
  sendMessage:   (room, content, type, extra) => ipcRenderer.invoke('send-message', { room, content, type, extra }),
  // ─ Disappearing messages (per-room TTL)
  getRoomTtl:    room => ipcRenderer.invoke('get-room-ttl', room),
  setRoomTtl:    (room, ttl) => ipcRenderer.invoke('set-room-ttl', { room, ttl }),
  getRoomEphemeral: room => ipcRenderer.invoke('get-room-ephemeral', room),
  setRoomEphemeral: (room, on) => ipcRenderer.invoke('set-room-ephemeral', { room, on }),
  // ─ BOLT file transfer. Pass the File object itself: its disk
  //   path is resolved HERE, so page script can only ever send files the
  //   user actually dropped or picked. Clipboard / generated files (no
  //   path) are sent from memory.
  fileSend: async (file, meta) => {
    const m = meta || {};
    let p = '';
    try { p = webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : ''; } catch (e) { p = ''; }
    const req = { room: m.room, channel: m.channel, name: (file && file.name) || m.name || 'file' };
    if (p) req.path = p;
    else req.bytes = new Uint8Array(await file.arrayBuffer());
    return ipcRenderer.invoke('ft-send', req);
  },
  fileCancel: id => ipcRenderer.invoke('ft-cancel', id),
  fileSave:   id => ipcRenderer.invoke('ft-save', id),
  fileShow:   id => ipcRenderer.invoke('ft-show', id),
  fileInfo:   id => ipcRenderer.invoke('ft-info', id),
  onFileEvent: cb => ipcRenderer.on('ft:event', (_, d) => cb(d)),
  acceptDmRequest:  code => ipcRenderer.invoke('accept-dm-request', code),
  declineDmRequest: (code, block) => ipcRenderer.invoke('decline-dm-request', { code, block }),
  onDmOpened: cb => ipcRenderer.on('network:dm-opened', (_, d) => cb(d)),
  onClockSkew: cb => ipcRenderer.on('network:clock-skew', (_, d) => cb(d)),
  onCharterConflict: cb => ipcRenderer.on('network:charter-conflict', (_, d) => cb(d)),
  sendFileStart: d => ipcRenderer.invoke('send-file-start', d),
  sendFileChunk: d => ipcRenderer.invoke('send-file-chunk', d),
  sendFileEnd:   d => ipcRenderer.invoke('send-file-end',   d),
  deleteMessage: (room, channel, msgId) => ipcRenderer.invoke('delete-message', { room, channel, msgId }),
  // Author-only edit. Returns { ok, message?, editedAt?, error? }.
  editMessage:   (room, channel, msgId, content) => ipcRenderer.invoke('edit-message', { room, channel, msgId, content }),
  // Authoritative delete (owner / room admin / original author). Broadcasts
  // so peers also delete their copy.
  deleteForAll:  (room, channel, msgId) => ipcRenderer.invoke('delete-for-all', { room, channel, msgId }),
  sendTyping:    (room, channel) => ipcRenderer.invoke('send-typing', { room, channel }),

  // ─ Audio engine assets (RNNoise wasm + AudioWorklet source).
  //   Read by main because the renderer's file:// origin cannot fetch().
  getAudioAssets: () => ipcRenderer.invoke('get-audio-assets'),

  // ─ Voice
  sendVoiceSignal: (peerId, signalType, data, room, channel) =>
    ipcRenderer.invoke('voice-signal', { peerId, signalType, data, room, channel }),
  // mesh audio over the Hyperswarm connection (fire-and-forget).
  sendVoiceMedia: (peerId, data, room) =>
    ipcRenderer.send('voice-media', { peerId, room, data }),

  // ─ Contacts
  getContacts:   ()                                      => ipcRenderer.invoke('get-contacts'),
  addContact:    (fingerprint, nickname, avatarEmoji)    => ipcRenderer.invoke('add-contact', { fingerprint, nickname, avatarEmoji }),
  removeContact: fingerprint                             => ipcRenderer.invoke('remove-contact', { fingerprint }),

  // ─ Direct messages
  openDm:     (fingerprint, nickname) => ipcRenderer.invoke('open-dm', { fingerprint, nickname }),
  getDmRooms: ()                       => ipcRenderer.invoke('get-dm-rooms'),

  // ─ Room roster (persisted "peers ever seen" for each room)
  getRoster:     code => ipcRenderer.invoke('get-roster', code),
  getAllRosters: ()   => ipcRenderer.invoke('get-all-rosters'),

  // ─ Blocklist
  getBlocklist:  ()                        => ipcRenderer.invoke('get-blocklist'),
  blockPeer:     (fingerprint, nickname)   => ipcRenderer.invoke('block-peer',   { fingerprint, nickname }),
  unblockPeer:   fingerprint               => ipcRenderer.invoke('unblock-peer', { fingerprint }),

  // ─ Backup / restore
  exportAllData: (passphrase) => ipcRenderer.invoke('export-all-data', String(passphrase || '')),
  importAllData: (passphrase) => ipcRenderer.invoke('import-all-data', String(passphrase || '')),

  // ─ Idle / status
  setIdleStatus: status => ipcRenderer.invoke('set-idle-status', { status }),

  // ─ Room drag order
  reorderRooms: codes => ipcRenderer.invoke('reorder-rooms', { codes }),

  // ─ Link preview (opt-in, fetched in main to avoid CORS + IP leak via renderer)
  fetchLinkPreview: url => ipcRenderer.invoke('fetch-link-preview', url),

  // ─ Pinned messages
  getPins:    (room, channel)                                                        => ipcRenderer.invoke('get-pins', { room, channel }),
  togglePin:  (room, channel, msgId, pinned, preview, nick, ts)                      => ipcRenderer.invoke('toggle-pin', { room, channel, msgId, pinned, preview, nick, ts }),

  // ─ Introspection
  getPeers: () => ipcRenderer.invoke('get-peers'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  generateQr:       text => ipcRenderer.invoke('generate-qr', text),
  getNetworkStatus: ()   => ipcRenderer.invoke('get-network-status'),

  // ─ Network events (listeners)
  onMessage:      cb => ipcRenderer.on('network:message',     (_, d) => cb(d)),
  onPeerJoined:   cb => ipcRenderer.on('network:peer-joined', (_, d) => cb(d)),
  onPeerUpdated:  cb => ipcRenderer.on('network:peer-updated',(_, d) => cb(d)),
  onPeerLeft:     cb => ipcRenderer.on('network:peer-left',   (_, d) => cb(d)),
  onRoomJoined:   cb => ipcRenderer.on('network:room-joined', (_, d) => cb(d)),
  onCryptoError:  cb => ipcRenderer.on('network:crypto-error',(_, d) => cb(d)),
  onPeerTyping:   cb => ipcRenderer.on('network:peer-typing', (_, d) => cb(d)),
  onVoiceSignal:  cb => ipcRenderer.on('network:voice-signal',(_, d) => cb(d)),
  onVoiceMedia:   cb => ipcRenderer.on('network:voice-media', (_, d) => cb(d)),
  onFileTransfer: cb => ipcRenderer.on('network:file-transfer',(_, d) => cb(d)),
  onRoomRenamed:  cb => ipcRenderer.on('network:room-renamed',(_, d) => cb(d)),
  onChannelCreated: cb => ipcRenderer.on('network:channel-created', (_, d) => cb(d)),
  onChannelRenamed: cb => ipcRenderer.on('network:channel-renamed', (_, d) => cb(d)),
  onChannelDeleted: cb => ipcRenderer.on('network:channel-deleted', (_, d) => cb(d)),
  onChannelsSync:   cb => ipcRenderer.on('network:channels-sync',   (_, d) => cb(d)),
  onContactAdd:     cb => ipcRenderer.on('network:contact-add',     (_, d) => cb(d)),
  onPinToggle:      cb => ipcRenderer.on('network:pin-toggle',      (_, d) => cb(d)),
  onPinsSync:       cb => ipcRenderer.on('network:pins-sync',       (_, d) => cb(d)),
  onRoomCharter:    cb => ipcRenderer.on('network:room-charter',    (_, d) => cb(d)),
  onAdminUpdate:    cb => ipcRenderer.on('network:admin-update',    (_, d) => cb(d)),
  onAdminSync:      cb => ipcRenderer.on('network:admin-sync',      (_, d) => cb(d)),
  // Edit + authoritative-delete events from peers (and from our own writes
  // — main echoes both back so a single update path covers local + remote).
  onMessageEdited:        cb => ipcRenderer.on('network:msg-edit',           (_, d) => cb(d)),
  onMessageDeletedForAll: cb => ipcRenderer.on('network:msg-delete-for-all', (_, d) => cb(d)),

  // Disappearing messages: main sweeps expired rows on a timer and tells us
  // which {room, channel, msgId} vanished so open views can drop them live.
  onMessagesExpired: cb => ipcRenderer.on('messages-expired', (_, d) => cb(d)),

  // ─ Deep-link (sirr://join/<code>)
  onDeepLinkJoin:   cb => ipcRenderer.on('deep-link:join', (_, d) => cb(d)),
});
