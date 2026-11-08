/**
 * Peers — everything that relates to "other people": the peer drawer, the
 * roster, the hover tooltip, the profile card, contacts/DMs/blocklist, and
 * the invite overlay. Previously scattered across app.js; now behind
 * `window.SirrPeers`.
 *
 * Wiring: app.js calls setDeps({...}) once on boot with:
 *   - Shared collections (Maps/Sets) that this module reads + mutates
 *   - Getter callbacks for mutable app state (activeRoom, myNickname, …)
 *   - Cross-module functions (switchRoom, addRoom, sysMsg, pushMsg, …)
 *
 * Then call SirrPeers.init() once the DOM is ready to wire the three
 * delegated click handlers (#prof-card-ov, #blocklist-mgr, #invite-rooms).
 *
 * This file is a plain <script> — not an ES module. Load before app.js.
 */
import * as state from './state.js';
import * as glyphs from './glyphs.js';
import { mountFigure } from './figure.js';
import * as toasts from './toasts.js';
import * as admin from './admin-panel.js';
import * as rooms from './rooms.js';
import * as chat from './chat.js';
import * as voice from './voice.js';


  // Keeping a local `esc` + a local clipboard shim so we don't need the
  // app.js versions threaded through deps.
  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function copyText(t) {
    try { window.sirr.copyText(t); } catch (e) {}
    try { navigator.clipboard.writeText(t); } catch (e) {}
  }
  

  // ─── Avatars ──────────────────────────────────────────────────────
  export function avD(n, e) { return e || (n || '?')[0].toUpperCase(); }
  // v7: image > emoji > identicon of the fingerprint (glyphs.avatarHtml).
  function avatarHtml(nickname, emoji, image, seed) {
    return glyphs.avatarHtml(nickname, emoji, image, seed || state.state.myFingerprint);
  }
  // Paint every "me" avatar cell with the current image/emoji/initials.
  // Called on boot, on avatar change, and when settings close.
  export function updateMyAvatarCells() {
    const html = avatarHtml(state.state.myNickname, state.state.avatarEmoji, state.state.avatarImage);
    const sb = document.querySelector('#sb-av');
    if (sb) {
      sb.innerHTML = html;
      const img = state.state.avatarImage, emoji = state.state.avatarEmoji;
      sb.style.fontSize = img ? '' : (emoji ? '14px' : '');
      sb.style.padding  = img ? '0' : '';
    }
    // The peers-drawer "me" row reads these fields directly in updatePeers.
    updatePeers();
  }

  // ─── Peer registry (ledger + roster helpers) ──────────────────────
  export function addPeerToRoom(room, pid) {
    if (!room || !pid) return;
    const { roomPeers, peers, roomLedger } = state;
    if (!roomPeers.has(room)) roomPeers.set(room, new Set());
    const s = roomPeers.get(room);
    const had = s.has(pid);
    s.add(pid);
    const p = peers.get(pid);
    if (p && p.fingerprint) {
      if (!roomLedger.has(room)) roomLedger.set(room, new Map());
      roomLedger.get(room).set(p.fingerprint, {
        nickname: p.nickname || '',
        avatarEmoji: p.avatarEmoji || '',
      });
      // Mirror of main-process touchRoster. The main-side persist is the
      // authority on disk; the in-memory update here keeps the drawer snappy
      // without an IPC round-trip.
      touchLocalRoster(room, p.fingerprint, {
        nickname: p.nickname || '',
        avatarEmoji: p.avatarEmoji || '',
      });
    }
    if (!had && room === state.state.activeRoom) updatePeers();
  }
  export function touchLocalRoster(room, fp, info) {
    if (!room || !fp) return;
    const { roomRoster } = state;
    if (!roomRoster.has(room)) roomRoster.set(room, new Map());
    const map = roomRoster.get(room);
    const existing = map.get(fp) || {};
    map.set(fp, {
      fingerprint: fp,
      nickname:    (info && info.nickname)    || existing.nickname    || '',
      avatarEmoji: (info && info.avatarEmoji) || existing.avatarEmoji || '',
      firstSeenAt: existing.firstSeenAt || Date.now(),
      lastSeenAt:  Date.now(),
    });
  }
  export function removePeerFromAll(pid) {
    const { roomPeers, voicePeers, voiceActivity } = state;
    for (const [, s] of roomPeers) s.delete(pid);
    voicePeers.delete(pid);
    voiceActivity.delete(pid);
    updatePeers();
  }
  export function getPeersInRoom(room) {
    const s = state.roomPeers.get(room);
    if (!s) return [];
    return [...s].map(pid => state.peers.get(pid)).filter(Boolean);
  }

  // ─── Peer tooltip (hover) ─────────────────────────────────────────
  let peerTooltipEl = null;
  function ensurePeerTooltip() {
    if (peerTooltipEl) return peerTooltipEl;
    peerTooltipEl = document.createElement('div');
    peerTooltipEl.id = 'peer-tooltip';
    peerTooltipEl.className = 'peer-tooltip hidden';
    document.body.appendChild(peerTooltipEl);
    return peerTooltipEl;
  }
  export function fpFromRow(row) {
    if (!row) return '';
    const key = row.dataset.key || '';
    if (key.startsWith('fp:')) return key.slice(3);
    if (key && state.peers.has(key))  return state.peers.get(key).fingerprint || '';
    if (row.dataset.fp) return row.dataset.fp;
    return '';
  }
  export function showPeerTooltip(row) {
    const fp = fpFromRow(row);
    if (!fp) return;
    const info = resolveProfile(fp);
    const live = [...state.peers.values()].find(p => p.fingerprint === fp);
    const status = live?.status || (info.online ? 'active' : 'offline');
    const statusText = live?.statusText || '';
    const tip = ensurePeerTooltip();
    tip.innerHTML = '<div class="pt-head">'
      + '<span class="pt-dot pt-' + esc(status) + '"></span>'
      + '<b>' + esc(info.nickname || fp.slice(0, 8)) + '</b>'
      + '<span class="pt-mini">' + esc(status.toUpperCase()) + '</span>'
      + '</div>'
      + (statusText ? '<div class="pt-status">' + esc(statusText) + '</div>' : '')
      + '<code class="pt-fp">' + esc(fp.slice(0, 19)) + '</code>';
    const r = row.getBoundingClientRect();
    // Anchor to the LEFT edge of the peers drawer so the tooltip doesn't
    // clip on the right screen edge; fallback to below-the-row when top is off-screen.
    tip.style.left = Math.max(8, r.left - 280) + 'px';
    tip.style.top  = Math.max(8, r.top) + 'px';
    tip.classList.remove('hidden');
  }
  export function hidePeerTooltip() {
    if (peerTooltipEl) peerTooltipEl.classList.add('hidden');
  }

  // (Removed: peer-fp slideshow rotator. The #cs-peer cell it targeted was
  // retired when the bottom status strip pivoted from crypto-identity tags
  // to live transport health.)

  // ─── Peers drawer: diff-based render ──────────────────────────────
  // Two sections: CONNECTED (currently online) and PEERS (roster minus
  // currently connected — "ever seen" ledger). We keep DOM nodes per row
  // key (pid for live peers, 'fp:<fp>' for roster) and patch only rows
  // that changed so heartbeats (every 5s) don't re-trigger fade-in anims.
  let peersFigure = null;
  export function updatePeers() {
    const el = document.querySelector('#peers-list'); if (!el) return;
    const { peers, voicePeers, peerVideos, roomRoster, contacts } = state;
    const activeRoom     = state.state.activeRoom;
    const myNickname     = state.state.myNickname;
    const myFingerprint  = state.state.myFingerprint;
    const myMonoHtml     = avatarHtml(myNickname, state.state.avatarEmoji, state.state.avatarImage, state.state.myFingerprint);
    const voiceOn        = state.state.voiceOn;
    const voiceRoom      = state.state.voiceRoom;
    const meInVc = voiceOn && voiceRoom && voiceRoom === activeRoom;
    const rp = activeRoom ? getPeersInRoom(activeRoom) : [];

    const rows = [];
    // ── Connected header ────────────────────────────────────────────
    rows.push({
      key: '__hdr_connected__',
      cls: 'peer-sec-hd',
      body: '<span class="peer-sec-dot on"></span>'
          + '<span class="peer-sec-lbl">CONNECTED</span>'
          + '<span class="peer-sec-n">' + (rp.length + 1) + '</span>',
    });
    // ── Me ──────────────────────────────────────────────────────────
    const meRoleTag = admin.roleTagHtml(activeRoom, myFingerprint);
    rows.push({
      key: '__me__',
      cls: 'peer me',
      body: '<div class="mon">' + myMonoHtml + '</div>'
          + '<div class="nm">' + esc(myNickname) + meRoleTag + '</div>'
          + (meInVc
             ? '<div class="vc">VC</div>'
             : '<div class="fp">' + esc((myFingerprint || '').slice(0, 9) || 'you') + '</div>'),
    });
    // ── Live peers ──────────────────────────────────────────────────
    const liveFps = new Set();
    if (myFingerprint) liveFps.add(myFingerprint);
    for (const p of rp) {
      const pMonoHtml = glyphs.avatarHtml(p.nickname, p.avatarEmoji, '', p.fingerprint || p.nickname);
      const inVc = voicePeers.has(p.peerId);
      const awayCls = p.status === 'away' ? ' away' : '';
      const vids = peerVideos.get(p.peerId);
      let btns = '';
      if (vids && vids.size) {
        for (const [vkey, v] of vids) {
          const icon = v.kind === 'screen' ? '🖥' : '📷';
          const title = (v.kind === 'screen' ? 'Open screen' : 'Open camera') + ' — ' + (p.nickname || '');
          btns += '<button class="pvbtn" data-vkey="' + esc(vkey) + '" title="' + esc(title) + '">' + icon + '</button>';
        }
      }
      // Contact + DM actions — only for peers whose fingerprint we know.
      let actions = '';
      const fp = p.fingerprint || '';
      if (fp) {
        liveFps.add(fp);
        const known = contacts.has(fp);
        actions += '<div class="pactions">';
        if (!known) {
          actions += '<button class="pabtn primary" data-act="add-contact" data-fp="' + esc(fp) + '" data-nick="' + esc(p.nickname || '') + '" data-emoji="' + esc(p.avatarEmoji || '') + '" title="Add to contacts">+ADD</button>';
        } else {
          actions += '<button class="pabtn ghost" data-act="remove-contact" data-fp="' + esc(fp) + '" title="Remove contact">&#x2713;</button>';
        }
        actions += '<button class="pabtn" data-act="open-dm" data-fp="' + esc(fp) + '" data-nick="' + esc(p.nickname || '') + '" title="Open direct message">DM</button>';
        actions += '</div>';
      }
      const right = inVc
        ? '<div class="vc">VC</div>'
        : '<div class="fp">' + esc((p.fingerprint || '').slice(0, 9)) + '</div>';
      const rt = admin.roleTagHtml(activeRoom, p.fingerprint);
      rows.push({
        key: p.peerId,
        cls: 'peer' + awayCls,
        body: '<div class="mon">' + pMonoHtml + '</div>'
            + '<div class="nm">' + esc(p.nickname) + rt + '</div>'
            + '<div class="r">' + actions + btns + right + '</div>',
      });
    }

    // ── Roster (ever-seen minus currently-connected) ────────────────
    const rosterMap = activeRoom ? (roomRoster.get(activeRoom) || new Map()) : new Map();
    const rosterEntries = [];
    for (const [fp, rec] of rosterMap) {
      if (liveFps.has(fp)) continue;  // they're in the CONNECTED section
      rosterEntries.push(rec);
    }
    rosterEntries.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));

    if (rosterEntries.length) {
      rows.push({
        key: '__hdr_roster__',
        cls: 'peer-sec-hd roster-hd',
        body: '<span class="peer-sec-dot"></span>'
            + '<span class="peer-sec-lbl">PEERS</span>'
            + '<span class="peer-sec-n">' + rosterEntries.length + '</span>',
      });
      for (const rec of rosterEntries) {
        const fp = rec.fingerprint;
        const mono = rec.avatarEmoji || (rec.nickname || '?').slice(0, 2).toUpperCase();
        const known = contacts.has(fp);
        let actions = '<div class="pactions">';
        if (!known) {
          actions += '<button class="pabtn primary" data-act="add-contact" data-fp="' + esc(fp) + '" data-nick="' + esc(rec.nickname || '') + '" data-emoji="' + esc(rec.avatarEmoji || '') + '" title="Add to contacts">+ADD</button>';
        } else {
          actions += '<button class="pabtn ghost" data-act="remove-contact" data-fp="' + esc(fp) + '" title="Remove contact">&#x2713;</button>';
        }
        actions += '<button class="pabtn" data-act="open-dm" data-fp="' + esc(fp) + '" data-nick="' + esc(rec.nickname || '') + '" title="Open direct message">DM</button>';
        actions += '</div>';
        const rt = admin.roleTagHtml(activeRoom, fp);
        rows.push({
          key: 'fp:' + fp,
          cls: 'peer offline',
          body: '<div class="mon">' + glyphs.avatarHtml(rec.nickname, rec.avatarEmoji, '', fp) + '</div>'
              + '<div class="nm">' + esc(rec.nickname || fp.slice(0, 8)) + rt + '</div>'
              + '<div class="r">' + actions + '<div class="fp">' + esc((fp || '').slice(0, 9)) + '</div></div>',
        });
      }
    }

    const want = new Set(rows.map(r => r.key));
    for (const node of [...el.children]) {
      if (!want.has(node.dataset.key)) node.remove();
    }
    // Upsert + reorder via appendChild — moves existing nodes to the end.
    for (const r of rows) {
      let node = el.querySelector('[data-key="' + CSS.escape(r.key) + '"]');
      if (!node) {
        node = document.createElement('div');
        node.dataset.key = r.key;
        node.className = r.cls + ' just-added';
        node.innerHTML = r.body;
        el.appendChild(node);
        setTimeout(() => node.classList.remove('just-added'), 300);
      } else {
        const hadAnim = node.classList.contains('just-added');
        const targetCls = r.cls + (hadAnim ? ' just-added' : '');
        if (node.className !== targetCls) node.className = targetCls;
        if (node.innerHTML !== r.body) node.innerHTML = r.body;
        el.appendChild(node);
      }
    }

    // Nobody else online: the mesh figure, and what will happen.
    let empty = document.querySelector('#peers-empty');
    if (!rp.length && activeRoom) {
      if (!empty) {
        empty = document.createElement('div');
        empty.id = 'peers-empty';
        empty.className = 'peers-empty';
        empty.innerHTML = '<div class="figure-host"></div><p>No one else is online in this room. When someone joins with the code, their device connects straight to yours.</p>';
        el.after(empty);
        peersFigure = mountFigure(empty.querySelector('.figure-host'), 'mesh');
      }
    } else if (empty) {
      if (peersFigure) { peersFigure.destroy(); peersFigure = null; }
      empty.remove();
    }

    const pc = document.querySelector('#peer-count');
    if (pc) pc.textContent = rp.length;

    // Voice count indicator
    const vc = document.querySelector('#voice-count');
    if (vc) {
      const vcPeersHere = rp.filter(p => voicePeers.has(p.peerId)).length;
      const total = rp.length + 1;  // +1 for self
      const active = vcPeersHere + (voiceOn && voiceRoom === activeRoom ? 1 : 0);
      vc.textContent = (voiceOn && voiceRoom === activeRoom) ? (active + '/' + total) : '—';
    }

    // "Who's in voice" presence refresh lives outside this module.
    voice.renderVoicePresence();
  }

  // Drive the bottom-of-chat status strip with live transport health.
  // s.rtt = { samples, best, worst, avg } from network.getStats(); we map
  // best-RTT into a 4-bar quality tier for the chip class.
  //   ≤ 50ms  → q4 (excellent)   < 100ms → q3 (good)
  //   < 200ms → q2 (fair)        ≥ 200ms → q1 (poor)
  //   no samples / no peers → q-none (SEARCHING)
  export async function updateStats() {
    try {
      const s = await window.sirr.getStats();
      const $ = sel => document.querySelector(sel);
      const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
      set('#cs-peers',    s.peers);
      set('#cs-rooms',    s.rooms);
      set('#cs-sessions', s.sessions);
      // The mark's two halves meet while at least one peer holds a session
      // with us: the shared secret, drawn.
      document.documentElement.classList.toggle('net-live', (s.sessions || s.peers || 0) > 0);

      const cell = $('#cs-quality');
      const route = $('#cs-route');
      const avg   = $('#cs-avgrtt');
      const best = s.rtt && typeof s.rtt.best === 'number' ? s.rtt.best : null;
      const avgN = s.rtt && typeof s.rtt.avg  === 'number' ? s.rtt.avg  : null;

      if (cell) cell.classList.remove('q-none', 'q1', 'q2', 'q3', 'q4');
      if (s.peers === 0 || best === null) {
        if (route) route.textContent = 'SEARCHING';
        if (avg)   avg.textContent   = '—';
        if (cell)  cell.classList.add('q-none');
      } else {
        let tier = 'q1';
        if (best <= 50)        tier = 'q4';
        else if (best < 100)   tier = 'q3';
        else if (best < 200)   tier = 'q2';
        if (route) route.textContent = 'P2P · ' + best + 'MS';
        if (avg)   avg.textContent   = (avgN === null ? '—' : avgN + 'ms');
        if (cell)  cell.classList.add(tier);
      }

      // Legacy ids — preserved if anything else still reads them.
      const p = $('#st-p'), sess = $('#st-s');
      if (p) p.textContent = s.peers;
      if (sess) sess.textContent = s.sessions;
    } catch (e) {}
  }

  // ─── Contacts ─────────────────────────────────────────────────────
  export async function loadContacts() {
    try {
      const map = await window.sirr.getContacts();
      state.contacts.clear();
      for (const [fp, rec] of Object.entries(map || {})) { state.contacts.set(fp, rec); if (rec?.avatarPixels) glyphs.setPixels(fp, rec.avatarPixels); }
    } catch (e) {}
    renderContacts();
    updatePeers();
  }
  export function renderContacts() {
    const el = document.querySelector('#contacts-list'); if (!el) return;
    const all = [...state.contacts.values()].sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    const connectedFps = new Set();
    for (const p of state.peers.values()) if (p.fingerprint) connectedFps.add(p.fingerprint);
    const rows = all.map(c => {
      const mono = c.avatarEmoji || (c.nickname || '?').slice(0, 2).toUpperCase();
      const online = connectedFps.has(c.fingerprint);
      return '<div class="peer" data-fp="' + esc(c.fingerprint) + '">'
        + '<div class="mon">' + glyphs.avatarHtml(c.nickname, c.avatarEmoji, '', c.fingerprint) + '</div>'
        + '<div class="nm">' + esc(c.nickname || c.fingerprint.slice(0, 8)) + '</div>'
        + '<div class="r">'
        +   '<div class="pactions">'
        +     '<button class="pabtn primary" data-act="c-dm"     data-fp="' + esc(c.fingerprint) + '" data-nick="' + esc(c.nickname || '') + '">DM</button>'
        +     '<button class="pabtn"         data-act="c-invite" data-fp="' + esc(c.fingerprint) + '" data-nick="' + esc(c.nickname || '') + '">INV</button>'
        +     '<button class="pabtn ghost"   data-act="c-remove" data-fp="' + esc(c.fingerprint) + '" title="Remove">&#x2715;</button>'
        +   '</div>'
        +   (online ? '<div class="vc">ON</div>' : '<div class="fp">' + esc((c.fingerprint || '').slice(0, 9)) + '</div>')
        + '</div>'
        + '</div>';
    }).join('');
    el.innerHTML = rows || '<div class="peer" style="opacity:.55"><div class="nm">No contacts yet</div></div>';
    const cc = document.querySelector('#contact-count'); if (cc) cc.textContent = all.length;
  }
  export async function doAddContact(fp, nickname, avatarEmoji) {
    if (!fp) return;
    const r = await window.sirr.addContact(fp, nickname, avatarEmoji);
    if (r && r.ok && r.contact) {
      state.contacts.set(fp, r.contact);
      renderContacts();
      updatePeers();
      toasts.showToast({ type: 'success', title: 'CONTACT ADDED', body: esc(nickname || fp.slice(0, 8)) + ' is now in your contacts.', ttl: 3500 });
    }
  }
  export async function doRemoveContact(fp) {
    const r = await window.sirr.removeContact(fp);
    if (r && r.ok) {
      state.contacts.delete(fp);
      renderContacts();
      updatePeers();
    }
  }
  export async function doOpenDm(fp, nickname, opts) {
    if (!fp) return null;
    const silent = !!(opts && opts.silent);
    const r = await window.sirr.openDm(fp, nickname);
    if (!r || !r.ok || !r.room) return null;
    const room = r.room;
    if (!state.roomData.has(room.code)) {
      await rooms.addRoom(room.code, room.name, { isDm: true, dmPeer: room.dmPeer });
    }
    const rd = state.roomData.get(room.code);
    if (rd) {
      rd.isDm = true;
      rd.dmPeer = room.dmPeer;
      if (r.channels) rooms.absorbChannels(room.code, r.channels);
      const chMap = rooms.ensureChannelsMap(room.code);
      const ch = chMap && chMap.get('default');
      if (ch && !ch.messages.length && Array.isArray(r.history) && r.history.length) {
        ch.messages = r.history.filter(m => m.type !== 'reaction').map(m => ({ ...m, channel: 'default' }));
      }
    }
    rooms.renderRail();
    if (!silent) rooms.switchRoom(room.code);
    return room.code;
  }

  // ─── Invite overlay ───────────────────────────────────────────────
  let inviteTargetFp = null;
  export function openInviteOverlay(fp, nickname) {
    inviteTargetFp = fp;
    const nickEl = document.querySelector('#invite-nick');
    if (nickEl) nickEl.textContent = nickname || fp.slice(0, 8);
    const list = document.querySelector('#invite-rooms');
    if (list) {
      // Non-DM rooms only
      const rooms = [...state.roomData.entries()].filter(([, rd]) => !rd.isDm);
      list.innerHTML = rooms.length
        ? rooms.map(([code, rd]) =>
            '<div class="invite-room-row" data-code="' + esc(code) + '" data-name="' + esc(rd.name || code) + '">'
            + '<span class="ir-name">' + esc(rd.name || code) + '</span>'
            + '<span class="ir-code">' + esc(code) + '</span>'
            + '</div>').join('')
        : '<div class="invite-sub">No rooms to invite to. Join or create one first.</div>';
    }
    document.querySelector('#invite-ov').classList.remove('hidden');
  }
  export function closeInviteOverlay() {
    inviteTargetFp = null;
    document.querySelector('#invite-ov').classList.add('hidden');
  }
  export async function sendInvite(fp, nickname, code, name) {
    // An invite is just a DM message with type 'invite' — the chat renderer
    // draws an action card with a [Join] button instead of plain text.
    const r = await window.sirr.openDm(fp, nickname);
    if (!r || !r.ok || !r.room) return;
    const dmCode = r.room.code;
    if (!state.roomData.has(dmCode)) {
      await rooms.addRoom(dmCode, r.room.name, { isDm: true, dmPeer: r.room.dmPeer });
    }
    const payload = JSON.stringify({ code, name: name || code });
    const res = await window.sirr.sendMessage(dmCode, payload, 'invite', { channel: 'default' });
    if (res && res.message) chat.pushMsg(dmCode, res.message);
    toasts.showToast({ type: 'success', title: 'INVITE SENT', body: 'Invited <b>' + esc(nickname || fp.slice(0, 8)) + '</b> to <b>' + esc(name || code) + '</b>.', ttl: 3500 });
  }

  // ─── Blocklist manager (Privacy tab) ─────────────────────────────
  export function renderBlocklist() {
    const el = document.querySelector('#blocklist-mgr');
    if (!el) return;
    const items = [...state.blocklist].map(fp => {
      const info = resolveProfile(fp);
      return { fp, nick: info ? info.nickname : fp.slice(0, 8) };
    }).sort((a, b) => a.nick.localeCompare(b.nick));
    if (!items.length) {
      el.innerHTML = '<div class="blk-empty">No blocked peers.</div>';
      return;
    }
    el.innerHTML = items.map(it =>
      '<div class="blk-row" data-fp="' + esc(it.fp) + '">'
      + '<div><div class="blk-nick">' + esc(it.nick) + '</div>'
      + '<code class="blk-fp">' + esc(it.fp) + '</code></div>'
      + '<button class="blk-unblock" data-act="unblock">UNBLOCK</button>'
      + '</div>').join('');
  }

  // ─── Profile card ─────────────────────────────────────────────────
  let profileTargetFp = null;

  export function resolveProfile(fp) {
    if (!fp) return null;
    const { peers, contacts, roomRoster } = state;
    let live = null;
    for (const p of peers.values()) {
      if (p.fingerprint === fp) { live = p; break; }
    }
    const contact = contacts.get(fp) || null;
    // Newest roster entry across all rooms — gives last-seen nickname even
    // for peers who are offline and not contacts.
    let rosterBest = null;
    for (const [, map] of roomRoster) {
      const rec = map.get(fp);
      if (rec && (!rosterBest || (rec.lastSeenAt || 0) > (rosterBest.lastSeenAt || 0))) {
        rosterBest = rec;
      }
    }
    const nickname    = (contact && contact.nickname)    || (live && live.nickname)    || (rosterBest && rosterBest.nickname)    || fp.slice(0, 8);
    const avatarEmoji = (live && live.avatarEmoji)       || (contact && contact.avatarEmoji) || (rosterBest && rosterBest.avatarEmoji) || '';
    const online      = !!live;
    const lastSeenAt  = rosterBest ? rosterBest.lastSeenAt : (contact ? contact.lastSeenAt : 0);
    return { fingerprint: fp, nickname, avatarEmoji, online, contact, lastSeenAt };
  }

  export function sharedRoomsFor(fp) {
    if (!fp) return [];
    const { peers, roomRoster, roomData } = state;
    const out = new Set();
    for (const p of peers.values()) {
      if (p.fingerprint !== fp) continue;
      for (const r of (p.rooms || [])) out.add(r);
    }
    for (const [code, map] of roomRoster) {
      if (map.has(fp) && roomData.has(code)) out.add(code);
    }
    return [...out].filter(c => roomData.has(c));
  }

  function fmtLastSeen(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60 * 1000)        return 'just now';
    if (diff < 60 * 60 * 1000)   return Math.floor(diff / 60000)   + 'm ago';
    if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  export function openProfile(fp) {
    const info = resolveProfile(fp);
    if (!info) return;
    profileTargetFp = info.fingerprint;

    const $ = s => document.querySelector(s);
    const mono = info.avatarEmoji || (info.nickname || '?').slice(0, 2).toUpperCase();
    $('#p-card-mono').innerHTML = glyphs.avatarHtml(info.nickname, info.avatarEmoji, '', info.fingerprint);
    $('#p-card-mono').style.fontSize = info.avatarEmoji ? '24px' : '';
    $('#p-card-nick').textContent = info.nickname;

    const pres = $('#p-card-presence');
    if (info.online) {
      pres.textContent = 'ONLINE';
      pres.className = 'p-card-presence p-on';
    } else {
      pres.textContent = info.lastSeenAt ? ('LAST SEEN · ' + fmtLastSeen(info.lastSeenAt)) : 'OFFLINE';
      pres.className = 'p-card-presence p-off';
    }

    const sub = info.contact ? 'CONTACT · saved locally' : (info.online ? 'Connected over Hyperswarm' : 'Known via persisted roster');
    $('#p-card-sub').textContent = sub;
    $('#p-card-fp').textContent = info.fingerprint;

    // Shared rooms — click-to-jump chips (DMs excluded)
    const shared = sharedRoomsFor(info.fingerprint);
    const rEl = $('#p-card-rooms');
    if (shared.length) {
      rEl.innerHTML = shared.map(code => {
        const rd = state.roomData.get(code);
        const name = (rd && rd.name) || code;
        const isDm = rd && rd.isDm;
        if (isDm) return '';
        return '<button class="p-card-room" data-code="' + esc(code) + '">' + esc(name) + '</button>';
      }).join('') || '<span class="p-card-empty">No shared rooms</span>';
    } else {
      rEl.innerHTML = '<span class="p-card-empty">No shared rooms</span>';
    }

    const cBtn = $('#prof-card-ov').querySelector('[data-act="contact"]');
    if (cBtn) {
      cBtn.textContent = info.contact ? '✓ REMOVE' : '+ ADD';
      cBtn.classList.toggle('ghost', !!info.contact);
    }
    const bBtn = $('#prof-card-ov').querySelector('[data-act="block"]');
    if (bBtn) {
      const isBlocked = state.blocklist.has(info.fingerprint);
      bBtn.textContent = isBlocked ? 'UNBLOCK' : 'BLOCK';
      bBtn.classList.toggle('unblock', isBlocked);
    }

    $('#prof-card-ov').classList.remove('hidden');
  }

  export function closeProfile() {
    profileTargetFp = null;
    document.querySelector('#prof-card-ov').classList.add('hidden');
  }

  // ─── One-time wiring ─────────────────────────────────────────────
  // Called from app.js's boot() after setDeps. Binds the three delegated
  // handlers this module owns (profile card, blocklist manager, invite
  // overlay room list + close button).
  export function init() {
    const prof = document.querySelector('#prof-card-ov');
    if (prof) prof.addEventListener('click', async (e) => {
      const bg = e.target.closest('[data-act="close"]');
      if (bg) { closeProfile(); return; }
      const roomBtn = e.target.closest('.p-card-room');
      if (roomBtn) {
        const code = roomBtn.dataset.code;
        if (code && state.roomData.has(code)) {
          closeProfile();
          rooms.switchRoom(code);
        }
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || !profileTargetFp) return;
      const fp = profileTargetFp;
      const info = resolveProfile(fp);
      const nick = info ? info.nickname : '';
      if (act === 'copy-fp') {
        copyText(fp);
        return;
      }
      if (act === 'dm') {
        closeProfile();
        doOpenDm(fp, nick);
        return;
      }
      if (act === 'contact') {
        if (info && info.contact) await doRemoveContact(fp);
        else await doAddContact(fp, nick, info ? info.avatarEmoji : '');
        openProfile(fp);  // refresh card state
        return;
      }
      if (act === 'invite') {
        closeProfile();
        openInviteOverlay(fp, nick);
        return;
      }
      if (act === 'block') {
        if (state.blocklist.has(fp)) {
          await window.sirr.unblockPeer(fp);
          state.blocklist.delete(fp);
          toasts.showToast({ type: 'info', title: 'UNBLOCKED', body: esc(nick) + ' can connect again.', ttl: 3000 });
        } else {
          toasts.showToast({
            type: 'action',
            title: 'BLOCK PEER',
            body: 'Block <b>' + esc(nick) + '</b>? They won\'t be able to connect to you.',
            actions: [
              { label: 'Cancel', onClick: c => c() },
              { label: 'Block', primary: true, onClick: async c => {
                  c();
                  const r = await window.sirr.blockPeer(fp, nick);
                  if (r && r.ok) {
                    state.blocklist.add(fp);
                    toasts.showToast({ type: 'success', title: 'BLOCKED', body: esc(nick) + ' has been blocked.', ttl: 3000 });
                    closeProfile();
                  }
                } },
            ],
          });
        }
        if (profileTargetFp === fp) openProfile(fp);
        return;
      }
    });

    const blk = document.querySelector('#blocklist-mgr');
    if (blk) blk.addEventListener('click', async e => {
      const row = e.target.closest('.blk-row');
      if (!row) return;
      if (e.target.closest('[data-act="unblock"]')) {
        const fp = row.dataset.fp;
        if (!fp) return;
        const r = await window.sirr.unblockPeer(fp);
        if (r && r.ok) {
          state.blocklist.delete(fp);
          renderBlocklist();
          toasts.showToast({ type: 'info', title: 'UNBLOCKED', body: esc(fp.slice(0, 8)) + ' can connect again.', ttl: 2500 });
        }
      }
    });

    const invRooms = document.querySelector('#invite-rooms');
    if (invRooms) invRooms.addEventListener('click', e => {
      const row = e.target.closest('.invite-room-row');
      if (!row || !inviteTargetFp) return;
      const fp = inviteTargetFp;
      const nick = state.contacts.get(fp)?.nickname || '';
      const code = row.dataset.code, name = row.dataset.name;
      closeInviteOverlay();
      sendInvite(fp, nick, code, name);
    });
    const invClose = document.querySelector('#btn-close-invite');
    if (invClose) invClose.addEventListener('click', closeInviteOverlay);
  }


