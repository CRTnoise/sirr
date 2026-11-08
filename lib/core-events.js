'use strict';
/**
 * Sirr core — network event wiring shared by desktop and mobile
 * ═══════════════════════════════════════════════════════════════════
 * Everything that decides what a peer is ALLOWED to do lives here:
 * charters and ownership, admin grants, channel permissions, room keys,
 * offline-sync verification, edits, deletes-for-all, pins, file events.
 * Desktop (Electron main.js) and Sirr Mobile (the Bare worklet) both
 * call this — one implementation, so the two can never drift apart on a
 * security decision.
 *
 * ctx = {
 *   storage, network, crypto, transfers,
 *   send(channel, data)   deliver an event to the UI
 *   attention()           optional: flash / vibrate on a new message
 *   downloadsDir()        where auto-downloaded files go
 * }
 */
const fs = require('fs');
const path = require('path');
const msgsig = require('./msgsig');
const RoomMove = require('./roommove');
const TransferManager = require('./transfers');

function uniquePath(dir, name) {
  const safe = TransferManager.safeName(name);
  const ext = path.extname(safe), base = path.basename(safe, ext);
  let p = path.join(dir, safe), k = 1;
  while (fs.existsSync(p) && k < 1000) p = path.join(dir, base + ' (' + (k++) + ')' + ext);
  return p;
}

