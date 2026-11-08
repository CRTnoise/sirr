/**
 * Chat — message stream + composer.
 *
 * Owns the middle-pane chat surface:
 *   - Message rendering (renderMsg, renderMessages, sysMsg)
 *   - Mentions (@autocomplete dropdown + in-bubble pill rendering)
 *   - Pins panel + per-bubble pin/unpin
 *   - Send / reply bar / typing indicator / reactions
 *   - Markdown-ish text formatting (fmtTxt) with mention/code/link guards
 *   - File transfer progress bar (begin/update/end/cancel)
 *   - Opt-in link preview cards
 *
 * Wiring: app.js calls `setDeps({...})` once on boot. Mutable state mirrors
 * (replyTarget, lastRendered, currentViewSrc, emojiTarget) live in this
 * module; app.js reads them via the getters/setters exposed on SirrChat.
 *
 * Plain <script>; load before app.js.
 */

import * as state from './state.js';
import * as glyphs from './glyphs.js';
import { mountFigure } from './figure.js';
import * as peers from './peers.js';
import * as toasts from './toasts.js';
import * as admin from './admin-panel.js';
import * as rooms from './rooms.js';


  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
 
  function _fmtSize(b) {
    if (!b) return '0B';
    return b < 1024 ? b + 'B' : b < 1048576 ? (b / 1024).toFixed(1) + 'KB' : (b / 1048576).toFixed(1) + 'MB';
  }


  // ─── Local state mirrors (exposed via getters/setters) ─────────────
  let replyTarget = null;
  let lastRendered = null;
  let currentViewSrc = '';
  let emojiTarget = null;
  let typingTimer = null;
  function copyText(t) {
    try { window.sirr.copyText(t); } catch (e) {}
    try { navigator.clipboard.writeText(t); } catch (e) {}
  }
  function downloadUrl(u, fn) {
    const a = document.createElement('a');
    a.href = u; a.download = fn;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  // ─── Time/format helper ────────────────────────────────────────────
  export function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', hour12: state.state.timeFormat !== '24',
    });
  }

  // ─── Mentions ──────────────────────────────────────────────────────
  let mentionMatches = [];
  let mentionActive = 0;
  let mentionSlice = null;

  export function currentMentionSlice() {
    const inp = $('#in-msg');
    if (!inp) return null;
    const val = inp.value;
    const caret = inp.selectionStart ?? val.length;
    for (let i = caret - 1; i >= 0; i--) {
      const char = val[i];
      if (char === '\n') break;
      if (char === '@') {
        if (i === 0 || /\s/.test(val[i - 1])) {
          return { start: i, end: caret, frag: val.slice(i + 1, caret) };
        }
        break;
      }
    }
    return null;
  }
  export function updateMentionDD() {
    const slice = currentMentionSlice();
    if (!slice) { hideMentionDD(); return; }
    const q = slice.frag.toLowerCase();
    const cand = [];
    const room = state.state.activeRoom;
    const ledger = state.roomLedger?.get(room);
    if (ledger) {
      for (const [fp, data] of ledger) {
        const contact = state.contacts?.get(fp);
        if (!contact) continue;
        const nick = contact.nickname || data.nickname || '';
        if (!nick) continue;
        if (!q || nick.toLowerCase().startsWith(q)) {
          cand.push({
            nickname: nick,
            fingerprint: fp,
            avatarEmoji: contact.avatarEmoji || data.avatarEmoji || '',
          });
        }
      }
    } else {
      const live = state.roomPeers?.get(room) || [];
      for (const pid of live) {
        const p = state.peers?.get(pid);
        if (!p || !p.fingerprint) continue;
        const contact = state.contacts?.get(p.fingerprint);
        if (!contact) continue;
        const nick = contact.nickname || p.nickname || '';
        if (!nick) continue;
        if (!q || nick.toLowerCase().startsWith(q)) {
          cand.push({
            nickname: nick,
            fingerprint: p.fingerprint,
            avatarEmoji: contact.avatarEmoji || p.avatarEmoji || '',
          });
        }
      }
    }
    mentionMatches = cand.slice(0, 8);
    if (!mentionMatches.length) { hideMentionDD(); return; }
    mentionActive = 0;
    mentionSlice = slice;
    renderMentionDD();
  }
  export function renderMentionDD() {
    const dd = $('#mention-dd'); if (!dd) return;
    dd.innerHTML = mentionMatches.map((m, i) => {
      const mono = m.avatarEmoji || (m.nickname || '?').slice(0, 2).toUpperCase();
      return '<div class="mention-it' + (i === mentionActive ? ' active' : '') + '" data-i="' + i + '">'
        + '<span class="mi-mono">' + _esc(mono) + '</span>'
        + '<span>' + _esc(m.nickname) + '</span>'
        + '<span class="mi-fp">' + _esc((m.fingerprint || '').slice(0, 8)) + '</span>'
        + '</div>';
    }).join('');
    const inp = $('#in-msg');
    if (inp) {
      const r = inp.getBoundingClientRect();
      dd.style.left = r.left + 'px';
      dd.style.bottom = (window.innerHeight - r.top + 6) + 'px';
      dd.style.top = 'auto';
    }
    dd.classList.remove('hidden');
  }
  export function moveMentionDD(dir) {
    if (!mentionMatches.length) return;
    mentionActive = (mentionActive + dir + mentionMatches.length) % mentionMatches.length;
    renderMentionDD();
  }
  export function acceptMention() {
    if (!mentionSlice || !mentionMatches.length) { hideMentionDD(); return; }
    const pick = mentionMatches[mentionActive];
    if (!pick) { hideMentionDD(); return; }
    const inp = $('#in-msg');
    const v = inp.value;
    const before = v.slice(0, mentionSlice.start);
    const after  = v.slice(mentionSlice.end);
    const insertion = '@' + pick.nickname + ' ';
    inp.value = before + insertion + after;
    const caret = before.length + insertion.length;
    inp.setSelectionRange(caret, caret);
    hideMentionDD();
  }
  export function hideMentionDD() {
    mentionMatches = []; mentionSlice = null;
    const dd = $('#mention-dd'); if (dd) dd.classList.add('hidden');
  }

  export function knownNicknameSet() {
    const s = new Set();
    const me = state.state.myNickname;
    if (me) s.add(me.toLowerCase());
    if (state.peers)    for (const p of state.peers.values())    if (p.nickname) s.add(p.nickname.toLowerCase());
    if (state.contacts) for (const c of state.contacts.values()) if (c.nickname) s.add(c.nickname.toLowerCase());
    return s;
  }

  export function renderMentionsInText(text) {
    const known = knownNicknameSet();
    let mentionsMe = false;
    const esc0 = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
    const out = esc0(text).replace(/@([A-Za-z0-9._-]{1,20})/g, (m, nick) => {
      const lowerNick = nick.toLowerCase();
      if (!known.has(lowerNick)) return m;
      const isMe = lowerNick === (state.state.myNickname || '').toLowerCase();
      if (isMe) mentionsMe = true;
      return `<span class="mention">@${nick}</span>`;
    });
    return { html: out, mentionsMe };
  }

  // ─── Pins ─────────────────────────────────────────────────────────
  export function pinKey(room, channel) { return (room || '') + ':' + (channel || 'default'); }
  export function getPinnedSet(room, channel) {
    let m = state.pinnedMessages.get(pinKey(room, channel));
    if (!m) { m = new Map(); state.pinnedMessages.set(pinKey(room, channel), m); }
    return m;
  }
  export function pinCountForActive() {
    const room = state.state.activeRoom;
    if (!room) return 0;
    return getPinnedSet(room, state.state.activeTextChannel).size;
  }
  export function updatePinsCountBadge() {
    const el = $('#pins-count');
    if (el) el.textContent = String(pinCountForActive());
  }
  export function previewOf(msg) {
    if (!msg) return '';
    if (msg.type === 'image')  return '[image]';
    if (msg.type === 'file')   return '[file: ' + (msg.fileName || 'file') + ']';
    if (msg.type === 'invite') return '[invite]';
    return String(msg.content || '').slice(0, 160);
  }
  export function findMsgInActiveChannel(msgId) {
    const room = state.state.activeRoom;
    if (!room || !msgId) return null;
    const rd = state.roomData.get(room);
    if (!rd || !rd.channels) return null;
    const ch = rd.channels.get(state.state.activeTextChannel);
    if (!ch) return null;
    return ch.messages.find(m => m.msgId === msgId) || null;
  }
  export async function togglePinFor(msg) {
    const room = state.state.activeRoom;
    if (!msg || !msg.msgId || !room) return;
    const ch = msg.channel || state.state.activeTextChannel;
    const set = getPinnedSet(room, ch);
    const nowPinned = !set.has(msg.msgId);
    if (nowPinned) {
      set.set(msg.msgId, { preview: previewOf(msg), nick: msg.nickname || '', ts: msg.timestamp || Date.now() });
    } else {
      set.delete(msg.msgId);
    }
    try {
      await window.sirr.togglePin(room, ch, msg.msgId,
        nowPinned, previewOf(msg), msg.nickname || state.state.myNickname, msg.timestamp || Date.now());
    } catch (e) {}
    const el = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(msg.msgId) + '"]');
    if (el) el.classList.toggle('pinned', nowPinned);
    const pinBtn = el ? el.querySelector('.tx-act[data-a="pin"]') : null;
    if (pinBtn) {
      pinBtn.textContent = nowPinned ? '◆' : '◇';
      pinBtn.title = nowPinned ? 'Unpin' : 'Pin';
    }
    updatePinsCountBadge();
    renderPinsPanel();
    toasts.showToast({
      type: nowPinned ? 'success' : 'info',
      title: nowPinned ? 'PINNED' : 'UNPINNED',
      body: _esc(previewOf(msg).slice(0, 80) || '(message)'),
      ttl: 3000,
    });
  }
  export async function deleteMessageForMe(msg) {
    const room = state.state.activeRoom;
    if (!msg || !msg.msgId || !room) return false;
    const chId = msg.channel || state.state.activeTextChannel;
    let ok = false;
    try {
      const res = await window.sirr.deleteMessage(room, chId, msg.msgId);
      ok = !!(res && res.ok);
    } catch (e) {}
    if (!ok) {
      toasts.showToast({ type: 'warn', title: 'DELETE FAILED', body: 'Message could not be removed.', ttl: 2800 });
      return false;
    }
    if (msg.msgId && state.fileBlobs && state.fileBlobs.has(msg.msgId)) {
      try { URL.revokeObjectURL(state.fileBlobs.get(msg.msgId)); } catch (e) {}
      state.fileBlobs.delete(msg.msgId);
    }
    state.reactions.delete(msg.msgId);
    const set = getPinnedSet(room, chId);
    if (set.has(msg.msgId)) {
      set.delete(msg.msgId);
      updatePinsCountBadge();
      renderPinsPanel();
    }
    const rd = state.roomData.get(room);
    const ch = rd?.channels?.get(chId);
    if (ch) {
      ch.messages = ch.messages.filter(m => m.msgId !== msg.msgId);
      if (chId === state.state.activeTextChannel) renderMessages(ch.messages);
    }
    return true;
  }

  // ─── Edit (author-only) ──────────────────────────────────────────
  // ─── Edited-marker helpers ──────────────────────────────────────────
  // The "edited" label is a .msg-edited-row div, sibling to .txt inside
  // .body, right-aligned via CSS. Keeping it out of .txt means the text
  // content stays clean and the marker is independently updatable.
  function setEditedMarker(bubbleEl, editedAt) {
    const body = bubbleEl.querySelector('.body');
    if (!body) return;
    let row = body.querySelector('.msg-edited-row');
    if (!row) {
      row = document.createElement('div');
      row.className = 'msg-edited-row';
      const reactions = body.querySelector('.msg-reactions');
      reactions ? body.insertBefore(row, reactions) : body.appendChild(row);
    }
    row.textContent = 'edited';
    row.title = 'Edited ' + fmtTime(editedAt);
  }
  function removeEditedMarker(bubbleEl) {
    bubbleEl.querySelector('.msg-edited-row')?.remove();
  }

  // beginEditMessage — OPTIMISTIC UPDATE pattern:
  // Swaps textarea out synchronously on Enter/blur BEFORE the IPC call.
  // UI is instant. Background save reverts on failure.
  export function beginEditMessage(msg, bubbleEl) {
    if (!msg || msg.type !== 'text' || !bubbleEl) return;
    const txtEl = bubbleEl.querySelector('.txt');
    if (!txtEl || txtEl.dataset.editing === '1') return;
    txtEl.dataset.editing = '1';

    const original = msg.content || '';
    const room = state.state.activeRoom;
    const chId = msg.channel || state.state.activeTextChannel;

    const input = document.createElement('textarea');
    input.className = 'tx-edit-input';
    input.value = original;
    input.rows = Math.min(6, Math.max(1, original.split('\n').length));
    input.style.cssText = 'width:100%;min-height:1.6em;background:transparent;border:1px solid var(--accent);border-radius:0;padding:4px 6px;color:inherit;font:inherit;resize:vertical;box-sizing:border-box';
    txtEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let committed = false;

    const restoreWith = (html) => {
      if (!input.isConnected) return;
      const div = document.createElement('div');
      div.className = 'txt';
      div.innerHTML = html;
      input.replaceWith(div);
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      restoreWith(fmtTxt(original));
      if (msg.editedAt) setEditedMarker(bubbleEl, msg.editedAt);
    };

    const commit = () => {
      if (committed) return;
      committed = true;

      const next = input.value;
      if (!next.trim() || next === original) { cancel(); return; }

      // Optimistic: swap textarea out immediately — no IPC wait.
      const now = Date.now();
      restoreWith(fmtTxt(next));
      setEditedMarker(bubbleEl, now);

      // Update in-memory channel buffer right away.
      const rd = state.roomData.get(room);
      const ch = rd?.channels?.get(chId);
      const m  = ch?.messages?.find(x => x.msgId === msg.msgId);
      if (m) { m.content = next; m.editedAt = now; }

      // Background IPC — revert on failure.
      window.sirr.editMessage(room, chId, msg.msgId, next)
        .then(r => {
          if (!r || !r.ok) {
            toasts.showToast({ type: 'warn', title: 'EDIT FAILED', body: r?.error || 'unknown', ttl: 3000 });
            const bubble = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(msg.msgId) + '"]');
            if (bubble) {
              const t = bubble.querySelector('.txt');
              if (t) t.innerHTML = fmtTxt(original);
              if (msg.editedAt) setEditedMarker(bubble, msg.editedAt);
              else removeEditedMarker(bubble);
            }
            if (m) { m.content = original; m.editedAt = msg.editedAt || 0; }
            return;
          }
          const at = r.editedAt || now;
          if (m) m.editedAt = at;
          const bubble = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(msg.msgId) + '"]');
          if (bubble) setEditedMarker(bubble, at);
        })
        .catch(() => {
          toasts.showToast({ type: 'warn', title: 'EDIT FAILED', body: 'Could not save edit.', ttl: 3000 });
        });
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commit(); }
      else if (e.key === 'Escape')          { e.preventDefault(); e.stopPropagation(); cancel(); }
    });
    // Commit on blur — 100 ms delay so an Escape keydown fires above first.
    input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected) commit(); }, 100));
  }

    // Apply an incoming edit (from peer or from our own broadcast echo).
  // Mutates the in-memory channel buffer so the next switchTextChannel
  // reflects the change, and patches the rendered bubble in place if it's
  // currently visible. No-op if the message isn't in our buffer.
  export function applyMessageEdit(i) {
    if (!i || !i.room || !i.msgId) return;
    const rd = state.roomData.get(i.room);
    const ch = rd?.channels?.get(i.channel || 'default');
    if (!ch) return;
    const m = ch.messages.find(x => x.msgId === i.msgId);
    if (!m) return;
    m.content = i.content;
    m.editedAt = i.editedAt || Date.now();
    // Patch the live DOM if the bubble is rendered.
    if (i.room === state.state.activeRoom && (i.channel || 'default') === state.state.activeTextChannel) {
      const bubble = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(i.msgId) + '"]');
      if (bubble) {
        const txtEl = bubble.querySelector('.txt');
        if (txtEl) txtEl.innerHTML = fmtTxt(m.content || '');
        setEditedMarker(bubble, m.editedAt);
      }
    }
  }

  // ─── Delete-for-everyone ─────────────────────────────────────────
  // Owner / room admin / original author can delete a message for all
  // peers. Confirmation matches the local-delete confirmation style.
  export async function deleteForEveryone(msg) {
    if (!msg || !msg.msgId) return;
    const room = state.state.activeRoom;
    if (!room) return;
    toasts.showToast({
      type: 'action',
      title: 'DELETE FOR EVERYONE',
      body: 'This will remove the message for every peer in the room. Continue?',
      actions: [
        { label: 'Cancel', onClick: c => c() },
        { label: 'Delete', primary: true, onClick: async c => {
            c();
            try {
              const r = await window.sirr.deleteForAll(
                room, msg.channel || state.state.activeTextChannel, msg.msgId,
              );
              if (!r || !r.ok) {
                toasts.showToast({ type: 'warn', title: 'DELETE FAILED', body: r?.error || 'unknown', ttl: 3000 });
                return;
              }
              applyMessageDeleteForAll({
                room, channel: msg.channel || state.state.activeTextChannel, msgId: msg.msgId,
              });
            } catch (e) {}
          } },
      ],
    });
  }

  // Apply an incoming delete-for-all (peer or own echo). Drops the message
  // from the in-memory buffer and removes the rendered bubble.
  export function applyMessageDeleteForAll(i) {
    if (!i || !i.room || !i.msgId) return;
    const rd = state.roomData.get(i.room);
    const ch = rd?.channels?.get(i.channel || 'default');
    if (ch) ch.messages = ch.messages.filter(m => m.msgId !== i.msgId);
    state.reactions.delete(i.msgId);
    const set = getPinnedSet(i.room, i.channel || 'default');
    if (set.has(i.msgId)) {
      set.delete(i.msgId);
      updatePinsCountBadge();
      renderPinsPanel();
    }
    if (i.room === state.state.activeRoom && (i.channel || 'default') === state.state.activeTextChannel) {
      const bubble = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(i.msgId) + '"]');
      if (bubble) bubble.remove();
    }
  }

  // Disappearing messages: main swept these rows past their TTL. Same removal
  // as delete-for-all, but with a brief dissolve so the user sees the message
  // vanish rather than blink out — the ephemerality made visible.
  export function applyMessagesExpired(list) {
    if (!Array.isArray(list) || !list.length) return;
    for (const i of list) {
      if (!i || !i.room || !i.msgId) continue;
      const rd = state.roomData.get(i.room);
      const ch = rd?.channels?.get(i.channel || 'default');
      if (ch) ch.messages = ch.messages.filter(m => m.msgId !== i.msgId);
      state.reactions.delete(i.msgId);
      const set = getPinnedSet(i.room, i.channel || 'default');
      if (set.has(i.msgId)) { set.delete(i.msgId); updatePinsCountBadge(); renderPinsPanel(); }
      if (i.room === state.state.activeRoom && (i.channel || 'default') === state.state.activeTextChannel) {
        const bubble = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(i.msgId) + '"]');
        if (bubble) {
          const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (reduce) { bubble.remove(); }
          else {
            bubble.classList.add('msg-dissolve');
            setTimeout(() => { try { bubble.remove(); } catch (e) {} }, 600);
          }
        }
      }
    }
  }

  export async function loadPinsForActive() {
    const room = state.state.activeRoom;
    if (!room) return;
    try {
      const rd = state.roomData.get(room);
      if (!rd || !rd.channels) return;
      for (const chId of rd.channels.keys()) {
        const pins = await window.sirr.getPins(room, chId);
        const set = getPinnedSet(room, chId);
        set.clear();
        for (const [msgId, rec] of Object.entries(pins || {})) {
          set.set(msgId, { preview: rec.preview || '', nick: rec.nick || '', ts: rec.ts || 0 });
        }
      }
    } catch (e) {}
    updatePinsCountBadge();
  }
  export function openPinsPanel() {
    renderPinsPanel();
    $('#pins-ov')?.classList.remove('hidden');
  }
  export function closePinsPanel() { $('#pins-ov')?.classList.add('hidden'); }
  export function renderPinsPanel() {
    const lbl = $('#pins-channel-lbl');
    const list = $('#pins-list');
    if (!lbl || !list) return;
    const room = state.state.activeRoom;
    const rd = room ? state.roomData.get(room) : null;
    const chRec = rd && rd.channels ? rd.channels.get(state.state.activeTextChannel) : null;
    lbl.textContent = chRec ? chRec.name : 'default';
    if (!room) { list.innerHTML = '<div class="pins-empty">No room selected</div>'; return; }
    const set = getPinnedSet(room, state.state.activeTextChannel);
    if (!set.size) { list.innerHTML = '<div class="pins-empty">No pinned messages in this channel.</div>'; return; }
    const entries = [...set.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    list.innerHTML = entries.map(([msgId, rec]) =>
      '<div class="pin-row" data-msgid="' + _esc(msgId) + '" data-act="jump" title="Click to jump">'
      + '<div class="pr-body"><span class="pr-nick">' + _esc(rec.nick || '?') + '</span>'
      + fmtTxt(rec.preview || '(no preview)') + '</div>'
      + '<button class="pr-unpin" data-act="unpin" title="Unpin">×</button>'
      + '</div>').join('');
  }

  // ─── Send / Reply ─────────────────────────────────────────────────
  const IRC_LOCAL = new Set(['nick', 'join', 'who', 'names', 'whois', 'away', 'back', 'topic', 'rekey', 'evict']);
  function ircCommand(cmd, arg, room) {
    const api = window.sirr;
    const roster = () => [...(state.roomPeers.get(room) || [])].map(pid => state.peers.get(pid)).filter(Boolean);
    switch (cmd) {
      case 'nick': {
        const nick = arg.slice(0, 20);
        if (!nick) { sysMsg('usage: /nick <name>'); return; }
        state.state.myNickname = nick;
        try { api.updateConfig({ nickname: nick }); } catch (e) {}
        const sb = $('#sb-nick'); if (sb) sb.textContent = nick;
        sysMsg('you are now known as ' + nick);
        return;
      }
      case 'join':
        if (!arg) { sysMsg('usage: /join <room code or invite link>'); return; }
        window.dispatchEvent(new CustomEvent('sirr:join-code', { detail: { code: arg } }));
        return;
      case 'who': case 'names': {
        const ps = roster();
        sysMsg(ps.length ? 'here: ' + ps.map(p => p.nickname + (p.status === 'away' ? ' (away)' : '')).join(', ') : 'nobody else is online in this room');
        return;
      }
      case 'whois': {
        const p = roster().find(x => (x.nickname || '').toLowerCase() === arg.toLowerCase());
        sysMsg(p ? p.nickname + ' · ' + (p.fingerprint || '?') + (p.forwardSecret ? ' · forward-secret' : '') + (p.statusText ? ' · "' + p.statusText + '"' : '')
                 : 'no one called ' + (arg || '?') + ' is online here');
        return;
      }
      case 'away':
        try { api.setIdleStatus('away'); if (arg) api.updateConfig({ statusText: arg.slice(0, 80) }); } catch (e) {}
        sysMsg('you are marked as away' + (arg ? ': ' + arg : ''));
        return;
      case 'back':
        try { api.setIdleStatus('active'); } catch (e) {}
        sysMsg('welcome back');
        return;
      case 'rekey': case 'evict': {
        // Owner only. Everyone online (minus the evicted) moves to a fresh
        // code; whoever comes back later gets the move from whoever's online.
        const known = new Map();
        for (const p of roster()) if (p.fingerprint) known.set(p.fingerprint, p.nickname || '');
        for (const [fp, r] of (state.roomRoster.get(room) || new Map())) known.set(fp, r.nickname || known.get(fp) || '');
        const evict = [], miss = [];
        if (cmd === 'evict') {
          const names = arg.split(/[\s,]+/).filter(Boolean);
          if (!names.length) { sysMsg('usage: /evict <nick or fingerprint> [more…] — moves everyone else to a new code'); return; }
          for (const n of names) {
            const hex = n.replace(/\s/g, '').toUpperCase();
            const hit = [...known].find(([fp, nk]) => fp.replace(/\s/g, '') === hex || nk.toLowerCase() === n.toLowerCase());
            if (hit) evict.push(hit[0]); else miss.push(n);
          }
          if (miss.length) { sysMsg('not in this room: ' + miss.join(', ')); return; }
          if (evict.includes(state.state.myFingerprint)) { sysMsg('you cannot evict yourself'); return; }
        }
        api.moveRoom(room, evict).then(r => {
          if (!r || !r.ok) { sysMsg((r && r.error) || 'move failed'); return; }
          window.dispatchEvent(new CustomEvent('sirr:room-moved', { detail: { from: room, to: r.to, name: r.name, evicted: evict.length, mine: true } }));
        });
        sysMsg(cmd === 'rekey' ? 'moving everyone to a fresh code…' : 'moving everyone except ' + evict.map(f => known.get(f) || f).join(', ') + ' to a fresh code…');
        return;
      }
      case 'topic':
        if (!arg) { sysMsg('usage: /topic <new room name>'); return; }
        try {
          api.renameRoom(room, arg.slice(0, 64)).then(r => {
            if (r && r.ok) { const rd = state.roomData.get(room); if (rd) rd.name = arg.slice(0, 64); sysMsg('room renamed to ' + arg.slice(0, 64)); }
            else sysMsg('you are not allowed to rename this room');
          });
        } catch (e) {}
        return;
    }
  }

  export async function doSend() {
    const room = state.state.activeRoom;
    const inEl = $('#in-msg');
    if (!inEl) return;
    let txt = inEl.value.trim();
    if (!txt || !room) return;
    // A moved room is an archive: its code may be held by someone evicted.
    if (state.roomData.get(room)?.moved && !/^\/(clear|help|who|names|whois)\b/i.test(txt)) {
      sysMsg('this room moved to a new code — it is read-only now. Open the new one in the rail.');
      return;
    }

    // ─ Slash commands ────────────────────────────────────────────────
    // Commands run before the network send. A command can either short-
    // circuit (return without sending) or rewrite `txt` and fall through.
    if (txt.startsWith('/')) {
      const sp  = txt.indexOf(' ');
      const cmd = (sp === -1 ? txt : txt.slice(0, sp)).slice(1).toLowerCase();
      const arg = sp === -1 ? '' : txt.slice(sp + 1);
      if (cmd === 'clear') {
        // Local-only: wipe the rendered chat + the in-memory channel buffer
        // for the active channel. On-disk history is untouched (use the
        // settings overlay's "clear history" if you want that too).
        clearChat();
        const rd = state.roomData.get(room);
        const ch = rd?.channels?.get(state.state.activeTextChannel);
        if (ch) ch.messages = [];
        inEl.value = '';
        $('#btn-send')?.classList.remove('on');
        return;
      }
      if (cmd === 'me') {
        // IRC-style action — send as a styled italic line.
        if (!arg.trim()) { inEl.value = ''; $('#btn-send')?.classList.remove('on'); return; }
        txt = '*' + state.state.myNickname + ' ' + arg.trim() + '*';
      } else if (cmd === 'shrug') {
        txt = (arg ? arg + ' ' : '') + '¯\\_(ツ)_/¯';
      } else if (cmd === 'help') {
        // Local-only system message listing the commands.
        sysMsg('/me <action> · /nick <name> · /join <code> · /who · /whois <nick> · /away [text] · /back · /topic <name> · /rekey · /evict <nick> · /clear · /shrug');
        inEl.value = '';
        $('#btn-send')?.classList.remove('on');
        return;
      } else if (IRC_LOCAL.has(cmd)) {
        // IRC habits, done the Sirr way. None of these send a message.
        inEl.value = '';
        $('#btn-send')?.classList.remove('on');
        ircCommand(cmd, arg.trim(), room);
        return;
      }
      // Unknown commands fall through and get sent as-is — preserves typing
      // a literal "/path/to/file" without losing the leading slash.
    }

    inEl.value = '';
    $('#btn-send')?.classList.remove('on');
    const extra = { channel: state.state.activeTextChannel };
    if (replyTarget) extra.replyTo = replyTarget;
    cancelReply();
    try {
      const r = await window.sirr.sendMessage(room, txt, 'text', extra);
      pushMsg(room, { ...r.message, channel: state.state.activeTextChannel, fingerprint: state.state.myFingerprint });
    } catch (e) {}
  }
  export function setReply(id, nick, prev) {
    replyTarget = { msgId: id, nick, preview: (prev || '').slice(0, 80) };
    const rn = $('#reply-nick'); if (rn) rn.textContent = nick;
    const rp = $('#reply-preview'); if (rp) rp.textContent = (prev || '').slice(0, 60);
    $('#reply-bar')?.classList.remove('hidden');
    try { $('#in-msg')?.focus(); } catch (e) {}
  }
  export function cancelReply() {
    replyTarget = null;
    $('#reply-bar')?.classList.add('hidden');
  }

  // ─── Typing / Reactions ───────────────────────────────────────────
  // typingPeers is local — no other module needs it.
  const typingPeers = new Map();
  export function showTyping(pid, nick) {
    if (typingPeers.has(pid)) clearTimeout(typingPeers.get(pid).to);
    typingPeers.set(pid, {
      to: setTimeout(() => { typingPeers.delete(pid); renderTyping(); }, 3000),
      nick,
    });
    renderTyping();
  }
  export function clearTypingFor(pid) {
    const e = typingPeers.get(pid);
    if (e) { clearTimeout(e.to); typingPeers.delete(pid); renderTyping(); }
  }
  export function renderTyping() {
    const n = [];
    for (const [, v] of typingPeers) n.push(v.nick);
    const b = $('#typing-bar'); if (!b) return;
    if (!n.length) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    const w = $('#typing-who');
    if (w) w.textContent = n.length === 1 ? n[0] + ' is typing...' : n.join(' & ') + ' are typing...';
  }

  // Reactions arrive from peers as free-form JSON. Only a short run of
  // real emoji code points is a reaction; anything else (markup, text,
  // control characters) is dropped before it can reach innerHTML.
  const REACTION_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\u20e3){1,16}$/u;
  export function isValidReaction(emoji) {
    return typeof emoji === 'string' && emoji.length <= 32 && REACTION_RE.test(emoji) && !/[<>"'&]/.test(emoji);
  }

  export function addReaction(msgId, emoji, nick) {
    if (typeof msgId !== 'string' || !msgId || msgId.length > 64 || !isValidReaction(emoji)) return;
    if (!state.reactions.has(msgId)) state.reactions.set(msgId, {});
    const r = state.reactions.get(msgId);
    if (!r[emoji]) r[emoji] = new Set();
    if (r[emoji].has(nick)) r[emoji].delete(nick);
    else r[emoji].add(nick);
    if (r[emoji].size === 0) delete r[emoji];
    renderReactions(msgId);
    const me = state.state.myNickname;
    const room = state.state.activeRoom;
    if (nick === me && room) {
      try {
        window.sirr.sendMessage(room, JSON.stringify({ msgId, emoji, nick }), 'reaction', {});
      } catch (e) {}
    }
  }
  export function renderReactions(msgId) {
    const el = document.querySelector('[data-msgid="' + CSS.escape(String(msgId)) + '"] .msg-reactions');
    if (!el) return;
    const r = state.reactions.get(msgId);
    if (!r || Object.keys(r).length === 0) { el.innerHTML = ''; return; }
    let h = '';
    const me = state.state.myNickname;
    for (const [emoji, users] of Object.entries(r)) {
      if (users.size === 0) continue;
      if (!isValidReaction(emoji)) continue;
      h += '<span class="msg-react' + (users.has(me) ? ' mine' : '') + '" data-emoji="' + _esc(emoji) + '" data-msgid="' + _esc(msgId) + '">'
         + _esc(emoji) + '<span class="msg-react-count">' + users.size + '</span></span>';
    }
    el.innerHTML = h;
    el.querySelectorAll('.msg-react').forEach(btn => {
      btn.addEventListener('click', () => addReaction(btn.dataset.msgid, btn.dataset.emoji, state.state.myNickname));
    });
  }

  // ─── Messages ─────────────────────────────────────────────────────
  export function pushMsg(room, msg) {
    if (!state.roomData.has(room)) return;

    if (msg.type === 'reaction') {
      try { const rd = JSON.parse(msg.content); addReaction(rd.msgId, rd.emoji, msg.nickname || rd.nick); } catch (e) {}
      return;
    }

    const chId = msg.channel || 'default';
    if (msg.peerId) peers.addPeerToRoom(room, msg.peerId);
    const rd = state.roomData.get(room);
    rooms.ensureChannelsMap(room);
    const ch = rd.channels.get(chId) || rd.channels.get('default');

    if (msg.msgId && ch.messages.some(m => m.msgId === msg.msgId)) return;

    const mentionsMe = !msg.self && msg.type === 'text' && typeof msg.content === 'string'
      && renderMentionsInText(msg.content).mentionsMe;

    if (mentionsMe && !msg.sync && state.state.mentionToasts !== 'off') {
      const activeRoom = state.state.activeRoom;
      const activeText = state.state.activeTextChannel;
      toasts.showToast({
        type: 'info',
        title: 'MENTION',
        body: '<b>' + _esc(msg.nickname || '?') + '</b> mentioned you' + (room !== activeRoom || chId !== activeText
          ? ' in <b>' + _esc(rd.name || room) + (chId !== 'default' ? ' / ' + _esc((rd.channels.get(chId)?.name) || chId) : '') + '</b>'
          : '.'),
        ttl: 4500,
      });
    }

    ch.messages.push(msg);
    ch.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const activeRoom = state.state.activeRoom;
    const activeText = state.state.activeTextChannel;
    const isActive = (room === activeRoom && ch.id === activeText);

    if (isActive) {
      const container = $('#messages');
      if (!container) return;
      const isAtBottom = (container.scrollHeight - container.scrollTop) <= (container.clientHeight + 50);
      const prevScrollTop = container.scrollTop;
      const prevHeight = container.scrollHeight;
      if (msg.sync) {
        renderMessages(ch.messages);
        container.scrollTop = prevScrollTop + (container.scrollHeight - prevHeight);
      } else {
        renderMsg(msg, lastRendered !== msg.nickname);
        lastRendered = msg.nickname;
        if (isAtBottom || msg.self) scrollBottom();
      }
    } else {
      ch.unread++;
      if (room !== activeRoom) rd.unread++;
      if (room === activeRoom) rooms.renderChannels();
      rooms.renderRail();
      rooms.updateGlobalUnread();
    }
  }

  export function renderMsg(msg, showHead) {
    const msgsEl = $('#messages');
    if (!msgsEl) return;
    if (emptyFigure || msgsEl.firstElementChild?.classList.contains('ch-empty')) dropEmpty();
    if (msg.msgId && msgsEl.querySelector('[data-msgid="' + CSS.escape(String(msg.msgId)) + '"]')) return;
    const el = document.createElement('div');
    const mentionsMe = !msg.self && msg.type === 'text' && typeof msg.content === 'string'
      ? renderMentionsInText(msg.content).mentionsMe
      : false;
    const room = state.state.activeRoom;
    const isPinned = msg.msgId && getPinnedSet(room, msg.channel || state.state.activeTextChannel).has(msg.msgId);
    el.className = 'tx' + (msg.self ? ' self' : '') + (showHead ? '' : ' cont')
      + (mentionsMe ? ' mentions-me' : '') + (isPinned ? ' pinned' : '');
    el.dataset.msgid = msg.msgId || '';
    if (msg.fingerprint) el.dataset.fp = msg.fingerprint;
    const self = msg.self, t = fmtTime(msg.timestamp);
    const hash4 = msg.msgId ? msg.msgId.slice(-4).toLowerCase() : '';
    const fpShort = (msg.fingerprint || '').slice(0, 9);
    // Avatar column (v7): own image/emoji if we set one, otherwise every
    // author is drawn as the identicon of their fingerprint.
    const avCell = showHead
      ? '<div class="av">' + (self
          ? glyphs.avatarHtml(msg.nickname, state.state.avatarEmoji, state.state.avatarImage, msg.fingerprint || state.state.myFingerprint)
          : glyphs.identiconHtml(msg.fingerprint || msg.nickname || '?', '', msg.nickname)) + '</div>'
      : '<div class="av"></div>';

    const stamp = '<div class="stamp">'
                + '<div class="t" title="' + _esc(new Date(msg.timestamp).toLocaleString()) + '">'
                + new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: state.state.timeFormat !== '24' })
                + '</div>'
                // IRC layout shows only HH:MM, always 24-hour, like a log.
                + '<div class="ts">' + new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) + '</div>'
                + (hash4 ? '<div class="h">#' + hash4 + '</div>' : '')
                + '</div>';

    let reply = '';
    if (msg.replyTo) {
      const rHash = msg.replyTo.msgId ? ' #' + String(msg.replyTo.msgId).slice(-4).toLowerCase() : '';
      reply = '<div class="mreply"><div class="mreply-bar"></div><div class="mreply-body">'
            + '<span class="mreply-nick">' + _esc(msg.replyTo.nick || '') + _esc(rHash) + '</span>'
            + '<span class="mreply-text">' + _esc(msg.replyTo.preview || '') + '</span></div></div>';
    }

    let body;
    // Image content comes from the sender. Only an inline raster data URL
    // (or our own blob:) is an image; anything else could break out of the
    // src attribute. Escaped regardless.
    const IMG_OK = /^(data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+|blob:[^"'<>\s]+)$/;
    if (msg.type === 'image' && typeof msg.content === 'string' && msg.content.length > 10 && IMG_OK.test(msg.content.slice(0, 64)) && !/["'<>]/.test(msg.content)) {
      body = '<div class="msg-img-wrap"><img class="msg-img" src="' + _esc(msg.content) + '" loading="lazy"><button class="msg-img-dl">⬇</button></div>';
    } else if (msg.type === 'file') {
      // After a restart only the content survives: derive the BOLT ref from it.
      if (!msg.fileRef && typeof msg.content === 'string' && /^bolt:[0-9a-f]{16}$/.test(msg.content)) msg.fileRef = msg.content.slice(5);
      const exp = !msg.fileRef && (!msg.content || msg.content.length < 10);
      body = '<div class="attach msg-file' + (exp ? ' expired' : '') + '">'
           + '<div class="ic">' + glyphs.ICON.file + '</div>'
           + '<div><div class="fn">' + _esc(msg.fileName || 'file') + '</div>'
           + '<div class="sz">' + _fmtSize(msg.fileSize) + (exp ? ' · expired' : '') + (msg.verified ? ' · ✓ verified' : '') + '</div></div>'
           + '<span class="sz">' + (self ? 'sent' : 'received') + '</span>'
           + '<span class="dl">' + (exp ? '—' : 'SAVE →') + '</span>'
           + '</div>';
    } else if (msg.type === 'invite') {
      let inv = { code: '', name: '' };
      try { inv = JSON.parse(msg.content || '{}'); } catch {}
      const already = state.roomData.has(inv.code);
      body = '<div class="msg-invite" data-inv-code="' + _esc(inv.code) + '" data-inv-name="' + _esc(inv.name || inv.code) + '">'
           + '<div class="msg-invite-title">&#x25C8; Room invite</div>'
           + '<div class="msg-invite-body">' + (self ? 'You invited them to ' : 'Join ') + '<b>' + _esc(inv.name || inv.code) + '</b></div>'
           + '<div class="msg-invite-link"><code>' + _esc(inv.code) + '</code></div>'
           + '<div class="msg-invite-actions">'
           + '<button class="msg-invite-btn primary" data-inv-act="join"' + (self || already ? ' disabled' : '') + '>' + (already ? 'Already in' : 'Join') + '</button>'
           + '<button class="msg-invite-btn" data-inv-act="copy-link">Copy link</button>'
           + '<button class="msg-invite-btn" data-inv-act="dismiss">Dismiss</button>'
           + '</div>'
           + '</div>';
    } else if (msg.type === 'system') {
      const sys = document.createElement('div');
      sys.className = 'day-ruler sys-ruler';
      sys.innerHTML = '<span></span><b>' + _esc(msg.content) + '</b><span></span>';
      msgsEl.appendChild(sys);
      return;
    } else {
      const editedRow = msg.editedAt
        ? '<div class="msg-edited-row" title="Edited ' + fmtTime(msg.editedAt) + '">edited</div>'
        : '';
      body = '<div class="txt">' + fmtTxt(msg.content || '') + '</div>' + editedRow;
    }

    // Per-message action toolbar. The Edit button only shows for our own
    // text messages. The "Delete for everyone" button (🗑) shows when the
    // viewer is the author or has moderation rights in the room — the
    // local-only × stays available to everyone.
    const myFp = state.state.myFingerprint;
    const isAuthor = msg.self || (msg.fingerprint && msg.fingerprint === myFp);
    const adm = state.roomAdminState && state.roomAdminState.get(state.state.activeRoom);
    const canModerate = !!(adm && (adm.isOwner ||
      (adm.admins && adm.admins[myFp] && Object.values(adm.admins[myFp]).some(v => v === true))));
    const showEdit = isAuthor && msg.type === 'text';
    const showDelAll = isAuthor || canModerate;
    const editBtn = showEdit
      ? '<button class="tx-act" data-a="edit" title="Edit" aria-label="Edit">' + glyphs.ICON.edit + '</button>' : '';
    const delAllBtn = showDelAll
      ? '<button class="tx-act danger" data-a="delete-all" title="Delete for everyone" aria-label="Delete for everyone">' + glyphs.ICON.trash + '</button>' : '';
    const actions = '<div class="tx-actions" role="toolbar" aria-label="Message actions">'
                  + '<button class="tx-act" data-a="reply"  title="Reply" aria-label="Reply">' + glyphs.ICON.reply + '</button>'
                  + '<button class="tx-act" data-a="react"  title="React" aria-label="React">' + glyphs.ICON.react + '</button>'
                  + '<button class="tx-act' + (isPinned ? ' on' : '') + '" data-a="pin" title="' + (isPinned ? 'Unpin' : 'Pin') + '" aria-label="' + (isPinned ? 'Unpin' : 'Pin') + '">' + (isPinned ? glyphs.ICON.unpin : glyphs.ICON.pin) + '</button>'
                  + '<button class="tx-act" data-a="copy"   title="Copy" aria-label="Copy">' + glyphs.ICON.copy + '</button>'
                  + editBtn
                  + delAllBtn
                  + '<button class="tx-act" data-a="delete" title="Delete locally" aria-label="Delete locally">' + glyphs.ICON.close + '</button>'
                  + '</div>';

    const hdr = showHead
      ? '<div class="hdr">'
      + '<span class="nk">' + _esc(msg.nickname || '?') + '</span>'
      + (fpShort ? '<span class="fp">' + _esc(fpShort) + '</span>' : '')
      + (msg.echo
          ? '<span class="fp' + (msg.verified ? '' : ' relayed') + '" title="Left in the DHT while you were away and found there (Echoes). ' + (msg.verified ? 'Signature checked against this member\'s room key.' : 'You haven\'t met this author directly yet, so the name can\'t be checked.') + '">◌ echo' + (msg.verified ? ' · verified' : ' · unverified') + '</span>'
          : (msg.verified && !msg.self ? '<span class="fp" title="Relayed while you were offline — signature checked against this member\'s room key.">↻ verified</span>' : '')
          + (msg.relayedBy ? '<span class="fp relayed" title="Delivered by ' + _esc(msg.relayedBy.nickname || 'another peer') + ' while you were offline. You haven\'t met this author directly yet, so their room key is unknown and the name above can\'t be checked.">↻ relayed · unverified</span>' : ''))
      // Relayed-and-unverified messages must not claim a good signature.
      + (msg.relayedBy && !msg.verified ? '' : '<span class="verify">sig <b>ok</b></span>')
      + '</div>'
      : '';

    el.innerHTML = actions + stamp + avCell + '<div class="body">' + hdr + reply + body + '<div class="msg-reactions"></div></div>';
    msgsEl.appendChild(el);

    el.querySelectorAll('.tx-act').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const a = btn.dataset.a;
        const text = msg.type === 'text' ? msg.content : (msg.fileName || msg.type);
        if (a === 'reply') setReply(msg.msgId, msg.nickname, text);
        else if (a === 'pin') togglePinFor(msg);
        else if (a === 'copy') copyText(msg.type === 'text' ? msg.content : (msg.fileName || ''));
        else if (a === 'delete') deleteMessageForMe(msg);
        else if (a === 'edit') beginEditMessage(msg, el);
        else if (a === 'delete-all') deleteForEveryone(msg);
        else if (a === 'react') {
          // The emoji-picker click handler lives in app.js and reads
          // `window.__phEmojiTarget`. Mirror our private state to it so the
          // picked emoji actually flows back into addReaction().
          emojiTarget = msg.msgId;
          window.__phEmojiTarget = msg.msgId;
          const rect = btn.getBoundingClientRect();
          const p = $('#emoji-picker');
          if (p) {
            p.style.left = Math.min(rect.left, window.innerWidth - 230) + 'px';
            p.style.top  = Math.max(rect.top - 50, 10) + 'px';
            p.classList.remove('hidden');
          }
        }
      });
    });

    // Jump-to-reply — clicking the reply preview scrolls the chat back to
    // the original message and flashes its background. If we don't have the
    // original locally yet (e.g. came from sync but the user cleared the
    // channel) we surface a small toast.
    const replyEl = el.querySelector('.mreply');
    if (replyEl && msg.replyTo && msg.replyTo.msgId) {
      replyEl.style.cursor = 'pointer';
      replyEl.title = 'Jump to original message';
      replyEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const targetId = msg.replyTo.msgId;
        const target = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(targetId) + '"]');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1400);
        } else {
          toasts.showToast({
            type: 'info', title: 'NOT IN VIEW',
            body: 'Original message isn\'t loaded in this channel yet.', ttl: 2500,
          });
        }
      });
    }

    const img = el.querySelector('.msg-img');
    if (img) img.addEventListener('click', () => {
      currentViewSrc = img.src;
      const iv = $('#img-view-src'); if (iv) iv.src = img.src;
      $('#img-view')?.classList.remove('hidden');
    });
    const dlBtn = el.querySelector('.msg-img-dl');
    if (dlBtn && msg.content) dlBtn.addEventListener('click', e => {
      e.stopPropagation(); downloadUrl(msg.content, msg.fileName || 'image.jpg');
    });
    const fc = el.querySelector('.msg-file:not(.expired)');
    if (fc && msg.fileRef && window.sirr?.fileSave) {
      // BOLT: the file is on disk in main — save a copy where the user wants.
      fc.addEventListener('click', async () => {
        const r = await window.sirr.fileSave(msg.fileRef);
        if (r && r.ok) toasts.showToast({ type: 'info', title: 'SAVED', body: _esc(msg.fileName || 'file'), ttl: 2500 });
        else if (r && !r.canceled) toasts.showToast({ type: 'warn', title: 'NOT AVAILABLE', body: _esc((r && r.error) || 'File not found'), ttl: 5000 });
      });
    } else if (fc && msg.content && msg.content.length > 10 && !msg.content.startsWith('bolt:')) {
      fc.addEventListener('click', () => downloadUrl(msg.content, msg.fileName || 'download'));
    }
    const inv = el.querySelector('.msg-invite');
    if (inv) {
      inv.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('.msg-invite-btn');
        if (!btn) return;
        ev.stopPropagation();
        const act = btn.dataset.invAct;
        const code = inv.dataset.invCode, name = inv.dataset.invName;
        if (act === 'dismiss') { inv.classList.add('accepted'); return; }
        if (act === 'copy-link') {
          try {
            const url = await window.sirr.buildInviteUrl(code);
            copyText(url);
            const old = btn.textContent;
            btn.textContent = 'Copied ✓';
            setTimeout(() => { btn.textContent = old; }, 1400);
          } catch (e) {}
          return;
        }
        if (act === 'join' && code && !btn.disabled) {
          const ok = await rooms.addRoom(code, name);
          if (ok) {
            inv.classList.add('accepted');
            btn.textContent = 'Joined';
            rooms.renderRail();
            rooms.switchRoom(code);
            toasts.showToast({ type: 'success', title: 'ROOM JOINED', body: 'Now in <b>' + _esc(name) + '</b>', ttl: 2500 });
          } else {
            toasts.showToast({ type: 'warn', title: 'JOIN FAILED', body: 'Could not join <b>' + _esc(name) + '</b>', ttl: 3500 });
          }
        }
      });
    }
    if (msg.msgId && state.reactions.has(msg.msgId)) renderReactions(msg.msgId);
    maybeRenderLinkPreview(el, msg);
  }

  export function sysMsg(txt, room) {
    const target = room || state.state.activeRoom;
    if (!target) return;
    pushMsg(target, {
      type: 'system',
      content: txt,
      timestamp: Date.now(),
      self: false,
    });
  }

  // ─── Link preview ──────────────────────────────────────────────────
  const linkPreviewCache = new Map();
  const LINK_URL_RE = /https?:\/\/[^\s<>"']+/i;
  export function extractFirstUrl(text) {
    if (typeof text !== 'string') return '';
    const m = text.match(LINK_URL_RE);
    return m ? m[0].replace(/[)\].,!?]+$/, '') : '';
  }
  export async function maybeRenderLinkPreview(msgEl, msg) {
    if (state.state.linkPreview !== 'on') return;
    if (!msgEl || !msg || !msg.msgId)   return;
    // Only links you sent yourself. Fetching a link someone else posted
    // would let any room member learn your IP address by posting a URL to
    // a server they control.
    if (!msg.self)                      return;
    if (msg.type !== 'text')            return;
    const url = extractFirstUrl(msg.content || '');
    if (!url) return;
    if (msgEl.querySelector('.lp-card')) return;
    let data = linkPreviewCache.get(msg.msgId);
    if (data === undefined) {
      try { data = await window.sirr.fetchLinkPreview(url); }
      catch (e) { data = null; }
      linkPreviewCache.set(msg.msgId, data || null);
    }
    if (!data || (!data.title && !data.description && !data.image)) return;
    if (!msgEl.isConnected) return;
    const card = document.createElement('a');
    card.className = 'lp-card';
    card.href = data.url || url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    const host = _esc(data.siteName || '');
    const title = _esc(data.title || '');
    const desc  = _esc((data.description || '').slice(0, 200));
    card.innerHTML = '<div class="lp-body">'
      + (host ? '<div class="lp-site">' + host + '</div>' : '')
      + (title ? '<div class="lp-title">' + title + '</div>' : '')
      + (desc ? '<div class="lp-desc">' + desc + '</div>' : '')
      + '</div>';
    // Image: main has already validated this as an absolute http(s) URL,
    // but we still never interpolate it into markup — set it through the
    // CSSOM so attribute breakout is structurally impossible.
    if (data.image && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(data.image)) {
      const imgEl = document.createElement('div');
      imgEl.className = 'lp-img';
      imgEl.style.backgroundImage = 'url(' + JSON.stringify(String(data.image)) + ')';
      card.prepend(imgEl);
    }
    const body = msgEl.querySelector('.body');
    if (body) body.appendChild(card);
  }

  // Empty channel: the sirr figure and a line about where you are.
  let emptyFigure = null;
  function dropEmpty() {
    if (emptyFigure) { emptyFigure.destroy(); emptyFigure = null; }
    const e = document.querySelector('#messages > .ch-empty');
    if (e) e.remove();
  }
  function showEmpty() {
    const m = $('#messages');
    if (!m || m.querySelector('.ch-empty')) return;
    const rd = state.roomData.get(state.state.activeRoom);
    const el = document.createElement('div');
    el.className = 'ch-empty';
    const host = document.createElement('div');
    host.className = 'figure-host';
    el.appendChild(host);
    const h = document.createElement('h3');
    h.textContent = 'No transmissions yet';
    const p = document.createElement('p');
    p.textContent = rd && rd.isDm
      ? 'Only the two of you hold this conversation. Messages travel directly between your devices, encrypted end to end.'
      : 'Everyone holding this room\'s code is a member. Messages travel directly between members, encrypted end to end — no server keeps a copy.';
    el.append(h, p);
    m.appendChild(el);
    emptyFigure = mountFigure(host, 'token');
  }

  /**
   * Someone changed their name or picture: every row they wrote updates in
   * place, and so do the copies in memory (so switching channels doesn't
   * bring the old name back). Their past messages stay theirs.
   */
  export function refreshAuthor(fp, info) {
    if (!fp) return;
    for (const [, rd] of state.roomData) {
      if (!rd.channels) continue;
      for (const [, ch] of rd.channels) for (const m of ch.messages || []) {
        if (m.fingerprint !== fp) continue;
        if (info.nickname) m.nickname = info.nickname;
      }
    }
    const sel = '.tx[data-fp="' + (window.CSS && CSS.escape ? CSS.escape(fp) : fp) + '"]';
    document.querySelectorAll(sel).forEach(row => {
      const nk = row.querySelector('.hdr .nk');
      if (nk && info.nickname) nk.textContent = info.nickname;
      const av = row.querySelector('.av');
      if (av && !row.classList.contains('self')) av.innerHTML = glyphs.avatarHtml(info.nickname || '', info.avatarEmoji || '', '', fp, info.avatarPixels);
    });
  }

  export function clearChat() { dropEmpty(); const m = $('#messages'); if (m) m.innerHTML = ''; lastRendered = null; }
  export function scrollBottom() { const m = $('#messages'); if (m) m.scrollTop = m.scrollHeight; }
  export function renderMessages(list) {
    clearChat();
    if (!Array.isArray(list) || !list.length) { showEmpty(); return; }
    let lastNick = null;
    for (const m of list) {
      renderMsg(m, lastNick !== m.nickname);
      lastNick = m.nickname;
    }
    lastRendered = lastNick;
  }

  // Markdown-ish formatting with link / mention / code-fence guards
  export function fmtTxt(t) {
    // placeholders are wrapped in U+0000 (stripped from input first)
    // and substituted in ONE final pass. Before, bare tokens like "IC0" or
    // "URL3" in ordinary text were rewritten, and later passes rescanned
    // HTML already inserted (a link ending in /IC0 got a <code> inside
    // its href).
    const raw = String(t || '').replace(/[\u0000-\u0008]/g, '');
    let s = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const tok = [];
    const put = (html) => { tok.push(html); return '\u0000' + (tok.length - 1) + '\u0000'; };

    s = s.replace(/```([\s\S]*?)```/g, (_, code) => put('<pre class="md-block"><code>' + code + '</code></pre>'));
    s = s.replace(/`([^`\n]+)`/g, (_, code) => put('<code class="md-inline">' + code + '</code>'));

    // sirr:// invite links → JOIN button. The decoded code is checked
    // against the room-code alphabet: %22 etc. used to decode straight
    // into the data-code attribute (markup injection).
    s = s.replace(/sirr:\/\/join\/([A-Za-z0-9%_\-]{1,60})/g, (whole, path) => {
      let code = '';
      try { code = decodeURIComponent(path).toUpperCase().replace(/[.,;:!?)]+$/, '').slice(0, 48); } catch (e) { return whole; }
      if (!/^[A-Z0-9-]{4,48}$/.test(code)) return whole;
      return put('<button class="ph-link-btn" data-code="' + code + '" title="Click to join room ' + code + '">&#x25D1; JOIN ' + code + '</button>');
    });

    s = s.replace(/(https?:\/\/[^\s<>"'\u0000]+)/g, (whole) => {
      let url = whole;
      let trail = '';
      while (url.length && /[.,;:!?)\]}>]/.test(url[url.length - 1])) {
        trail = url[url.length - 1] + trail;
        url = url.slice(0, -1);
      }
      return put('<a href="' + url + '" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: underline;">' + url + '</a>') + trail;
    });

    const known = knownNicknameSet();
    s = s.replace(/@([A-Za-z0-9._-]{1,20})/g, (m, nick) => {
      if (!known.has(nick.toLowerCase())) return m;
      return put('<span class="mention">@' + nick + '</span>');
    });

    s = s.replace(/\*\*([^*\n\u0000]+?)\*\*/g, '<strong class="md-bold">$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n\u0000]+?)\*(?!\*)/g, '$1<em class="md-italic">$2</em>');
    s = s.replace(/(^|[^_])_([^_\n\u0000]+?)_(?!_)/g, '$1<u class="md-underline">$2</u>');

    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => tok[+i] ?? '');
  }

  // ─── File transfer progress ───────────────────────────────────────
  let visibleTransferId = null;
  function _renderTransfer() {
    const fp = $('#file-progress'); if (!fp) return;
    const t = visibleTransferId ? state.activeTransfers.get(visibleTransferId) : null;
    if (!t) { fp.classList.add('hidden'); return; }
    fp.classList.remove('hidden');
    const label = (t.kind === 'send' ? '↑ ' : '↓ ') + t.name;
    const suffix = state.activeTransfers.size > 1 ? ` (+${state.activeTransfers.size - 1})` : '';
    const nm = $('#fprog-name'); if (nm) nm.textContent = label + suffix;
    const pc = $('#fprog-pct');  if (pc) pc.textContent = t.pct + '%' + (t.extra ? ' · ' + t.extra : '');
    const fl = $('#fprog-fill'); if (fl) fl.style.width = t.pct + '%';
  }
  export function beginTransfer(fileId, kind, name, cancel) {
    state.activeTransfers.set(fileId, { kind, name, pct: 0, cancel });
    visibleTransferId = fileId;
    _renderTransfer();
  }
  export function updateTransfer(fileId, pct, extra) {
    const t = state.activeTransfers.get(fileId); if (!t) return;
    if (pct != null) t.pct = pct;
    t.extra = extra || '';
    visibleTransferId = fileId;
    _renderTransfer();
  }
  export function endTransfer(fileId) {
    state.activeTransfers.delete(fileId);
    if (visibleTransferId === fileId) {
      visibleTransferId = state.activeTransfers.size > 0
        ? state.activeTransfers.keys().next().value
        : null;
    }
    _renderTransfer();
  }
  export function cancelVisibleTransfer() {
    if (!visibleTransferId) return;
    const t = state.activeTransfers.get(visibleTransferId);
    const name = (t && t.name) || 'file';
    const kind = (t && t.kind) || 'send';
    if (t && t.cancel) try { t.cancel(); } catch (e) {}
    endTransfer(visibleTransferId);
    // Confirm to the user that the transfer actually stopped and that any
    // partial data was discarded (BOLT deletes the .part file on disk).
    toasts.showToast({
      type: 'info',
      title: kind === 'recv' ? 'DOWNLOAD CANCELLED' : 'UPLOAD CANCELLED',
      body: name + ' — transfer stopped, buffered data discarded.',
      ttl: 3000,
    });
    sysMsg('⚠ ' + name + ' — transfer cancelled');
  }

  // ─── State accessors for app.js mirrors ───────────────────────────
  /*
  function getReplyTarget()       { return replyTarget; }
  function setReplyTarget(v)      { replyTarget = v; }
  function getLastRendered()      { return lastRendered; }
  function setLastRendered(v)     { lastRendered = v; }
  function getCurrentViewSrc()    { return currentViewSrc; }
  function setCurrentViewSrc(v)   { currentViewSrc = v; }
  function getEmojiTarget()       { return emojiTarget; }
  function setEmojiTarget(v)      { emojiTarget = v; }*/

  export function init() {
    // Pins-panel events live here so the click handlers see this module's
    // findMsgInActiveChannel + togglePinFor + getPinnedSet directly.
    $('#btn-pins')?.addEventListener('click', openPinsPanel);
    $('#btn-close-pins')?.addEventListener('click', closePinsPanel);
    $('#pins-ov .ov-bg')?.addEventListener('click', closePinsPanel);
    $('#pins-list')?.addEventListener('click', (e) => {
      const unpinBtn = e.target.closest('.pr-unpin');
      const row = e.target.closest('.pin-row');
      if (!row) return;
      const msgId = row.dataset.msgid;
      if (unpinBtn) {
        e.stopPropagation();
        const room = state.state.activeRoom;
        const channel = state.state.activeTextChannel;
        const msg = findMsgInActiveChannel(msgId)
          || { msgId, channel, nickname: '', timestamp: 0, type: 'text',
               content: getPinnedSet(room, channel).get(msgId)?.preview || '' };
        togglePinFor(msg);
        return;
      }
      closePinsPanel();
      const el = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(msgId) + '"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1400);
      } else {
        toasts.showToast({ type: 'info', title: 'MESSAGE UNAVAILABLE',
          body: 'This pinned message isn\'t in local history yet.', ttl: 2800 });
      }
    });
  }
  