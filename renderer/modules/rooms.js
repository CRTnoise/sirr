/**
 * Rooms — room rail, room metadata, channel sidebar, quick switcher.
 *
 * Owns the visual surfaces that arrange rooms and channels:
 *   - Rail (#room-rail) — left strip of room/DM tiles + drag-to-reorder
 *   - Channel sidebar (#vchan-list, #tchan-list) with inline rename / add
 *   - Quick switcher (Ctrl+K) — fuzzy filter across rooms, channels, contacts
 *   - Global-unread dot (#global-unread-dot) for the rooms ↔ DMs toggle
 *
 * Wiring: app.js calls `setDeps({...})` once on boot with shared collections
 * (roomData, roomPeers, peers, contacts, voicePeers), state getters
 * (activeRoom/activeTextChannel/voiceRoom/voiceChannel/voiceOn/railMode),
 * cross-module callbacks (clearChat, renderMsg, scrollBottom, sysMsg, …),
 * and writeback hooks for activeRoom + activeTextChannel + railMode that
 * app.js mirrors so existing read sites keep working.
 *
 * Plain <script>; load before app.js.
 */
import * as state from './state.js';
import * as glyphs from './glyphs.js';
import * as toasts from './toasts.js';
import * as admin from './admin-panel.js';
import * as peers from './peers.js';
import * as chat from './chat.js';
import * as voice from './voice.js';

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const $ = s => document.querySelector(s);
  function applyBubble(b) {
    const m = $('#messages'); if (!m) return;
    m.classList.remove('bubble-subtle', 'bubble-glass');
    if (b === 'subtle' || b === 'glass') m.classList.add('bubble-' + b);
    
  }
 function applyChatBg(b) {
    const m = document.querySelector('.c-msgs');
    if (!m) return;
    // 1. Clean up old classes
    m.classList.remove('bg-dots', 'bg-grid', 'bg-circuit');
    // 2. Add the new one if it's valid
    if (['dots', 'grid', 'circuit'].includes(b)) {
        m.classList.add('bg-' + b);
        // 3. SAVE IT so it stays after a refresh
        localStorage.setItem('sirr_bg', b);
    } else {
        localStorage.removeItem('sirr_bg');
    }
  } 
  // ─── Room metadata: add / remove / switch ─────────────────────────
  export async function addRoom(code, nameOrMeta, maybeMeta) {
    let seedName, meta;
    if (typeof nameOrMeta === 'string') { seedName = nameOrMeta; meta = maybeMeta || null; }
    else if (nameOrMeta && typeof nameOrMeta === 'object') { meta = nameOrMeta; }
    try {
      const r = meta && meta.asOwner
        ? await window.sirr.createRoom(code)
        : await window.sirr.joinRoom(code);
      if (r && r.ok === false) return false;
      if (!state.roomData.has(code)) {
        state.roomData.set(code, { messages: [], unread: 0, name: seedName || code });
      }
      const rd = state.roomData.get(code);
      if (seedName) rd.name = seedName;
      if (meta && meta.isDm) { rd.isDm = true; rd.dmPeer = meta.dmPeer || null; }
      ensureChannelsMap(code);
      absorbChannels(code, r && r.channels);
      // Legacy default-channel history comes back inline with joinRoom
      if (r && r.history && r.history.length > 0) {
        const defCh = rd.channels.get('default');
        if (defCh && defCh.messages.length === 0) {
          defCh.messages = r.history.filter(m => m.type !== 'reaction');
        }
      }
      // Fetch history for the non-default channels we just absorbed
      for (const [chId, ch] of rd.channels) {
        if (chId === 'default') continue;
        if (ch.messages.length > 0) continue;
        try {
          const hist = await window.sirr.getHistory(code, chId);
          if (hist && hist.length > 0) ch.messages = hist.filter(m => m.type !== 'reaction');
        } catch (e) {}
      }
      if (!state.roomPeers.has(code)) state.roomPeers.set(code, new Set());

      // Re-attribute any already-known peers to this room if they share it
      for (const [pid, p] of state.peers) {
        if (p.rooms && p.rooms.includes(code)) peers.addPeerToRoom(code, pid);
      }

      renderRail();
      return true;
    } catch (e) { return false; }
  }

  export async function removeRoom(code) {
    try { await window.sirr.leaveRoom(code); } catch (e) {}
    state.roomData.delete(code);
    state.roomPeers.delete(code);
    if (state.state.activeRoom === code) {
      state.state.activeRoom = null;
      chat.clearChat();
      const nr = $('#no-room'); if (nr) nr.classList.remove('hidden');
      const lbl = $('#sb-room-label'); if (lbl) lbl.textContent = 'Select a room';
    }
    renderRail();
  }

  export function switchRoom(code) {
    state.state.activeRoom = code;
    const rd = state.roomData.get(code);
    if (!rd) return;
    rd.unread = 0;
    // Sync the disappearing-message badge to this room's TTL.
    try { if (window.__refreshTtlBadge) window.__refreshTtlBadge(); } catch (e) {}
    try { if (window.__refreshNoLog) window.__refreshNoLog(); } catch (e) {}
    ensureChannelsMap(code);
    $('#no-room')?.classList.add('hidden');
    // A new room's name defaults to its code; show a proper placeholder
    // until it's named (double-click the label to rename).
    const named = rd.name && rd.name !== code;
    const lbl = $('#sb-room-label');
    if (lbl) {
      lbl.textContent = named ? rd.name : (rd.isDm ? (rd.dmPeer?.nickname || 'Direct message') : 'Untitled room');
      lbl.classList.toggle('untitled', !named && !rd.isDm);
      lbl.title = named ? rd.name : 'Double-click to name this room';
    }
    const sbCode = $('#sb-code'); if (sbCode) { sbCode.textContent = code; sbCode.title = code; }
    try { window.dispatchEvent(new CustomEvent('sirr:room-switched', { detail: { code } })); } catch (e) {}
    // Reapply user's bubble/background settings — `applyBubble`/`applyChatBg`
    // strip the existing classes and re-add only when the arg matches a
    // valid token. Calling them with `undefined` would silently wipe the
    // user's choice on every room switch.
    applyBubble(state.state.bubble);
    applyChatBg(state.state.chatBg);
    chat.cancelReply();
    // Pick a text channel: remembered one if still present, else 'default'.
    const want = (rd.lastTextChannel && rd.channels.has(rd.lastTextChannel)) ? rd.lastTextChannel : 'default';
    switchTextChannel(want);
    peers.updatePeers();
    voice.updateVoiceUI();
    renderRail();
    // Pull owner/admins so the right-click manage menu gates correctly.
    admin.fetchRoomAdmin(code).then(() => peers.updatePeers());
  }

  // ─── Channels ─────────────────────────────────────────────────────
  export function ensureChannelsMap(code) {
    const rd = state.roomData.get(code);
    if (!rd) return null;
    if (!rd.channels) rd.channels = new Map();
    if (!rd.channels.has('default')) {
      rd.channels.set('default', { id: 'default', kind: 'text', name: 'default', messages: [], unread: 0 });
    }
    return rd.channels;
  }
  export function absorbChannels(code, list) {
    const chans = ensureChannelsMap(code);
    if (!Array.isArray(list)) return;
    for (const ch of list) {
      if (!ch || !ch.id) continue;
      if (chans.has(ch.id)) {
        const ex = chans.get(ch.id);
        ex.kind = ch.kind || ex.kind;
        ex.name = ch.name || ex.name;
      } else {
        chans.set(ch.id, { id: ch.id, kind: ch.kind || 'text', name: ch.name || ch.id, messages: [], unread: 0 });
      }
    }
  }
  export function getChannelsByKind(code, kind) {
    const rd = state.roomData.get(code);
    if (!rd || !rd.channels) return [];
    return [...rd.channels.values()].filter(c => c.kind === kind);
  }
  export function getChannelRec(code, chId) {
    const rd = state.roomData.get(code);
    if (!rd || !rd.channels) return null;
    return rd.channels.get(chId) || null;
  }

  export function switchTextChannel(chId) {
    const room = state.state.activeRoom;
    if (!room) return;
    ensureChannelsMap(room);
    const rd = state.roomData.get(room);
    if (!rd.channels.has(chId)) chId = 'default';
    state.state.activeTextChannel = chId;
    rd.lastTextChannel = chId;
    const ch = rd.channels.get(chId);
    ch.unread = 0;
    const tb = $('#tb-room'); if (tb) tb.textContent = ch.name;
    chat.renderMessages(ch.messages);
    chat.scrollBottom();
    renderChannels();
    renderRail();
    chat.updatePinsCountBadge();
    const pn = $('#pins-ov');
    if (pn && !pn.classList.contains('hidden')) chat.renderPinsPanel();
    try { $('#in-msg')?.focus(); } catch (e) {}
  }

  export function renderChannels() {
    const room = state.state.activeRoom;
    const activeText = state.state.activeTextChannel;
    const vl = $('#vchan-list'), tl = $('#tchan-list');
    const vn = $('#vchan-count'), tn = $('#tchan-count');
    if (!vl || !tl) return;
    if (!room || !state.roomData.has(room)) {
      vl.innerHTML = ''; tl.innerHTML = '';
      if (vn) vn.textContent = '0';
      if (tn) tn.textContent = '0';
      return;
    }
    ensureChannelsMap(room);
    const voices = getChannelsByKind(room, 'voice');
    const texts  = getChannelsByKind(room, 'text');
    if (vn) vn.textContent = String(voices.length);
    if (tn) tn.textContent = String(texts.length);

    const voiceOn = state.state.voiceOn;
    const voiceRoom = state.state.voiceRoom;
    const voiceChannel = state.state.voiceChannel;

    // Voice rows
    let vh = '';
    for (const ch of voices) {
      const mine = voiceOn && voiceRoom === room && voiceChannel === ch.id;
      let count = 0;
      if (state.voicePeers) {
        for (const [, vp] of state.voicePeers) {
          if (vp.room === room && vp.channel === ch.id) count++;
        }
      }
      if (mine) count++;
      const right = mine
        ? '<span class="chan-live">LIVE</span>'
        : (count > 0 ? '<span class="chan-count">' + count + '</span>' : '<span class="chan-count"></span>');
      vh += '<div class="chan-row' + (mine ? ' active' : '') + '" data-kind="voice" data-id="' + _esc(ch.id) + '">'
          + '<span class="chan-mark" aria-hidden="true"><svg viewBox="0 0 24 24" class="ic"><path d="M6 9v6M10 6v12M14 9v6M18 11v2"/></svg></span>'
          + '<span class="chan-name">' + _esc(ch.name) + '</span>'
          + right
          + '</div>';
    }
    vl.innerHTML = vh;

    // Text rows
    let th = '';
    for (const ch of texts) {
      const act = activeText === ch.id;
      const unread = (!act && ch.unread > 0);
      const right = unread ? '<span class="chan-unread">' + (ch.unread > 99 ? '99+' : ch.unread) + '</span>' : '<span class="chan-count"></span>';
      th += '<div class="chan-row' + (act ? ' active' : '') + (unread ? ' unread' : '') + '" data-kind="text" data-id="' + _esc(ch.id) + '">'
          + '<span class="chan-mark">#</span>'
          + '<span class="chan-name">' + _esc(ch.name) + '</span>'
          + right
          + '</div>';
    }
    tl.innerHTML = th;

    document.querySelectorAll('#vchan-list .chan-row, #tchan-list .chan-row').forEach(row => {
      const kind = row.dataset.kind;
      const id   = row.dataset.id;
      row.addEventListener('click', () => {
        if (kind === 'voice') voice.joinVoiceChannel(id);
        else switchTextChannel(id);
      });
      row.addEventListener('dblclick', e => {
        e.preventDefault();
        beginRenameChannel(row, id);
      });
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (id === 'default') return;
        const targetRoom = state.state.activeRoom;
        const ch = getChannelRec(targetRoom, id);
        if (!ch) return;
        toasts.showToast({
          type: 'action',
          title: 'DELETE CHANNEL',
          body: 'Remove <b>' + _esc(ch.name) + '</b> permanently?',
          actions: [
            { label: 'Cancel', onClick: close => close() },
            { label: 'Delete', primary: true, onClick: async close => {
                close();
                try {
                  const r = await window.sirr.deleteChannel(targetRoom, id);
                  if (!r || !r.ok) return;
                } catch (e2) { return; }
                const rd = state.roomData.get(targetRoom);
                if (rd?.channels) rd.channels.delete(id);
                if (targetRoom === state.state.activeRoom && state.state.activeTextChannel === id) {
                  switchTextChannel('default');
                }
                if (state.state.voiceOn && state.state.voiceRoom === targetRoom && state.state.voiceChannel === id) {
                  voice.leaveVoice();
                }
                if (targetRoom === state.state.activeRoom) renderChannels();
                try { $('#in-msg')?.focus(); } catch (e3) {}
              } },
          ],
        });
      });
    });
  }

  export function beginRenameChannel(row, chId) {
    const room = state.state.activeRoom;
    if (!room) return;
    const rd = state.roomData.get(room);
    const ch = rd?.channels?.get(chId); if (!ch) return;
    const nameEl = row.querySelector('.chan-name'); if (!nameEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chan-name-input';
    input.value = ch.name;
    input.maxLength = 30;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      const span = document.createElement('span');
      span.className = 'chan-name';
      span.textContent = v || ch.name;
      input.replaceWith(span);
      if (v && v !== ch.name) {
        ch.name = v;
        try { window.sirr.renameChannel(room, chId, v); } catch (e) {}
        renderChannels();
        if (chId === state.state.activeTextChannel) {
          const tb = $('#tb-room'); if (tb) tb.textContent = v;
        }
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        const s = document.createElement('span');
        s.className = 'chan-name';
        s.textContent = ch.name;
        input.replaceWith(s);
      }
    });
  }

  export function beginAddChannel(kind) {
    const room = state.state.activeRoom;
    if (!room) return;
    const btn = kind === 'voice' ? $('#btn-add-vchan') : $('#btn-add-tchan');
    if (!btn || btn.dataset.editing === '1') return;
    btn.dataset.editing = '1';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chan-add-input';
    input.placeholder = kind === 'voice' ? 'new voice channel' : 'new text channel';
    input.maxLength = 30;
    input.spellcheck = false;
    btn.style.display = 'none';
    btn.parentNode.insertBefore(input, btn.nextSibling);
    input.focus();
    let done = false;
    const cleanup = () => {
      input.remove();
      btn.style.display = '';
      btn.dataset.editing = '';
    };
    const commit = async () => {
      if (done) return;
      done = true;
      const v = input.value.trim().slice(0, 30);
      cleanup();
      if (!v || !state.state.activeRoom) return;
      try {
        const r = await window.sirr.createChannel(state.state.activeRoom, kind, v);
        if (r && r.ok && r.channel) {
          absorbChannels(state.state.activeRoom, [r.channel]);
          renderChannels();
        }
      } catch (e) {}
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; cleanup(); }
    });
  }

  // ─── Rail ─────────────────────────────────────────────────────────
  export function toggleRail() {
    const next = state.state.railMode === 'rooms' ? 'dms' : 'rooms';
    state.state.railMode = next;
    renderRail();
  }

  // Reorder roomData by rebuilding the Map. Map preserves insertion order.
  export function reorderRooms(srcCode, dstCode) {
    if (!state.roomData.has(srcCode) || !state.roomData.has(dstCode)) return;
    const order = [...state.roomData.keys()];
    const si = order.indexOf(srcCode);
    order.splice(si, 1);
    const di = order.indexOf(dstCode);
    order.splice(di, 0, srcCode);
    const rebuilt = new Map();
    for (const code of order) rebuilt.set(code, state.roomData.get(code));
    state.roomData.clear();
    for (const [k, v] of rebuilt) state.roomData.set(k, v);
    renderRail();
    try { window.sirr.reorderRooms([...state.roomData.keys()]); } catch (e) {}
  }

  export function renderRail() {
    const el = $('#room-rail');
    if (!el) return;
    const railMode = state.state.railMode;
    const activeRoom = state.state.activeRoom;
    const voiceRoom = state.state.voiceRoom;

    let h = '';
    let idx = 0;
    for (const [code, rd] of state.roomData) {
      const isDm = !!rd.isDm;
      if (railMode === 'rooms' && isDm) continue;
      if (railMode === 'dms' && !isDm) continue;
      idx++;
      const act = code === activeRoom, hasVc = voiceRoom === code;
      h += `<div class="room rail-room ${act ? 'act' : ''} ${isDm ? 'is-dm' : ''} ${rd.request ? 'is-req' : ''} ${rd.moved ? 'is-moved' : ''}" draggable="${isDm ? 'false' : 'true'}" data-code="${_esc(code)}" title="${_esc(isDm ? ('DM · ' + (rd.dmPeer?.nickname || rd.name || code)) : (rd.name || code) + (rd.moved ? ' · moved (archive)' : ''))}">`
        + `<div class="n">${rd.request ? 'REQ' : isDm ? '@' : String(idx).padStart(2, '0')}</div>`
        // No letters: a room is its sigil (drawn by its name; no rim, since
        // anything derived from the code would publish bits of the secret).
        // A DM is the counterpart's sigil, sealed with their fingerprint.
        + (isDm
            ? `<div class="g">${glyphs.sigilSvg(rd.dmPeer?.nickname || rd.name || code, rd.dmPeer?.fingerprint || '')}</div>`
            : `<div class="g">${glyphs.sigilSvg(rd.name && rd.name !== code ? rd.name : code.slice(3, 8), '')}</div>`)
        + (rd.unread > 0 ? '<div class="dot"></div>' : '')
        + (hasVc ? '<div class="vc-dot"></div>' : '')
        + '</div>';
    }
    el.innerHTML = h;

    el.querySelectorAll('.rail-room').forEach(r => {
      r.addEventListener('click', () => switchRoom(r.dataset.code));
      r.addEventListener('contextmenu', e => {
        e.preventDefault();
        const code = r.dataset.code;
        const rd = state.roomData.get(code);
        toasts.showToast({
          type: 'action',
          title: 'LEAVE ' + (rd?.isDm ? 'DM' : 'ROOM'),
          body: 'Leave <b>' + _esc(rd?.name || code) + '</b>?',
          actions: [
            { label: 'Cancel', onClick: close => close() },
            { label: 'Leave', primary: true, onClick: close => { close(); removeRoom(code); } },
          ],
        });
      });
      r.addEventListener('dragstart', e => {
        if (r.getAttribute('draggable') !== 'true') return;
        e.dataTransfer.setData('text/x-sirr-room', r.dataset.code);
        e.dataTransfer.effectAllowed = 'move';
        r.classList.add('dragging');
      });
      r.addEventListener('dragend', () => r.classList.remove('dragging'));
      r.addEventListener('dragover', e => {
        const src = e.dataTransfer.types.includes('text/x-sirr-room');
        if (!src) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        r.classList.add('drop-target');
      });
      r.addEventListener('dragleave', () => r.classList.remove('drop-target'));
      r.addEventListener('drop', e => {
        e.preventDefault();
        r.classList.remove('drop-target');
        const src = e.dataTransfer.getData('text/x-sirr-room');
        const dst = r.dataset.code;
        if (!src || !dst || src === dst) return;
        reorderRooms(src, dst);
      });
    });

    updateGlobalUnread();
  }

  export function updateGlobalUnread() {
    const dot = document.getElementById('global-unread-dot');
    if (!dot) return;
    const railMode = state.state.railMode;
    let hasHiddenUnreads = false;
    for (const [, rd] of state.roomData) {
      const isDm = !!rd.isDm;
      const isHidden = (railMode === 'rooms' ? isDm : !isDm);
      if (isHidden && rd.unread > 0) { hasHiddenUnreads = true; break; }
    }
    dot.classList.toggle('hidden', !hasHiddenUnreads);
  }

  export function stepRoom(dir) {
    const codes = [...state.roomData.keys()];
    if (!codes.length) return;
    const i = codes.indexOf(state.state.activeRoom);
    const next = i < 0 ? 0 : (i + dir + codes.length) % codes.length;
    switchRoom(codes[next]);
  }

  // ─── Quick switcher (Ctrl+K) ──────────────────────────────────────
  let qsItems = [];
  let qsActive = 0;

  export function openQuickSwitcher() {
    $('#qswitch-ov')?.classList.remove('hidden');
    const input = $('#qswitch-input');
    if (input) input.value = '';
    buildQuickSwitcherList('');
    setTimeout(() => input?.focus(), 30);
  }
  export function closeQuickSwitcher() { $('#qswitch-ov')?.classList.add('hidden'); }

  export function buildQuickSwitcherList(q) {
    const query = (q || '').toLowerCase().trim();
    const items = [];
    for (const [code, rd] of state.roomData) {
      items.push({
        kind: rd.isDm ? 'DM' : 'ROOM',
        label: rd.isDm ? ('@' + (rd.dmPeer?.nickname || rd.name || code)) : (rd.name || code),
        sub: code,
        action: () => { switchRoom(code); closeQuickSwitcher(); },
      });
      if (rd.channels) {
        for (const ch of rd.channels.values()) {
          if (ch.id === 'default') continue;
          items.push({
            kind: ch.kind === 'voice' ? 'VC' : 'CH',
            label: (rd.name || code) + ' / ' + ch.name,
            sub: code,
            action: () => { switchRoom(code); if (ch.kind === 'text') switchTextChannel(ch.id); closeQuickSwitcher(); },
          });
        }
      }
    }
    if (state.contacts) {
      for (const c of state.contacts.values()) {
        items.push({
          kind: 'CONTACT',
          label: c.nickname || c.fingerprint.slice(0, 8),
          sub: c.fingerprint.slice(0, 9),
          action: () => { peers.doOpenDm(c.fingerprint, c.nickname); closeQuickSwitcher(); },
        });
      }
    }
    qsItems = query
      ? items.filter(it => (it.label + ' ' + it.sub).toLowerCase().includes(query))
      : items;
    qsActive = 0;
    renderQuickSwitcher();
  }
  export function renderQuickSwitcher() {
    const el = $('#qswitch-list');
    if (!el) return;
    el.innerHTML = qsItems.length
      ? qsItems.map((it, i) =>
          '<div class="qswitch-item' + (i === qsActive ? ' active' : '') + '" data-i="' + i + '">'
          + '<span class="qs-name">' + _esc(it.label) + '</span>'
          + '<span class="qs-kind">' + _esc(it.kind) + '</span>'
          + '</div>').join('')
      : '<div class="pins-empty">No matches</div>';
  }
  export function moveQuickSwitcher(dir) {
    if (!qsItems.length) return;
    qsActive = (qsActive + dir + qsItems.length) % qsItems.length;
    renderQuickSwitcher();
  }
  export function acceptQuickSwitcher() {
    const it = qsItems[qsActive];
    if (it) it.action();
  }

  // ─── Init: wire DOM listeners that aren't already in app.js ───────
  export function init() {
    // Brand/logo click toggles rail (CSP-safe — no inline onclick).
    document.getElementById('brand-rail-toggle')?.addEventListener('click', toggleRail);
    // Quick-switcher events
    $('#qswitch-ov .ov-bg')?.addEventListener('click', closeQuickSwitcher);
    $('#qswitch-input')?.addEventListener('input', e => buildQuickSwitcherList(e.target.value));
    $('#qswitch-input')?.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown')      { e.preventDefault(); moveQuickSwitcher(1); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); moveQuickSwitcher(-1); }
      else if (e.key === 'Enter')     { e.preventDefault(); acceptQuickSwitcher(); }
    });
    $('#qswitch-list')?.addEventListener('click', e => {
      const row = e.target.closest('.qswitch-item');
      if (!row) return;
      const it = qsItems[+row.dataset.i];
      if (it) it.action();
    });
  }