function wireCore(ctx) {
  const { storage, network, crypto, transfers } = ctx;
  const _idOf = (i) => (i && i.peerId) ? network.identityIdOf(i.peerId) : '';
  const _syncWanted = new Map();   // peerId|room -> { ids:Set, at }
  const _charterWarned = new Set();
  // DM rooms are pinned to the counterpart's full identity.
  network.pinCheck = (room, fp, id) => storage.pinIdentity(room, fp, id);

  const send = ctx.send;

  network.on('message', (msg) => {
    // Inbound caps — lenient (slice, never drop) so messages from slightly
    // older clients still arrive. Text well past our own 4000-char send cap
    // is hostile padding; persisting megabyte strings bloats the DB and
    // stalls the renderer.
    if (msg && msg.type === 'text' && typeof msg.content === 'string' && msg.content.length > 8000) {
      msg.content = msg.content.slice(0, 8000);
    }
    // a DM for a conversation we don't have yet. From a contact it
    // opens normally; from anyone else it becomes a message request.
    if (msg.room && /^DM[0-9A-F]{10}$/.test(msg.room) && msg.fingerprint) {
      if (!storage.getRoomRecord(msg.room)) {
        const isContact = !!((storage.getContacts() || {})[msg.fingerprint]);
        try { storage.addDmRoom(msg.room, msg.fingerprint, msg.nickname || ''); } catch (e) {}
        if (!isContact) storage.setDmRequest(msg.room, true);
        else { try { network.joinRoom(msg.room); } catch (e) {} }
        send('network:dm-opened', { room: msg.room, fingerprint: msg.fingerprint, nickname: msg.nickname || '', request: !isContact });
      }
      if (storage.isDmRequest(msg.room)) msg.dmRequest = true;
    }
    if (msg.room) {
      if (msg.msgId && storage.hasMessage(msg.room, msg.channel || 'default', msg.msgId)) return;
      storage.appendMessage(msg.room, msg.channel || 'default', {
        nickname: msg.nickname, content: msg.content, type: msg.type,
        timestamp: msg.timestamp, msgId: msg.msgId, self: false,
        fingerprint: msg.fingerprint, replyTo: msg.replyTo,
        channel: msg.channel || 'default',
        fileName: msg.fileName, fileSize: msg.fileSize,
        expiresAt: msg.expiresAt || 0,
        sig: msg.sig || undefined,
      });
      // Also fold the sender into the room roster — ensures the ledger
      // gets populated even if peer-joined propagation was slow or the
      // sender only shared the room through a lazy CHAT add.
      if (msg.fingerprint) {
        try {
          storage.touchRoster(msg.room, msg.fingerprint, {
            nickname: msg.nickname || '',
          });
        } catch (e) {}
      }
    }
    send('network:message', msg);
    ctx.attention && ctx.attention();
  });

  network.on('peer-joined', p => {
    send('network:peer-joined', p);
    // Sync our current room names + per-room channel lists to the new peer
    // so they converge on our view instead of seeing stale codes and a bare
    // "default" channel. Room-rename is only sent if we actually renamed;
    // channel sync is always sent so fresh peers get every user-created
    // channel in one shot (broadcast on create is fire-and-forget).
    try {
      const shared = Array.isArray(p.rooms) ? p.rooms : [];
      if (!shared.length) return;
      const myRooms = storage.getRooms();
      for (const r of myRooms) {
        if (!shared.includes(r.code)) continue;
        if (r.name && r.name !== r.code) {
          network.sendRoomRenameTo(p.peerId, r.code, r.name, true);
        }
        const chans = storage.getChannels(r.code);
        if (chans && chans.length) {
          network.sendChannelsSyncTo(p.peerId, r.code, chans);
        }
        // Offline sync: tell the peer the msgIds we already have so they can
        // send back anything we missed while offline. Both sides send — the
        // receiver dedupes. This closes the "was offline when peer posted"
        // gap without a central relay.
        try {
          const ids = storage.getRoomMessageIds(r.code, 1000);
          if (ids && ids.length) network.sendSyncSummaryTo(p.peerId, r.code, ids);
        } catch (e) {}
        // Send our pin list for each channel in this room so the new peer
        // converges on our state. We never clobber on receive — pins are
        // merged additively on the renderer side.
        try {
          const bundles = storage.getAllPinsForRoom(r.code);
          for (const b of bundles) {
            network.sendPinsSyncTo(p.peerId, r.code, b.channel, b.pins);
          }
        } catch (e) {}
        // Charter + admin table: tell the new peer who owns this room (if
        // we know) and, IF we're the owner, ship the full admin snapshot so
        // they don't need to guess. Non-owners skip ADMIN_SYNC because the
        // receiver would reject it.
        try {
          const owner = storage.getRoomOwner(r.code) || {};
          const myFp = crypto.getFingerprint();
          if (owner.fingerprint && owner.fingerprint === myFp && owner.createdAt) {
            network.sendRoomCharterTo(p.peerId, r.code, owner.fingerprint, owner.createdAt);
            network.sendAdminSyncTo(p.peerId, r.code, storage.getAdmins(r.code));
          }
        } catch (e) {}
        // Persist peer in this room's roster so "who has access" survives
        // restarts and disconnects.
        if (p.fingerprint) {
          try {
            storage.touchRoster(r.code, p.fingerprint, {
              nickname: p.nickname || '',
              avatarEmoji: p.avatarEmoji || '',
              avatarPixels: p.avatarPixels || '',
            });
          } catch (e) {}
        }
      }
      // Refresh contact lastSeenAt for anyone already in our contacts list
      try { storage.touchContact(p.fingerprint, { nickname: p.nickname, avatarEmoji: p.avatarEmoji, avatarPixels: p.avatarPixels || '' }); } catch (e) {}
    } catch (e) {}
  });
  network.on('peer-updated', p => {
    send('network:peer-updated', p);
    // A peer-updated may expose new shared rooms (our joinRoom re-intersect,
    // or a peer's own ROOMS_UPDATE). Fold the peer into each of those rooms'
    // roster so the ledger stays current without waiting for a CHAT.
    if (p.fingerprint && Array.isArray(p.rooms)) {
      for (const code of p.rooms) {
        try {
          storage.touchRoster(code, p.fingerprint, {
            nickname: p.nickname || '',
            avatarEmoji: p.avatarEmoji || '',
            avatarPixels: p.avatarPixels || '',
          });
        } catch (e) {}
      }
    }
  });
  network.on('peer-left',       p => send('network:peer-left', p));
  network.on('dm-key',          i => { try { storage.setDmPeerKey(i.room, i.publicKey); } catch (e) {} });
  network.on('room-joined',     i => send('network:room-joined', i));
  network.on('crypto-error',    i => send('network:crypto-error', i));
  network.on('peer-typing',     i => send('network:peer-typing', i));
  network.on('voice-signal',    i => send('network:voice-signal', i));
  network.on('voice-media',     i => send('network:voice-media', i));
  // Legacy file messages are consumed by the TransferManager (disk-backed,
  // shared with BOLT); the renderer only sees unified 'ft:event's.
  transfers.on('event', async (e) => {
    // Persist completed transfers as file messages. Until now only
    // the UI showed them, so they vanished from history on restart even
    // though the received file itself was kept.
    if (e.ev === 'complete' && !e.cancelled && (e.dir === 'recv' || e.recipients >= 0)) {
      try {
        const mine = e.dir === 'send';
        storage.appendMessage(e.room, e.channel || 'default', {
          msgId: e.id, type: 'file', fileRef: e.id, content: 'bolt:' + e.id,
          fileName: e.name, fileSize: e.size, timestamp: Date.now(), self: mine,
          nickname: mine ? (storage.getConfig().nickname || '') : ((e.from && e.from.nickname) || ''),
          fingerprint: mine ? crypto.getFingerprint() : ((e.from && e.from.fingerprint) || ''),
          verified: e.verified === true ? true : undefined,
        });
      } catch (err) {}
    }
    send('ft:event', e);
    if (e.ev === 'complete' && e.dir === 'recv' && storage.getConfig().autoDownload === 'on') {
      try {
        const dest = uniquePath(ctx.downloadsDir(), e.name);
        const r = await transfers.saveTo(e.id, dest);
        if (r.ok) send('ft:event', { ev: 'saved', id: e.id, name: e.name, path: dest });
      } catch (err) {}
    }
  });
  network.on('room-renamed',    i => {
    // silent renames (name syncs to a newly connected peer) used to
    // skip the permission check, so any member could rename the room in
    // everyone else's sidebar. Same gate for both now; the owner/admins
    // still sync the real name.
    if (typeof i.newName !== 'string' || !i.newName.trim()) return;
    i.newName = i.newName.slice(0, 64);
    if (!storage.hasPerm(i.room, i.fingerprint, 'renameRoom', _idOf(i))) return;
    if (!i.silent) { try { storage.renameRoom(i.room, i.newName); } catch (e) {} }
    send('network:room-renamed', i);
  });

  // ─── Room charter + admin table propagation ─────────────────────
  network.on('room-charter', i => {
    const myFp = crypto.getFingerprint();
    // Charter is authoritative only if the sender is claiming THEMSELVES
    // as owner — i.e. the sender's fingerprint matches the ownerFingerprint
    // they're announcing. Otherwise ignore: a peer can't vouch for a
    // third-party's ownership without our trusting them transitively.
    if (i.fingerprint !== i.ownerFingerprint) return;
    const changed = storage.acceptRoomCharter(i.room, i.ownerFingerprint, i.createdAt, myFp, _idOf(i));
    if (changed === 'conflict') {
      // Someone other than the owner we already know claims the room.
      // Keep the known owner; tell the user once per claimant.
      const k = i.room + '|' + i.fingerprint;
      if (!_charterWarned.has(k)) {
        _charterWarned.add(k);
        send('network:charter-conflict', { room: i.room, claimant: i.fingerprint, nickname: i.nickname || '' });
      }
      return;
    }
    if (changed) send('network:room-charter', { room: i.room, owner: i.ownerFingerprint, createdAt: i.createdAt });
  });
  network.on('admin-update', i => {
    // Only accept grants/revokes from the verified owner of the room.
    const owner = storage.getRoomOwner(i.room);
    if (!owner || !owner.fingerprint || owner.fingerprint !== i.fingerprint) return;
    if (!storage.pinIdentity(i.room, i.fingerprint, _idOf(i))) return;
    try {
      if (i.perms) storage.setAdmin(i.room, i.target, i.perms, owner.fingerprint);
      else storage.removeAdmin(i.room, i.target);
    } catch (e) {}
    send('network:admin-update', { room: i.room, target: i.target, perms: i.perms || null });
  });
  network.on('admin-sync', i => {
    // Bulk replace is only trusted from the owner.
    const owner = storage.getRoomOwner(i.room);
    if (!owner || !owner.fingerprint || owner.fingerprint !== i.fingerprint) return;
    if (!storage.pinIdentity(i.room, i.fingerprint, _idOf(i))) return;
    try { storage.replaceAdmins(i.room, i.admins, owner.fingerprint); } catch (e) {}
    send('network:admin-sync', { room: i.room, admins: storage.getAdmins(i.room) });
  });

  // Channel admin — gate on sender's permissions (owner or granted admin)
  // BEFORE reconciling storage, so a peer without perms can't mutate our
  // local state or propagate a stale event to the renderer.
  network.on('channel-created', i => {
    if (!storage.hasPerm(i.room, i.fingerprint, 'createChannel', _idOf(i))) return;
    try { storage.addChannel(i.room, i.channel); } catch (e) {}
    send('network:channel-created', i);
  });
  network.on('channel-renamed', i => {
    if (!storage.hasPerm(i.room, i.fingerprint, 'renameChannel', _idOf(i))) return;
    try { storage.renameChannel(i.room, i.channelId, i.newName); } catch (e) {}
    send('network:channel-renamed', i);
  });
  network.on('channel-deleted', i => {
    if (!storage.hasPerm(i.room, i.fingerprint, 'deleteChannel', _idOf(i))) return;
    try { storage.removeChannel(i.room, i.channelId); } catch (e) {}
    send('network:channel-deleted', i);
  });
  network.on('channels-sync', i => {
    // Persist any unknown channels from the peer's snapshot. We never
    // delete via sync — that would let a misinformed peer wipe our list.
    // Trust channels-sync from peers with createChannel perm (owner or
    // granted admin). hasPerm returns true for rooms where we don't yet
    // know the owner (fresh join, charter not arrived) — which is exactly
    // the case we need to accept so a new joiner converges on the existing
    // channel list instead of being stuck on bare "default".
    const trusted = storage.hasPerm(i.room, i.fingerprint, 'createChannel', _idOf(i));
    if (trusted) {
      try {
        const existing = new Set(storage.getChannels(i.room).map(ch => ch.id));
        for (const ch of i.channels) {
          if (!existing.has(ch.id)) storage.addChannel(i.room, ch);
        }
      } catch (e) {}
      send('network:channels-sync', i);
    }
  });

  // ─── Contacts + offline sync ────────────────────────────────────
  network.on('contact-add', i => send('network:contact-add', i));
  network.on('clock-skew', i => send('network:clock-skew', i));

  // Per-room signing keys, told to us directly by their owner.
  network.on('room-keys', i => {
    for (const k of i.keys) {
      const r = storage.setRoomSignKey(k.room, i.fingerprint, k.pub, _idOf(i));
      if (r === 'conflict') console.warn('[sirr] room key change refused for', i.fingerprint, 'in', k.room);
    }
  });

  network.on('sync-summary', i => {
    // Peer told us their last N msgIds for room X. Any that we don't
    // already have, we request. Compare against on-disk history (not
    // just a channel because older clients may have sent msgIds for
    // different channels).
    try {
      const missing = [];
      for (const e of i.ids) {
        if (!e || !e.msgId) continue;
        if (!storage.hasMessage(i.room, e.channel || 'default', e.msgId)) {
          missing.push(e.msgId);
        }
      }
      if (missing.length) {
        // Remember exactly what we asked this peer for. Only those bodies
        // are accepted back (see sync-messages) — no unsolicited injection.
        const key = i.peerId + '|' + i.room;
        const w = _syncWanted.get(key) || { ids: new Set(), at: 0 };
        for (const id of missing) w.ids.add(id);
        w.at = Date.now();
        _syncWanted.set(key, w);
        network.sendSyncRequestTo(i.peerId, i.room, missing);
      }
    } catch (e) {}
  });

  network.on('sync-request', i => {
    // Peer is asking for full bodies of these msgIds. Look them up in our
    // per-room store and return whatever we have, encrypted.
    try {
      const msgs = storage.getMessagesByIds(i.room, i.msgIds);
      if (msgs.length) network.sendSyncMessagesTo(i.peerId, i.room, msgs);
    } catch (e) {}
  });

  // Pin toggle from a peer — persist our side, then relay to renderer.
  // A pin carries a preview and an author name for peers who never saw the
  // message. Both come from whoever sent the pin, so when we hold the
  // message ourselves, what we stored wins: a member can't pin "Ana: …"
  // over a message Ana never wrote.
  const pinInfo = (room, ch, msgId, claimed) => {
    let local = null;
    try { local = storage.messages.getMessage(room, ch, msgId); } catch (e) {}
    if (local) return { preview: String(local.content || '').slice(0, 200), nick: String(local.nickname || '').slice(0, 32), ts: Number(local.timestamp) || Date.now(), verified: true };
    return { preview: String(claimed.preview || '').slice(0, 200), nick: String(claimed.nick || '').slice(0, 32), ts: Number(claimed.ts) || Date.now() };
  };
  network.on('pin-toggle', i => {
    const ch = String(i.channel || 'default').slice(0, 64), id = String(i.msgId).slice(0, 64);
    const info = pinInfo(i.room, ch, id, i);
    try { storage.setPin(i.room, ch, id, !!i.pinned, info); } catch (e) {}
    send('network:pin-toggle', { ...i, preview: info.preview, nick: info.nick, ts: info.ts });
  });
  // Bulk pins from a peer on join — merge into storage, then tell renderer.
  network.on('pins-sync', i => {
    try {
      for (const p of (Array.isArray(i.pins) ? i.pins : []).slice(0, 200)) {
        if (!p || !p.msgId) continue;
        // Don't overwrite an existing local pin (ours wins on merge).
        const existing = storage.getPins(i.room, i.channel);
        if (existing[p.msgId]) continue;
        const ch = String(i.channel || 'default').slice(0, 64), id = String(p.msgId).slice(0, 64);
        const info = pinInfo(i.room, ch, id, p);
        p.preview = info.preview; p.nick = info.nick; p.ts = info.ts;
        storage.setPin(i.room, ch, id, true, info);
      }
    } catch (e) {}
    send('network:pins-sync', i);
  });

  // ─── Message edits + authoritative deletes ───────────────────────
  // Author-only edits. The storage layer enforces the same fingerprint
  // check we use locally — a peer claiming to edit someone else's msg gets
  // refused server-side too.
  network.on('msg-edit', i => {
    try {
      const r = storage.editMessage(i.room, i.channel, i.msgId, i.content, i.fingerprint,
        { editSig: typeof i.editSig === 'string' ? i.editSig.slice(0, 100) : '', editedAt: i.editedAt }, _idOf(i));
      if (!r.ok) return;
      send('network:msg-edit', {
        room: i.room, channel: i.channel, msgId: i.msgId,
        content: i.content, editedAt: i.editedAt, fingerprint: i.fingerprint,
      });
    } catch (e) {}
  });

  // Delete-for-all. Receiver verifies the sender has moderation rights OR
  // is the original author. Mirrors the IPC-side gate.
  network.on('msg-delete-for-all', i => {
    try {
      const existing = storage.messages.getMessage(i.room, i.channel, i.msgId);
      if (!existing) return;
      const isAuthor = existing.fingerprint && existing.fingerprint === i.fingerprint
        && storage.pinIdentity(i.room, i.fingerprint, _idOf(i));
      if (!isAuthor && !storage.canModerate(i.room, i.fingerprint, _idOf(i))) return;
      const r = storage.deleteMessage(i.room, i.channel, i.msgId);
      if (!r.ok) return;
      send('network:msg-delete-for-all', {
        room: i.room, channel: i.channel, msgId: i.msgId,
        byFingerprint: i.fingerprint,
      });
    } catch (e) {}
  });

  network.on('sync-messages', i => {
    // Peer sent us the full bodies for the msgIds we requested. Persist
    // (dedupe by msgId) and push each one to the renderer as an arriving
    // message so it appears in the UI immediately. We mark `sync: true`
    // so the renderer can suppress notifications / beeps.
    //
    // Hardening: messages aren't signed by their authors, so a relay
    // can claim any author. We (1) accept only ids we actually requested
    // from this peer in the last 2 minutes, (2) bound every field, and
    // (3) flag a message as `relayedBy` when its claimed author isn't the
    // peer who handed it to us — the UI shows it as unverified. A message
    // relayed by its own author is authentic (the channel is
    // crypto-authenticated to that identity).
    const key = i.peerId + '|' + i.room;
    const wanted = _syncWanted.get(key);
    if (!wanted || Date.now() - wanted.at > 120000) { _syncWanted.delete(key); return; }
    const TYPES = new Set(['text', 'image', 'file']);
    for (const m of i.messages) {
      if (!m || typeof m.msgId !== 'string' || !wanted.ids.has(m.msgId)) continue;
      wanted.ids.delete(m.msgId);
      const type = TYPES.has(m.type) ? m.type : null;
      if (!type) continue;                     // never relay invites/system/etc.
      const ch = typeof m.channel === 'string' && m.channel.length <= 64 ? m.channel : 'default';
      if (storage.hasMessage(i.room, ch, m.msgId)) continue;
      const claimedFp = typeof m.fingerprint === 'string' ? m.fingerprint.slice(0, 64) : '';
      // Authorship: (a) handed to us by its own author — authentic; (b) we
      // hold the author's room key and the signature checks — authentic;
      // (c) we hold the key and it does NOT check — forged, dropped;
      // (d) we've never met the author — kept, shown as unverified.
      const verdict = msgsig.judgeRelayed({
        room: i.room, m, relayerFp: i.fingerprint,
        getKey: (fp) => storage.getRoomSignKey(i.room, fp),
      });
      if (verdict === 'forged') { console.warn('[sirr] dropped relayed message with a bad signature', m.msgId); continue; }
      const verified = verdict === 'authentic';
      const relayed = !verified;
      const content = typeof m.content === 'string' ? m.content.slice(0, type === 'image' ? 12 * 1024 * 1024 : 8000) : '';
      const rec = {
        nickname: String(m.nickname || i.peerId).slice(0, 32),
        content: type === 'file' ? '' : content,
        type,
        timestamp: Number.isFinite(m.timestamp) ? m.timestamp : Date.now(),
        msgId: m.msgId,
        self: false,
        fingerprint: claimedFp,
        replyTo: m.replyTo && typeof m.replyTo === 'object' ? {
          msgId: String(m.replyTo.msgId || '').slice(0, 64),
          nick: String(m.replyTo.nick || '').slice(0, 32),
          preview: String(m.replyTo.preview || '').slice(0, 200),
        } : null,
        channel: ch,
        fileName: String(m.fileName || '').slice(0, 200),
        fileSize: Number(m.fileSize) || 0,
        relayedBy: relayed ? { nickname: String(i.nickname || '').slice(0, 32), fingerprint: i.fingerprint } : undefined,
        verified: verified && claimedFp !== i.fingerprint ? true : undefined,
        sig: typeof m.sig === 'string' ? m.sig.slice(0, 100) : undefined,
        editSig: typeof m.editSig === 'string' ? m.editSig.slice(0, 100) : undefined,
        editedAt: Number(m.editedAt) || undefined,
      };
      try { storage.appendMessage(i.room, ch, rec); } catch (e) {}
      send('network:message', { ...rec, peerId: i.peerId, room: i.room, sync: true });
    }
    if (!wanted.ids.size) _syncWanted.delete(key);
  });

  // ─── Room moves (rekey / eviction) — see lib/roommove.js ────────
  const _moveSent = new Set();   // pid|from
  const _carryTrust = (from, to, name) => {
    const old = storage.getRoomRecord(from);
    const rec = storage.addRoom(to, name || (old && old.name) || null);
    if (old && rec) {
      // Same owner, same people: ownership, identity pins and room keys carry over.
      storage.copyRoomTrust(from, to);
    }
  };
  const _forwardMoves = () => {
    for (const r of storage.getRooms()) {
      const m = r.moved;
      if (!m) continue;
      if (Date.now() - (r.movedAt || m.ts) > RoomMove.FORWARD_DAYS * 864e5) {
        // Forwarding window over: stop listening on the old code.
        try { network.leaveRoom(r.code); } catch (e) {}
        continue;
      }
      for (const pid of network.peersInRoom(r.code)) {
        const fp = network.peerInfo(pid)?.fingerprint;
        if (!fp || m.evict.includes(fp) || _moveSent.has(pid + '|' + r.code)) continue;
        if (network.sendRoomMove(pid, m)) _moveSent.add(pid + '|' + r.code);
      }
    }
  };
  const _fwdTimer = setInterval(_forwardMoves, 15000);
  if (_fwdTimer.unref) _fwdTimer.unref();
  network.on('peer-joined', () => setTimeout(_forwardMoves, 500));

  network.on('room-move', i => {
    const m = RoomMove.clean(i.move);
    if (!m) return;
    const rec = storage.getRoomRecord(m.from);
    if (!rec || rec.moved) return;
    const v = RoomMove.judge(m, rec, { fingerprint: i.fingerprint, identityId: i.identityId }, crypto.getFingerprint());
    if (!v.ok) {
      if (v.why !== 'evicted') send('network:room-move-pending', { room: m.from, why: v.why });
      return;
    }
    _carryTrust(m.from, m.to, rec.name);
    storage.setRoomMoved(m.from, m);
    Promise.resolve(network.joinRoom(m.to)).catch(() => {});
    send('network:room-moved', { from: m.from, to: m.to, name: rec.name || m.name || '', by: i.fingerprint, owner: m.owner, evicted: m.evict.length });
    setTimeout(_forwardMoves, 200);
  });

  /** Owner: move a room to a fresh code, leaving `evictFps` behind. */
  async function moveRoom(room, evictFps) {
    const rec = storage.getRoomRecord(room);
    if (!rec) throw new Error('unknown room');
    if (rec.moved) throw new Error('room already moved');
    const m = RoomMove.make(crypto, room, rec.name, evictFps);
    storage.addRoom(m.to, rec.name || null, { asOwner: true, myFingerprint: crypto.getFingerprint() });
    storage.copyRoomTrust(room, m.to);
    storage.pinIdentity(m.to, crypto.getFingerprint(), crypto.getIdentityId());
    storage.setRoomMoved(room, m);
    await network.joinRoom(m.to);
    _forwardMoves();
    return m;
  }
  /**
   * A message found in the DHT by Echoes (lib/echoes.js). Judged exactly like
   * a relayed message: authentic only if its signature checks against the
   * author's room key we learned from them directly.
   */
  function acceptEcho(room, m) {
    const rec0 = storage.getRoomRecord(room);
    if (!rec0 || rec0.moved) return false;
    const TYPES = new Set(['text', 'image', 'file']);
    if (!m || typeof m.msgId !== 'string' || m.msgId.length > 64 || !TYPES.has(m.type)) return false;
    if (m.fingerprint === crypto.getFingerprint()) return false;
    const ch = typeof m.channel === 'string' && m.channel.length <= 64 ? m.channel : 'default';
    if (storage.hasMessage(room, ch, m.msgId)) return false;
    if (m.expiresAt && m.expiresAt < Date.now()) return false;
    const verdict = msgsig.judgeRelayed({ room, m, relayerFp: '', getKey: (fp) => storage.getRoomSignKey(room, fp) });
    if (verdict === 'forged') return false;
    const rec = {
      nickname: String(m.nickname || '?').slice(0, 32),
      content: m.type === 'file' ? '' : String(m.content || '').slice(0, 8000),
      type: m.type, timestamp: Number.isFinite(m.timestamp) ? m.timestamp : Date.now(),
      msgId: m.msgId, self: false, fingerprint: String(m.fingerprint || '').slice(0, 64),
      replyTo: m.replyTo && typeof m.replyTo === 'object' ? { msgId: String(m.replyTo.msgId || '').slice(0, 64), nick: String(m.replyTo.nick || '').slice(0, 32), preview: String(m.replyTo.preview || '').slice(0, 200) } : null,
      channel: ch, fileName: String(m.fileName || '').slice(0, 200), fileSize: Number(m.fileSize) || 0,
      verified: verdict === 'authentic' ? true : undefined,
      relayedBy: verdict === 'authentic' ? undefined : { nickname: 'echo', fingerprint: '' },
      echo: true, sig: typeof m.sig === 'string' ? m.sig.slice(0, 100) : undefined,
      expiresAt: Number(m.expiresAt) || 0,
    };
    try { storage.appendMessage(room, ch, rec); } catch (e) {}
    send('network:message', { ...rec, room, sync: true });
    return true;
  }
  return { moveRoom, acceptEcho };
}

module.exports = { wireCore, uniquePath };
