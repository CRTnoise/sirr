/**
 * Sirr — Renderer Entry (ES Module)
 * =====================================
 * Pure ESM consumer: imports state + every feature module by name. No IIFE,
 * no `window.SirrX` shims, no `setDeps()` plumbing. Mutables live on
 * `state.state.X`; collections live as named exports on state.js.
 *
 * Loaded via `<script type="module" src="app.js">` in index.html. The module
 * graph is:
 *   app.js
 *     ├─ state.js
 *     ├─ toasts.js     (depends: state)
 *     ├─ admin-panel.js (depends: state, toasts)
 *     ├─ peers.js      (depends: state, toasts, admin-panel, rooms, chat, voice)
 *     ├─ rooms.js      (depends: state, toasts, admin-panel, peers, chat, voice)
 *     ├─ chat.js       (depends: state, peers, toasts, admin-panel, rooms)
 *     └─ voice.js      (depends: state, …)
 *
 * Cycles between feature modules are resolved at call time via `import * as`
 * — bindings are resolved lazily when functions actually run.
 */

import * as state from './modules/state.js';
import * as toasts from './modules/toasts.js';
import * as admin from './modules/admin-panel.js';
import * as rooms from './modules/rooms.js';
import * as chat from './modules/chat.js';
import * as peers from './modules/peers.js';
import * as voice from './modules/voice.js';
import * as ctx from './modules/ctxmenu.js';
import * as audioEngine from './modules/audio-engine.js';
import * as denoise from './modules/denoise.js';
import * as mesh from './modules/mesh-voice.js';
import * as glyphs from './modules/glyphs.js';
import { mountSigilEditor } from './modules/sigil-editor.js';

// ─── DOM helpers ───────────────────────────────────────────────────
const $  = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };

// ─── Audio (notification beep) ────────────────────────────────────
let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
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

// ─── Generic shims that several places call ──────────────────────
function downloadUrl(u, fn) {
  const a = document.createElement('a');
  a.href = u; a.download = fn;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function copyText(t) {
  try { window.sirr.copyText(t); } catch (e) {}
  try {
    const ta = document.createElement('textarea'); ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  } catch (e) {}
}

// Expose downloadUrl + copyText globally — the existing module sources
// call them directly from inline-rendered handlers in some places, and
// it's cheaper than threading deps for two trivial functions.
window.__phDownloadUrl = downloadUrl;
window.__phCopyText    = copyText;

// ─── Room code helpers ────────────────────────────────────────────
const CC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

// Codes always come from main (CSPRNG + owner commitment). There is no
// renderer-side fallback: a weak code is worse than no room.
async function genCode() {
  return await window.sirr.generateRoomCode();
}

async function validateCodeLocal(input) {
  const code = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return { ok: false, reason: 'EMPTY' };
  if (/^DM[0-9A-F]{10}$/.test(code)) return { ok: true, code };
  // Mirrors lib/roomcode.js validate() — the renderer can't require() it.
  const m = /^SR-?([A-Z0-9-]+)$/.exec(code);
  const chars = m ? m[1].replace(/-/g, '') : '';
  if (chars.length !== 40) return { ok: false, reason: 'BAD_FORMAT' };
  if (!new RegExp('^[' + CC + ']+$').test(chars)) return { ok: false, reason: 'BAD_CHARS' };
  const body = chars.slice(0, 38);
  const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode('SR-' + body));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  const n = parseInt(hex.slice(0, 4), 16);
  if (CC[n % CC.length] + CC[Math.floor(n / CC.length) % CC.length] !== chars.slice(38)) return { ok: false, reason: 'BAD_CHECKSUM' };
  return { ok: true, code: 'SR-' + chars.match(/.{5}/g).join('-') };
}
function codeReasonMsg(reason) {
  switch (reason) {
    case 'EMPTY':        return 'Enter a room code.';
    case 'BAD_FORMAT':   return 'Expected a Sirr code: <b>SR-</b> followed by 40 characters.';
    case 'BAD_CHARS':    return 'Contains characters outside the Sirr alphabet.';
    case 'BAD_CHECKSUM': return 'Code checksum failed — likely a typo.';
    default:             return 'That is not a valid Sirr invite code.';
  }
}

// ─── Appearance ───────────────────────────────────────────────────
function applyAccent(h) {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const s = document.documentElement.style;
  s.setProperty('--accent', h);
  s.setProperty('--a10', `rgba(${r},${g},${b},.10)`);
  s.setProperty('--a15', `rgba(${r},${g},${b},.15)`);
  s.setProperty('--a25', `rgba(${r},${g},${b},.25)`);
  s.setProperty('--a40', `rgba(${r},${g},${b},.40)`);
}
function applyFont(v)    { document.documentElement.style.setProperty('--fs', v); }
function applyDensity(d) {
  const r = document.documentElement;
  r.classList.remove('density-compact', 'density-cozy');
  if (d === 'compact') r.classList.add('density-compact');
  else if (d === 'cozy') r.classList.add('density-cozy');
}
function applyLayout(l) {
  document.documentElement.classList.toggle('layout-irc', l !== 'cards');
}
function applyBubble(b) {
  const m = $('#messages'); if (!m) return;
  m.classList.remove('bubble-subtle', 'bubble-glass');
  if (b === 'subtle' || b === 'glass') m.classList.add('bubble-' + b);
}
function applyChatBg(b) {
  const m = document.querySelector('.c-msgs'); if (!m) return;
  m.classList.remove('bg-dots', 'bg-grid', 'bg-circuit');
  if (['dots', 'grid', 'circuit'].includes(b)) {
    m.classList.add('bg-' + b);
    localStorage.setItem('sirr_bg', b);
  } else {
    localStorage.removeItem('sirr_bg');
  }
}
function applyA11y() {
  const r = document.documentElement;
  r.classList.toggle('reduce-motion', state.state.reduceMotion === 'on');
  r.classList.toggle('high-contrast', state.state.highContrast === 'on');
  r.classList.toggle('large-targets', state.state.largeTargets === 'on');
}

// ─── Idle / auto-away ─────────────────────────────────────────────
const IDLE_MS = 5 * 60 * 1000;
let idleCheckTimer = null;
let lastMouseMoveResetAt = 0;
function markActivity() {
  state.state.lastActivity = Date.now();
  if (state.state.idleState === 'away') {
    state.state.idleState = 'active';
    try { window.sirr.setIdleStatus('active'); } catch (e) {}
  }
}
function onMouseMoveActivity() {
  const now = Date.now();
  if (now - lastMouseMoveResetAt < 2000) return;
  lastMouseMoveResetAt = now;
  markActivity();
}
function startIdleWatcher() {
  if (idleCheckTimer) clearInterval(idleCheckTimer);
  idleCheckTimer = setInterval(() => {
    if (state.state.idleState === 'active' && Date.now() - state.state.lastActivity > IDLE_MS) {
      state.state.idleState = 'away';
      try { window.sirr.setIdleStatus('away'); } catch (e) {}
    }
  }, 30_000);
  document.addEventListener('keydown',   markActivity);
  document.addEventListener('mousedown', markActivity);
  document.addEventListener('mousemove', onMouseMoveActivity);
  window.addEventListener('focus',       markActivity);
}

// ─── Settings overlay helpers ─────────────────────────────────────
function opt(sel, key, apply, getV) {
  $$(sel).forEach(b => b.addEventListener('click', () => {
    const v = getV(b);
    $$(sel).forEach(x => x.classList.toggle('act', x === b));
    apply(v);
    try { window.sirr.updateConfig({ [key]: v }); } catch (e) {}
  }));
}
// Name and status go out as you type (after a short pause), not when the
// settings panel closes: everyone sees the change at once.
let _profileTimer = 0;
function commitProfile() {
  const nn = ($('#set-nick')?.value || '').trim();
  if (nn && nn !== state.state.myNickname) {
    state.state.myNickname = nn;
    $('#sb-nick').textContent = nn;
    if (peers.updateMyAvatarCells) peers.updateMyAvatarCells();
    refreshAvatarPreview();
    try { window.sirr.updateConfig({ nickname: nn }); } catch (e) {}
    chat.refreshAuthor(state.state.myFingerprint, { nickname: nn });
  }
  const ns = ($('#set-status')?.value || '').trim();
  if (ns !== state.state.statusText) {
    state.state.statusText = ns;
    try { window.sirr.updateConfig({ statusText: ns }); } catch (e) {}
  }
}
function scheduleProfileCommit() { clearTimeout(_profileTimer); _profileTimer = setTimeout(commitProfile, 450); }
function closeSets() {
  $('#settings').classList.add('hidden');
  voice.stopMicTest($('#mic-test-meter'), $('#mic-test-db'));
  const mt = $('#btn-mic-test'); if (mt) mt.textContent = 'TEST MIC';
  clearTimeout(_profileTimer); commitProfile();
}
function refreshAvatarPreview() {
  const el = $('#set-avatar-preview');
  if (!el) return;
  el.innerHTML = peers.avatarHtml
    ? peers.avatarHtml(state.state.myNickname, state.state.avatarEmoji, state.state.avatarImage)
    : '';
  el.style.padding = state.state.avatarImage ? '0' : '';
}

// ─── Getting through (Settings → Privacy) ─────────────────────────
async function refreshPathStatus() {
  const el = $('#path-status'); if (!el) return;
  let st = null;
  try { st = await window.sirr.pathwaysStats?.(); } catch (e) {}
  if (!st) { el.textContent = '—'; return; }
  const parts = [];
  parts.push(st.bridge ? 'via bridge' : 'direct (UDP)');
  parts.push((st.remembered || 0) + ' entry points remembered');
  parts.push((st.relays || 0) + ' relays known');
  if (st.volunteering) parts.push('relaying for ' + (st.relaying || 0));
  if (st.servingBridge) parts.push('serving a bridge');
  if (st.nearby) parts.push('nearby: ' + st.nearby.links + ' links, ' + st.nearby.reach + ' in reach');
  parts.push('bluetooth: ' + (st.ble || 'off'));
  el.textContent = parts.join(' · ');
  const h = $('#bridge-hint');
  if (h) {
    const show = !!(st.bridgeHint && !state.state.bridge);
    h.classList.toggle('hidden', !show);
    if (show) h.textContent = 'An invite suggested a bridge: ' + st.bridgeHint + ' — paste it above to use it.';
  }
}

// ─── App lock & panic (Settings → Security) ───────────────────────
async function refreshLockUi() {
  let st = { enabled: false, keystore: true };
  try { st = (await window.sirr.lockStatus()) || st; } catch (e) {}
  $('#lock-state').textContent = st.enabled ? '(on)' : '(off)';
  $('#lock-cur').classList.toggle('hidden', !st.enabled);
  $('#btn-lock-set').textContent = st.enabled ? 'CHANGE' : 'TURN ON';
  $('#btn-lock-off').classList.toggle('hidden', !st.enabled);
  $('#btn-lock-now').classList.toggle('hidden', !st.enabled);
  const at = $('#sec-atrest');
  if (at) at.textContent = (st.keystore ? 'OS keychain' : '0600 file') + (st.enabled ? ' + passphrase' : '');
}
function bindLockUi() {
  const msg = (t) => { $('#lock-msg').textContent = t || ''; };
  const clear = () => ['#lock-cur', '#lock-new', '#lock-duress'].forEach(x => { $(x).value = ''; });
  $('#btn-lock-set')?.addEventListener('click', async (e) => {
    const b = e.currentTarget; b.disabled = true; msg('Deriving key…');
    const r = await window.sirr.lockEnable({ current: $('#lock-cur').value, pass: $('#lock-new').value, duress: $('#lock-duress').value });
    b.disabled = false; msg(r && r.ok ? 'Lock is on. Sirr will ask for it next start.' : (r && r.error) || 'Failed.');
    if (r && r.ok) clear();
    refreshLockUi();
  });
  $('#btn-lock-off')?.addEventListener('click', async () => {
    msg('Checking…');
    const r = await window.sirr.lockDisable({ pass: $('#lock-cur').value });
    msg(r && r.ok ? 'Lock is off.' : (r && r.error) || 'Failed.');
    if (r && r.ok) clear();
    refreshLockUi();
  });
  $('#btn-lock-now')?.addEventListener('click', () => window.sirr.lockNow());
  const wc = $('#wipe-confirm'), wb = $('#btn-wipe');
  wc?.addEventListener('input', () => { wb.disabled = wc.value.trim() !== 'WIPE'; });
  wb?.addEventListener('click', () => { if (wc.value.trim() === 'WIPE') window.sirr.panicWipe(); });
}

// ─── Room rename inline edit (sidebar header) ─────────────────────
function commitRename() {
  const input = $('#sb-room-input'), label = $('#sb-room-label');
  const val = input.value.trim();
  input.classList.add('hidden'); label.classList.remove('hidden');
  if (!val || !state.state.activeRoom) return;
  const rd = state.roomData.get(state.state.activeRoom);
  if (rd) rd.name = val;
  try { window.sirr.renameRoom(state.state.activeRoom, val); } catch (e) {}
  label.textContent = val;
  label.classList.remove('untitled');
  const ch = rd?.channels?.get(state.state.activeTextChannel);
  $('#tb-room').textContent = ch ? ch.name : val;
  rooms.renderRail();
}

// ─── Enter chat (after first join) ────────────────────────────────
function enterChat() {
  $('#join-screen').classList.remove('active');
  $('#chat-screen').classList.add('active');
  $('#sb-nick').textContent = state.state.myNickname;
  $('#sb-fp').textContent = state.state.myFingerprint.slice(0, 9) + '...';
  if (peers.updateMyAvatarCells) peers.updateMyAvatarCells();
  if ($('#set-nick')) $('#set-nick').value = state.state.myNickname;
  if ($('#set-fp'))   $('#set-fp').textContent = state.state.myFingerprint;
}

// ─── First-run onboarding ─────────────────────────────────────────
// Show once after the very first room is created. Gives the user the
// room code + copy buttons so they can immediately invite someone.
// Suppressed on subsequent launches via localStorage flag.
function showOnboarding(roomCode) {
  if (localStorage.getItem('sirr_onboarded') === '1') return;
  const ov = $('#onboard-ov');
  const codeEl = $('#onboard-code');
  if (!ov || !codeEl) return;
  codeEl.textContent = roomCode;
  ov.classList.remove('hidden');

  const hint    = $('#onboard-hint');
  const copyBtn = $('#btn-onboard-copy');
  const linkBtn = $('#btn-onboard-link');
  const closeBtn = $('#btn-onboard-close');

  function flashHint(msg) {
    if (!hint) return;
    hint.textContent = msg;
    hint.classList.add('visible');
    setTimeout(() => hint.classList.remove('visible'), 2000);
  }

  // Invite URL (scheme link, or the configured gateway with the code in
  // the fragment), then a QR code for it so a phone can scan it directly.
  async function buildInviteUrl() {
    try { return await window.sirr.buildInviteUrl(roomCode); } catch (e) { return roomCode; }
  }

  // Generate QR in the background — show it once ready.
  buildInviteUrl().then(url => {
    if (window.sirr.generateQr) {
      window.sirr.generateQr(url).then(dataUrl => {
        const img = $('#onboard-qr');
        if (img && dataUrl) {
          img.src = dataUrl;
          img.classList.remove('hidden');
        }
      }).catch(() => {});
    }
  });

  copyBtn?.addEventListener('click', () => {
    copyText(roomCode);
    const orig = copyBtn.querySelector('span');
    if (orig) orig.textContent = 'COPIED ✓';
    setTimeout(() => { if (orig) orig.textContent = 'COPY CODE'; }, 1500);
    flashHint('Code copied to clipboard.');
  });

  linkBtn?.addEventListener('click', async () => {
    const url = await buildInviteUrl();
    copyText(url);
    const orig = linkBtn.querySelector('span');
    if (orig) orig.textContent = 'LINK COPIED ✓';
    setTimeout(() => { if (orig) orig.textContent = 'COPY INVITE LINK'; }, 1500);
    flashHint('Invite link copied — paste it anywhere.');
  });

  function dismiss() {
    ov.classList.add('hidden');
    localStorage.setItem('sirr_onboarded', '1');
  }
  closeBtn?.addEventListener('click', dismiss);
  ov.querySelector('.ov-bg')?.addEventListener('click', dismiss);
}

async function firstJoin(code, opts) {
  const nick = ($('#in-nick').value || '').trim() || 'anon';
  if (nick !== state.state.myNickname) {
    state.state.myNickname = nick;
    try { await window.sirr.updateConfig({ nickname: nick }); } catch (e) {}
  }
  $('#btn-create').disabled = true;
  $('#btn-join').disabled = true;
  $('#join-status').textContent = 'Connecting...';
  const ok = await rooms.addRoom(code, (opts && opts.asOwner) ? { asOwner: true } : undefined);
  if (!ok) {
    $('#join-status').textContent = 'Failed';
    $('#join-status').className = 'err';
    $('#btn-create').disabled = false;
    $('#btn-join').disabled = $('#in-code').value.length < 4;
    return;
  }
  enterChat();
  rooms.switchRoom(code);
  // Show the onboarding overlay the first time a room is created so the
  // user immediately knows how to share the code with someone.
  if (opts && opts.asOwner) showOnboarding(code);
}

// ─── Hover tooltip on peer rows (delegated) ──────────────────────
function _attachPeerHover(containerEl) {
  if (!containerEl) return;
  let currentRow = null;
  containerEl.addEventListener('mouseover', e => {
    const row = e.target.closest('.peer:not(.me):not(.peer-sec-hd)');
    if (!row || row === currentRow) return;
    currentRow = row;
    peers.showPeerTooltip(row);
  });
  containerEl.addEventListener('mouseout', e => {
    const row = e.target.closest('.peer');
    if (!row) return;
    const rel = e.relatedTarget;
    if (rel && row.contains(rel)) return;
    currentRow = null;
    peers.hidePeerTooltip();
  });
  containerEl.addEventListener('mouseleave', () => {
    currentRow = null;
    peers.hidePeerTooltip();
  });
}

// ─── Typing-debounce for the composer ────────────────────────────
let typingTimer = null;

// ─── DOM listeners ────────────────────────────────────────────────
// Wire on DOMContentLoaded so `<script type="module">` deferral doesn't

// People paste whole invite links (sirr://join/<code>, or a gateway
// URL carrying the code in its #fragment). Pull the code out of whatever
// was pasted.
function extractCode(raw) {
  let v = String(raw || '').trim();
  if (/[?&#]via=/.test(v)) { try { window.sirr.noteInviteHints?.(v); } catch (e) {} }
  const m = /sirr:\/\/join\/([^?#\s]+)/i.exec(v) || /^https?:\/\/[^#\s]*#([^&\s]+)/i.exec(v);
  if (m) { try { v = decodeURIComponent(m[1]); } catch (e) { v = m[1]; } }
  return v.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 64);
}
// race with elements like #in-code which render below the script tag.
function wireDom() {
  // ── DM message requests ──
  const reqBar = () => {
    const code = state.state.activeRoom;
    const rd = code && state.roomData.get(code);
    const bar = $('#dm-req-bar'); if (!bar) return;
    const on = !!(rd && rd.request);
    bar.classList.toggle('hidden', !on);
    if (on) $('#dm-req-txt').textContent = (rd.dmPeer?.nickname || 'Someone') + ' · ' + (rd.dmPeer?.fingerprint || '') + ' — not in your contacts';
  };
  window.addEventListener('sirr:room-switched', reqBar);
  // /join from the composer (modules/chat.js)
  window.addEventListener('sirr:join-code', async (e) => {
    const v = await validateCodeLocal(extractCode(e.detail && e.detail.code));
    if (!v.ok) { chat.sysMsg('/join: ' + codeReasonMsg(v.reason).replace(/<[^>]+>/g, '')); return; }
    if (await rooms.addRoom(v.code)) rooms.switchRoom(v.code);
  });
  const decide = async (kind) => {
    const code = state.state.activeRoom; const rd = code && state.roomData.get(code);
    if (!rd || !rd.request) return;
    if (kind === 'accept') {
      await window.sirr.acceptDmRequest(code);
      delete rd.request;
      rooms.renderRail(); reqBar();
      toasts.showToast({ type: 'success', title: 'REQUEST ACCEPTED', body: rd.dmPeer?.nickname || '', ttl: 2500 });
    } else {
      await window.sirr.declineDmRequest(code, kind === 'block');
      state.roomData.delete(code);
      state.state.activeRoom = null;
      rooms.renderRail();
      $('#dm-req-bar').classList.add('hidden');
      toasts.showToast({ type: 'info', title: kind === 'block' ? 'BLOCKED' : 'REQUEST DECLINED', body: rd.dmPeer?.nickname || '', ttl: 2500 });
    }
  };
  $('#dm-req-accept').addEventListener('click', () => decide('accept'));
  $('#dm-req-decline').addEventListener('click', () => decide('decline'));
  $('#dm-req-block').addEventListener('click', () => decide('block'));

  $('#in-code').addEventListener('input', async function () {
    this.value = extractCode(this.value);
    const v = await validateCodeLocal(this.value);
    $('#btn-join').disabled = !v.ok;
    this.classList.toggle('bad', !v.ok && this.value.length >= 20);
  });
  $('#in-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#in-code').focus(); });
  $('#in-code').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !$('#btn-join').disabled) firstJoin($('#in-code').value.trim());
  });

  const _nickField = $('#j-field-nick'), _codeField = $('#j-field-code');
  if (_nickField) {
    $('#in-nick').addEventListener('focus', () => _nickField.classList.add('focused'));
    $('#in-nick').addEventListener('blur',  () => _nickField.classList.remove('focused'));
  }
  if (_codeField) {
    $('#in-code').addEventListener('focus', () => _codeField.classList.add('focused'));
    $('#in-code').addEventListener('blur',  () => _codeField.classList.remove('focused'));
  }
  const _jdate = $('#j-date');
  if (_jdate) _jdate.textContent = new Date().toISOString().slice(0, 10);

  $('#btn-create').addEventListener('click', async () => firstJoin(await genCode(), { asOwner: true }));
  $('#btn-join').addEventListener('click', async () => {
    const raw = extractCode($('#in-code').value);
    if (!raw) return;
    const v = await validateCodeLocal(raw);
    if (!v.ok) {
      $('#join-status').innerHTML = codeReasonMsg(v.reason);
      $('#join-status').className = 'err';
      return;
    }
    firstJoin(v.code);
  });

  $('#btn-send').addEventListener('click', () => chat.doSend());
  $('#in-msg').addEventListener('keydown', e => {
    const dd = $('#mention-dd');
    const ddOpen = dd && !dd.classList.contains('hidden');
    if (ddOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); chat.moveMentionDD(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); chat.moveMentionDD(-1); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault(); chat.acceptMention(); return;
      }
      if (e.key === 'Escape') { e.preventDefault(); chat.hideMentionDD(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chat.doSend(); }
    if (e.key === 'Escape') chat.cancelReply();
  });
  $('#in-msg').addEventListener('input', function () {
    $('#btn-send').classList.toggle('on', this.value.trim().length > 0);
    if (this.value.trim() && state.state.activeRoom && state.state.sendTypingPref === 'on') {
      if (!typingTimer) try { window.sirr.sendTyping(state.state.activeRoom, state.state.activeTextChannel); } catch (e) {}
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { typingTimer = null; }, 2500);
    }
    chat.updateMentionDD();
  });
  $('#in-msg').addEventListener('blur', () => setTimeout(() => chat.hideMentionDD(), 150));
  $('#mention-dd').addEventListener('mousedown', e => {
    e.preventDefault();
    const row = e.target.closest('.mention-it');
    if (!row) return;
    chat.acceptMention();
  });

  // ── Disappearing-message TTL badge ─────────────────────────────────
  // Click cycles: off → 30s → 5m → 1h → 1d → 1w → off. Per-room, persisted
  // by main. The badge reflects the active room's current TTL.
  const TTL_STEPS = [
    { ms: 0,        label: 'OFF' },
    { ms: 30000,    label: '30s' },
    { ms: 300000,   label: '5m'  },
    { ms: 3600000,  label: '1h'  },
    { ms: 86400000, label: '1d'  },
    { ms: 604800000,label: '1w'  },
  ];
  function _renderTtlBadge(ms) {
    const badge = $('#btn-ttl'); if (!badge) return;
    const step = TTL_STEPS.find(s => s.ms === ms) || TTL_STEPS[0];
    badge.textContent = step.label;
    badge.classList.toggle('on', ms > 0);
    badge.title = ms === 0
      ? 'Disappearing messages off — click to enable'
      : 'Messages vanish after ' + step.label + ' — click to change';
  }
  async function refreshTtlBadge() {
    const badge = $('#btn-ttl'); if (!badge) return;
    if (!state.state.activeRoom) { badge.classList.add('hidden'); return; }
    badge.classList.remove('hidden');
    try {
      const r = await window.sirr.getRoomTtl(state.state.activeRoom);
      _renderTtlBadge((r && r.ttl) || 0);
    } catch (e) { _renderTtlBadge(0); }
  }
  // Expose so the room-switch path can refresh it.
  window.__refreshTtlBadge = refreshTtlBadge;
  $('#btn-ttl').addEventListener('click', async () => {
    if (!state.state.activeRoom) return;
    let cur = 0;
    try { const r = await window.sirr.getRoomTtl(state.state.activeRoom); cur = (r && r.ttl) || 0; } catch (e) {}
    const idx = TTL_STEPS.findIndex(s => s.ms === cur);
    const next = TTL_STEPS[(idx + 1) % TTL_STEPS.length];
    try {
      const res = await window.sirr.setRoomTtl(state.state.activeRoom, next.ms);
      _renderTtlBadge((res && res.ttl) || next.ms);
    } catch (e) {}
  });
  refreshTtlBadge();

  // No history on this device (per room, local only).
  const _renderNoLog = (on) => {
    const b = $('#btn-nolog'); if (!b) return;
    b.textContent = on ? 'NO LOG' : 'LOG';
    b.classList.toggle('on', !!on);
    b.title = on ? 'Nothing from this room is written to this device — click to keep history again'
                 : 'History is kept on this device (encrypted) — click to keep none';
  };
  async function refreshNoLog() {
    const b = $('#btn-nolog'); if (!b) return;
    if (!state.state.activeRoom) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    try { const r = await window.sirr.getRoomEphemeral(state.state.activeRoom); _renderNoLog(r && r.on); } catch (e) { _renderNoLog(false); }
  }
  window.__refreshNoLog = refreshNoLog;
  $('#btn-nolog')?.addEventListener('click', async () => {
    const room = state.state.activeRoom; if (!room) return;
    let cur = false;
    try { cur = !!(await window.sirr.getRoomEphemeral(room))?.on; } catch (e) {}
    const r = await window.sirr.setRoomEphemeral(room, !cur);
    _renderNoLog(r && r.on);
    chat.sysMsg(r && r.on ? 'this device no longer keeps history for this room — stored history was erased. Messages live in memory until you quit.'
                          : 'history for this room is kept on this device again (encrypted).');
  });
  refreshNoLog();

  $('#btn-attach').addEventListener('click', () => $('#file-pick').click());
  $('#file-pick').addEventListener('change', function () {
    const f = this.files[0]; this.value = '';
    if (f) voice.processFile(f);
  });

  const _fprogCancelBtn = $('#btn-fprog-cancel');
  if (_fprogCancelBtn) _fprogCancelBtn.addEventListener('click', () => chat.cancelVisibleTransfer());

  document.addEventListener('paste', e => {
    if (!state.state.activeRoom) return;
    for (const item of (e.clipboardData?.items || [])) {
      if (item.type.startsWith('image/')) { e.preventDefault(); voice.processFile(item.getAsFile()); break; }
    }
  });

  $('#btn-img-no').addEventListener('click', () => $('#img-prev').classList.add('hidden'));
  $('#img-prev .ov-bg').addEventListener('click', () => $('#img-prev').classList.add('hidden'));
  $('#img-view .ov-bg').addEventListener('click', () => $('#img-view').classList.add('hidden'));
  $('#btn-img-close').addEventListener('click', () => $('#img-view').classList.add('hidden'));
  $('#btn-img-dl').addEventListener('click', () => {
    // chat.js's renderMsg sets the current image src on its module-private
    // var. We re-read it from the dialog's `<img>` directly to avoid
    // exporting yet-another getter just for this button.
    const img = $('#img-view-src');
    if (img && img.src) downloadUrl(img.src, 'sirr-image.jpg');
  });

  $('#btn-cancel-reply').addEventListener('click', () => chat.cancelReply());

  $('#sb-room-label').addEventListener('dblclick', () => {
    if (!state.state.activeRoom) return;
    const rd = state.roomData.get(state.state.activeRoom);
    const input = $('#sb-room-input');
    input.value = (rd?.name && rd.name !== state.state.activeRoom) ? rd.name : '';
    $('#sb-room-label').classList.add('hidden');
    input.classList.remove('hidden');
    input.focus(); input.select();
  });
  $('#sb-room-input').addEventListener('blur', commitRename);
  $('#sb-room-input').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape') {
      $('#sb-room-input').classList.add('hidden');
      $('#sb-room-label').classList.remove('hidden');
    }
  });

  $('#btn-add-room').addEventListener('click', () => $('#add-room-ov').classList.remove('hidden'));
  $('#btn-close-add').addEventListener('click', () => $('#add-room-ov').classList.add('hidden'));
  $('#add-room-ov .ov-bg').addEventListener('click', () => $('#add-room-ov').classList.add('hidden'));
  $('#in-code2').addEventListener('input', async function () {
    this.value = extractCode(this.value);
    const v = await validateCodeLocal(this.value);
    $('#btn-join2').disabled = !v.ok;
    this.classList.toggle('bad', !v.ok && this.value.length >= 20);
  });
  $('#btn-create2').addEventListener('click', async () => {
    const c = await genCode();
    await rooms.addRoom(c, { asOwner: true });
    rooms.switchRoom(c);
    $('#add-room-ov').classList.add('hidden');
  });
  $('#btn-join2').addEventListener('click', async () => {
    const c = extractCode($('#in-code2').value);
    if (!c) return;
    const v = await validateCodeLocal(c);
    if (!v.ok) {
      toasts.showToast({ type: 'warn', title: 'INVALID CODE', body: codeReasonMsg(v.reason), ttl: 4000 });
      return;
    }
    await rooms.addRoom(v.code);
    rooms.switchRoom(v.code);
    $('#add-room-ov').classList.add('hidden');
    $('#in-code2').value = '';
  });

  $('#btn-copy-code').addEventListener('click', () => {
    if (!state.state.activeRoom) return;
    copyText(state.state.activeRoom);
    const b = $('#btn-copy-code');
    b.classList.add('ok'); b.textContent = 'COPIED';
    setTimeout(() => { b.classList.remove('ok'); b.textContent = 'COPY'; }, 1500);
  });

  // Copies an invite link (see lib/roomcode.js toInviteUrl).
  $('#btn-copy-link')?.addEventListener('click', async () => {
    if (!state.state.activeRoom) return;
    let text;
    try { text = await window.sirr.buildInviteUrl(state.state.activeRoom); } catch (e) {
      text = state.state.activeRoom;
    }
    copyText(text);
    const b = $('#btn-copy-link');
    b.classList.add('ok'); b.textContent = 'COPIED';
    setTimeout(() => { b.classList.remove('ok'); b.textContent = 'LINK'; }, 1500);
  });

  // sirr:// join buttons rendered inside chat messages (fmtTxt).
  // Clicking one triggers the same join flow as a deep-link.
  $('#messages')?.addEventListener('click', e => {
    const btn = e.target.closest('.ph-link-btn');
    if (!btn) return;
    e.stopPropagation();
    const code = btn.dataset.code;
    if (!code) return;
    validateCodeLocal(code).then(v => {
      if (!v.ok) {
        toasts.showToast({ type: 'warn', title: 'INVALID INVITE', body: codeReasonMsg(v.reason), ttl: 4000 });
        return;
      }
      if (state.roomData.has(v.code)) {
        rooms.switchRoom(v.code);
        return;
      }
      rooms.addRoom(v.code).then(ok => {
        if (ok) {
          rooms.switchRoom(v.code);
        } else {
          toasts.showToast({ type: 'warn', title: 'JOIN FAILED', body: 'Could not join room.', ttl: 3500 });
        }
      });
    });
  });

  // Legacy quick-join: route to first voice channel of active room
  $('#btn-voice-join').addEventListener('click', async () => {
    if (!state.state.activeRoom) return;
    // Connected here → the status bar opens the call screen (Discord-style).
    if (voice.isVoiceOn() && $('#btn-voice-join').classList.contains('active')) { voice.toggleCallScreen(); return; }
    const voices = rooms.getChannelsByKind(state.state.activeRoom, 'voice');
    if (!voices.length) { chat.sysMsg('⚠ No voice channels — add one first'); return; }
    voice.joinVoiceChannel(voices[0].id);
  });

  const _openCall = $('#btn-open-call');
  if (_openCall) _openCall.addEventListener('click', () => voice.toggleCallScreen());
  const _vu = $('#voice-users');
  if (_vu) _vu.addEventListener('click', (e) => {
    const row = e.target.closest('.vu-row[data-fp]');
    if (row && row.dataset.fp) peers.openProfile(row.dataset.fp);
  });
  wireContextMenus();

  const _addVBtn = $('#btn-add-vchan'), _addTBtn = $('#btn-add-tchan');
  if (_addVBtn) _addVBtn.addEventListener('click', () => rooms.beginAddChannel('voice'));
  if (_addTBtn) _addTBtn.addEventListener('click', () => rooms.beginAddChannel('text'));

  _attachPeerHover($('#peers-list'));
  _attachPeerHover($('#contacts-list'));

  // Peers ledger drawer
  const _togglePeersBtn = $('#btn-toggle-peers');
  if (_togglePeersBtn) _togglePeersBtn.addEventListener('click', () => {
    const dr = $('#peers-drawer');
    if (!dr) return;
    dr.classList.toggle('hidden');
    _togglePeersBtn.classList.toggle('active', !dr.classList.contains('hidden'));
  });
  const _closePeersBtn = $('#btn-close-peers');
  if (_closePeersBtn) _closePeersBtn.addEventListener('click', () => {
    $('#peers-drawer').classList.add('hidden');
    if (_togglePeersBtn) _togglePeersBtn.classList.remove('active');
  });

  $('#btn-screen').addEventListener('click', () => {
    if (state.state.screenSharing) voice.stopScreenShare(); else voice.startScreenShare();
  });
  $('#btn-cam').addEventListener('click', () => {
    if (state.state.camSharing) voice.stopCamShare(); else voice.startCamShare();
  });

  // Peer-row delegated click (open profile, contact actions, video popup)
  const _peersList = $('#peers-list');
  if (_peersList) _peersList.addEventListener('click', e => {
    const btn = e.target.closest('.pvbtn');
    if (btn) {
      e.stopPropagation();
      const vkey = btn.dataset.vkey;
      if (!vkey) return;
      const pid = vkey.split('|')[0];
      const v = state.peerVideos.get(pid)?.get(vkey);
      if (v && v.stream) voice.openScreenPopup(vkey, v.stream, v.label);
      return;
    }
    const ab = e.target.closest('.pabtn');
    if (ab) {
      e.stopPropagation();
      const act = ab.dataset.act, fp = ab.dataset.fp;
      if (act === 'add-contact')         peers.doAddContact(fp, ab.dataset.nick, ab.dataset.emoji);
      else if (act === 'remove-contact') peers.doRemoveContact(fp);
      else if (act === 'open-dm')        peers.doOpenDm(fp, ab.dataset.nick);
      return;
    }
    const row = e.target.closest('.peer');
    if (!row || row.classList.contains('me') || row.classList.contains('peer-sec-hd')) return;
    const key = row.dataset.key || '';
    let fp = '';
    if (key.startsWith('fp:')) {
      fp = key.slice(3);
    } else {
      const p = state.peers.get(key);
      fp = p?.fingerprint || '';
    }
    if (fp) peers.openProfile(fp);
  });
  // Right-click peer → admin panel (owner only)
  if (_peersList) _peersList.addEventListener('contextmenu', e => {
    if (!admin.isOwnerOfActiveRoom()) return;
    const row = e.target.closest('.peer');
    if (!row || row.classList.contains('me') || row.classList.contains('peer-sec-hd')) return;
    const key = row.dataset.key || '';
    let fp = '', nickname = '';
    if (key.startsWith('fp:')) {
      fp = key.slice(3);
      const rec = (state.roomRoster.get(state.state.activeRoom) || new Map()).get(fp);
      nickname = rec?.nickname || '';
    } else {
      const p = state.peers.get(key);
      fp = p?.fingerprint || '';
      nickname = p?.nickname || '';
    }
    if (!fp) return;
    const adm = state.roomAdminState.get(state.state.activeRoom);
    if (adm && adm.owner && adm.owner.fingerprint === fp) return;
    if (adm && fp === adm.myFingerprint) return;
    e.preventDefault();
    admin.openAdminPanel(fp, nickname);
  });

  // Contacts drawer
  const _contactsList = $('#contacts-list');
  if (_contactsList) _contactsList.addEventListener('click', e => {
    const ab = e.target.closest('.pabtn');
    if (ab) {
      e.stopPropagation();
      const act = ab.dataset.act, fp = ab.dataset.fp;
      if (act === 'c-dm')          peers.doOpenDm(fp, ab.dataset.nick);
      else if (act === 'c-invite') peers.openInviteOverlay(fp, ab.dataset.nick);
      else if (act === 'c-remove') peers.doRemoveContact(fp);
      return;
    }
    const row = e.target.closest('.peer');
    if (!row) return;
    const fp = row.dataset.fp;
    if (fp) peers.openProfile(fp);
  });
  const _toggleContactsBtn = $('#btn-toggle-contacts');
  if (_toggleContactsBtn) _toggleContactsBtn.addEventListener('click', () => {
    const dr = $('#contacts-drawer');
    if (!dr) return;
    dr.classList.toggle('hidden');
    _toggleContactsBtn.classList.toggle('active', !dr.classList.contains('hidden'));
    if (!dr.classList.contains('hidden')) peers.renderContacts();
  });
  const _closeContactsBtn = $('#btn-close-contacts');
  if (_closeContactsBtn) _closeContactsBtn.addEventListener('click', () => {
    $('#contacts-drawer').classList.add('hidden');
    if (_toggleContactsBtn) _toggleContactsBtn.classList.remove('active');
  });

  $('#btn-sv-close').addEventListener('click', () => {
    voice.closeAllScreenPopups();
    $('#screen-view').classList.add('hidden');
  });

  // Emoji picker (target msgId is set on the chat-module side when react is clicked)
  $$('.ep-emoji').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = window.__phEmojiTarget;
      if (target) chat.addReaction(target, btn.dataset.r, state.state.myNickname);
      window.__phEmojiTarget = null;
      $('#emoji-picker').classList.add('hidden');
    });
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.ep-emoji') && !e.target.closest('[data-a="react"]')) {
      $('#emoji-picker').classList.add('hidden');
    }
  });

  // Global keyboard shortcuts + Escape stack
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('#emoji-picker').classList.add('hidden');
      const qs = $('#qswitch-ov'); if (qs && !qs.classList.contains('hidden')) { rooms.closeQuickSwitcher(); return; }
      const sh = $('#shortcuts-ov'); if (sh && !sh.classList.contains('hidden')) { sh.classList.add('hidden'); return; }
      const pn = $('#pins-ov'); if (pn && !pn.classList.contains('hidden')) { pn.classList.add('hidden'); return; }
      const nn = $('#notifs-ov'); if (nn && !nn.classList.contains('hidden')) { toasts.closeNotifsPanel(); return; }
      const md = $('#mention-dd'); if (md && !md.classList.contains('hidden')) { chat.hideMentionDD(); return; }
      const pc = $('#prof-card-ov'); if (pc && !pc.classList.contains('hidden')) { peers.closeProfile(); return; }
      if (state.state.callScreenOpen) { voice.closeCallScreen(); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (mod) {
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); rooms.openQuickSwitcher(); return; }
      if (e.key === '/') { e.preventDefault(); $('#in-msg')?.focus(); return; }
      if (e.key === ',') { e.preventDefault(); $('#btn-settings').click(); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); $('#btn-add-room')?.click(); return; }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); $('#btn-toggle-peers')?.click(); return; }
      if ((e.key === 'C' || e.key === 'c') && e.shiftKey) { e.preventDefault(); $('#btn-toggle-contacts')?.click(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); rooms.stepRoom(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); rooms.stepRoom(-1); return; }
    }
    if (!inField) {
      if (e.key === '?') { e.preventDefault(); $('#shortcuts-ov').classList.remove('hidden'); return; }
    }
    if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
      const n = parseInt(e.key, 10);
      const codes = [...state.roomData.keys()];
      if (codes[n - 1]) { e.preventDefault(); rooms.switchRoom(codes[n - 1]); }
    }
  });

  // Shortcut overlay
  $('#btn-close-shortcuts')?.addEventListener('click', () => $('#shortcuts-ov').classList.add('hidden'));
  $('#shortcuts-ov .ov-bg')?.addEventListener('click', () => $('#shortcuts-ov').classList.add('hidden'));

  // Notification center
  $('#btn-notifs')?.addEventListener('click', () => toasts.openNotifsPanel());
  $('#btn-close-notifs')?.addEventListener('click', () => toasts.closeNotifsPanel());
  $('#notifs-ov .ov-bg')?.addEventListener('click', () => toasts.closeNotifsPanel());
  $('#btn-clear-notifs')?.addEventListener('click', () => toasts.clearAllNotifs());
  $('#notifs-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('.notif-row');
    if (!row) return;
    const id  = row.dataset.nid;
    if (e.target.closest('[data-act="dismiss"]')) { e.stopPropagation(); toasts.dismissNotif(id); return; }
  });
  toasts.init();

  // Settings overlay
  $('#btn-settings').addEventListener('click', () => {
    const s = state.state;
    $('#settings').classList.remove('hidden');
    $('#set-nick').value   = s.myNickname;
    $('#set-status').value = s.statusText;
    refreshAvatarPreview();
    $$('.cd').forEach(d => d.classList.toggle('act', d.dataset.c === s.accentColor));
    $$('.so').forEach(b => b.classList.toggle('act', parseFloat(b.dataset.s) === s.fontScale));
    $$('.dopt').forEach(b => b.classList.toggle('act', b.dataset.d === s.density));
    $$('.bopt').forEach(b => b.classList.toggle('act', b.dataset.b === s.bubble));
    $$('.bgop').forEach(b => b.classList.toggle('act', b.dataset.bg === s.chatBg));
    $$('.topt').forEach(b => b.classList.toggle('act', b.dataset.t === s.timeFormat));
    $$('.edot').forEach(b => b.classList.toggle('act', b.dataset.e === s.avatarEmoji));
    $$('.nopt').forEach(b => b.classList.toggle('act', b.dataset.n === s.notifSound));
    $$('.ntop').forEach(b => b.classList.toggle('act', b.dataset.nt === s.desktopNotifs));
    $$('.mentop').forEach(b => b.classList.toggle('act', b.dataset.ment === s.mentionToasts));
    $$('.automop').forEach(b => b.classList.toggle('act', b.dataset.am === s.vcAutoMute));
    $$('.ngop').forEach(b => b.classList.toggle('act', b.dataset.ng === s.noiseGate));
    $$('.apop').forEach(b => b.classList.toggle('act', b.dataset.ap === s.audioProfile));
    $$('.arop').forEach(b => b.classList.toggle('act', b.dataset.ar === s.audioRedundancy));
    $$('.alop').forEach(b => b.classList.toggle('act', b.dataset.al === s.audioLatency));
    $$('.dnop').forEach(b => b.classList.toggle('act', b.dataset.dn === s.denoise));
    $$('.mvop').forEach(b => b.classList.toggle('act', b.dataset.mv === s.meshVoice));
    $$('.vrop').forEach(b => b.classList.toggle('act', b.dataset.vr === s.voiceRoute));
    $$('.mbop').forEach(b => b.classList.toggle('act', b.dataset.mb === s.meshBuffer));
    $$('.mrop').forEach(b => b.classList.toggle('act', b.dataset.mr === s.meshRedundancy));
    $$('.msop').forEach(b => b.classList.toggle('act', b.dataset.ms === s.meshSpacing));
    $$('.rmop').forEach(b => b.classList.toggle('act', b.dataset.rm === s.reduceMotion));
    $$('.hcop').forEach(b => b.classList.toggle('act', b.dataset.hc === s.highContrast));
    $$('.ltop').forEach(b => b.classList.toggle('act', b.dataset.lt === s.largeTargets));
    $$('.adopt').forEach(b => b.classList.toggle('act', b.dataset.ad === s.autoDownload));
    $$('.tyop').forEach(b => b.classList.toggle('act', b.dataset.ty === s.sendTypingPref));
    $$('.lpop').forEach(b => b.classList.toggle('act', b.dataset.lp === s.linkPreview));
    $$('.lyop').forEach(b => b.classList.toggle('act', b.dataset.ly === s.msgLayout));
    $$('.ibop').forEach(b => b.classList.toggle('act', b.dataset.ib === s.inbox));
    $$('.lsop').forEach(b => b.classList.toggle('act', b.dataset.ls === (s.lockOnSleep || 'off')));
    $$('.ctop').forEach(b => b.classList.toggle('act', b.dataset.ct === (s.coverTraffic || 'off')));
    $$('.nbop').forEach(b => b.classList.toggle('act', b.dataset.nb === (s.nearby || 'off')));
    $$('.ecop').forEach(b => b.classList.toggle('act', b.dataset.ec === (s.echoes || 'off')));
    $$('.rlop').forEach(b => b.classList.toggle('act', b.dataset.rl === (s.relays || 'auto')));
    $$('.rvop').forEach(b => b.classList.toggle('act', b.dataset.rv === (s.relayVolunteer || 'off')));
    $$('.ihop').forEach(b => b.classList.toggle('act', b.dataset.ih === (s.inviteHintsMode || 'on')));
    $('#entry-points').value = s.entryPoints || '';
    $('#bridge-url').value = s.bridge || '';
    $('#bridge-port').value = s.bridgeServe ? String(s.bridgeServe) : '';
    refreshPathStatus();
    $$('.sjop').forEach(b => b.classList.toggle('act', b.dataset.sj === String(s.sendJitter || 0)));
    $$('.alop').forEach(b => b.classList.toggle('act', b.dataset.al === String(s.autoLockMin || 0)));
    $$('.phop').forEach(b => b.classList.toggle('act', b.dataset.ph === (s.panicHotkey || 'off')));
    refreshLockUi();
    $$('.cpop').forEach(b => b.classList.toggle('act', b.dataset.cp === s.contentProtection));
    peers.renderBlocklist();
  });
  $$('.set-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      $$('.set-tab').forEach(b => b.classList.toggle('act', b === btn));
      $$('.set-panel').forEach(p => p.classList.toggle('act', p.dataset.tab === target));
      if (target === 'privacy') peers.renderBlocklist();
    });
  });

  // Avatar upload / clear
  $('#btn-avatar-upload')?.addEventListener('click', () => $('#avatar-file').click());
  $('#btn-avatar-clear')?.addEventListener('click', async () => {
    state.state.avatarImage = '';
    try { await window.sirr.updateConfig({ avatarImage: '' }); } catch (e) {}
    refreshAvatarPreview();
    if (peers.updateMyAvatarCells) peers.updateMyAvatarCells();
  });
  $('#avatar-file')?.addEventListener('change', function () {
    const f = this.files && this.files[0];
    this.value = '';
    if (!f || !f.type.startsWith('image/')) return;
    if (f.size > 4 * 1024 * 1024) {
      toasts.showToast({ type: 'warn', title: 'IMAGE TOO LARGE', body: 'Pick an image under 4 MB.', ttl: 3500 });
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = async () => {
        const SZ = 128;
        const c = document.createElement('canvas');
        c.width = SZ; c.height = SZ;
        const ctx = c.getContext('2d');
        const src = Math.min(img.width, img.height);
        const sx = (img.width  - src) / 2;
        const sy = (img.height - src) / 2;
        ctx.drawImage(img, sx, sy, src, src, 0, 0, SZ, SZ);
        state.state.avatarImage = c.toDataURL('image/jpeg', 0.85);
        try { await window.sirr.updateConfig({ avatarImage: state.state.avatarImage }); } catch (e) {}
        refreshAvatarPreview();
        if (peers.updateMyAvatarCells) peers.updateMyAvatarCells();
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(f);
  });

  $('#btn-close-set').addEventListener('click', closeSets);
  $('#settings .ov-bg').addEventListener('click', closeSets);

  $('#set-nick')?.addEventListener('input', scheduleProfileCommit);
  $('#set-status')?.addEventListener('input', scheduleProfileCommit);
  $('#set-nick')?.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(_profileTimer); commitProfile(); } });

  // Sigil editor (Settings → Identity)
  let _sigilEd = null;
  const mountSigil = () => {
    const sgRoot = $('#sigil-editor');
    if (!sgRoot) return;
    if (_sigilEd) { _sigilEd.refresh(); return; }
    _sigilEd = mountSigilEditor(sgRoot, {
      name: () => state.state.myNickname,
      fingerprint: () => state.state.myFingerprint,
      value: state.state.avatarPixels,
      onSave: (px) => {
        state.state.avatarPixels = px;
        glyphs.setPixels(state.state.myFingerprint, px);
        try { window.sirr.updateConfig({ avatarPixels: px }); } catch (e) {}
        peers.updateMyAvatarCells(); refreshAvatarPreview();
        chat.refreshAuthor(state.state.myFingerprint, { nickname: state.state.myNickname, avatarPixels: px });
      },
    });
  };
  $('#btn-settings').addEventListener('click', mountSigil);

  bindLockUi();

  // Mic check
  $('#btn-mic-test')?.addEventListener('click', async (e) => {
    const b = e.currentTarget, m = $('#mic-test-meter'), d = $('#mic-test-db');
    if (voice.micTestRunning()) { voice.stopMicTest(m, d); b.textContent = 'TEST MIC'; b.classList.remove('act'); return; }
    const r = await voice.startMicTest(m, d);
    if (r.ok) { b.textContent = 'STOP'; b.classList.add('act'); }
  });

  // Export / import
  $('#btn-export-data')?.addEventListener('click', async () => {
    try {
      const r = await window.sirr.exportAllData($('#backup-pass')?.value || '');
      if (r && r.ok) {
        toasts.showToast({ type: 'success', title: 'EXPORTED', body: 'Sealed backup saved. Without the passphrase it cannot be opened — by anyone, including you.', ttl: 5000 });
        if ($('#backup-pass')) $('#backup-pass').value = '';
      }
      else if (r && !r.cancelled) toasts.showToast({ type: 'warn', title: 'EXPORT FAILED', body: esc(r.error || 'unknown error'), ttl: 4000 });
    } catch (e) {
      toasts.showToast({ type: 'warn', title: 'EXPORT FAILED', body: esc(e.message || 'unknown'), ttl: 4000 });
    }
  });
  $('#btn-import-data')?.addEventListener('click', () => {
    toasts.showToast({
      type: 'action',
      title: 'IMPORT BACKUP',
      body: 'This will <b>replace</b> your current identity, rooms, and history. Sirr will need to be restarted.',
      actions: [
        { label: 'Cancel', onClick: c => c() },
        { label: 'Import', primary: true, onClick: async c => {
            c();
            try {
              const r = await window.sirr.importAllData($('#backup-pass')?.value || '');
              if (r && r.ok) {
                toasts.showToast({
                  type: 'success', title: 'IMPORTED',
                  body: 'Restart Sirr now to finish applying the backup.',
                  ttl: 8000,
                });
              } else if (r && !r.cancelled) {
                toasts.showToast({ type: 'warn', title: 'IMPORT FAILED', body: esc(r.error || 'unknown'), ttl: 4500 });
              }
            } catch (e) {
              toasts.showToast({ type: 'warn', title: 'IMPORT FAILED', body: esc(e.message || 'unknown'), ttl: 4500 });
            }
          } },
      ],
    });
  });

  // Settings option toggles — store on state.state and persist via sirr IPC.
  const s = state.state;
  $$('.cd').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.c;
    $$('.cd').forEach(x => x.classList.toggle('act', x === b));
    s.accentColor = v; applyAccent(v);
    try { window.sirr.updateConfig({ accentColor: v }); } catch (e) {}
  }));
  opt('.so',    'fontScale',    v => { s.fontScale = v;   applyFont(v); },          b => parseFloat(b.dataset.s));
  opt('.dopt',  'density',      v => { s.density = v;     applyDensity(v); },       b => b.dataset.d);
  opt('.lyop',  'msgLayout',    v => { s.msgLayout = v;   applyLayout(v); },        b => b.dataset.ly);
  opt('.bopt',  'bubble',       v => { s.bubble = v;      applyBubble(v); },        b => b.dataset.b);
  opt('.bgop',  'chatBg',       v => { s.chatBg = v;      applyChatBg(v); },        b => b.dataset.bg);
  opt('.topt',  'timeFormat',   v => { s.timeFormat = v; },                          b => b.dataset.t);
  opt('.nopt',  'notifSound',   v => { s.notifSound = v; },                          b => b.dataset.n);
  opt('.edot',  'avatarEmoji',  v => {
    s.avatarEmoji = v; refreshAvatarPreview();
    if (peers.updateMyAvatarCells) peers.updateMyAvatarCells();
  }, b => b.dataset.e);
  opt('.adopt', 'autoDownload', v => { s.autoDownload = v; },                        b => b.dataset.ad);
  opt('.ntop',  'desktopNotifs',v => { s.desktopNotifs = v; },                       b => b.dataset.nt);
  opt('.mentop','mentionToasts',v => { s.mentionToasts = v; },                       b => b.dataset.ment);
  opt('.automop','vcAutoMute',  v => { s.vcAutoMute = v; },                          b => b.dataset.am);
  opt('.ngop',  'noiseGate',    v => { s.noiseGate = v; },                           b => b.dataset.ng);
  // ─ Audio engine ─
  opt('.apop',  'audioProfile', v => { s.audioProfile = v; audioEngine.renderHud(); }, b => b.dataset.ap);
  // Redundancy and latency are applied per-connection, so a change takes
  // effect on the next renegotiation / next call rather than instantly.
  opt('.arop',  'audioRedundancy', v => { s.audioRedundancy = v; audioEngine.renderHud(); }, b => b.dataset.ar);
  opt('.alop',  'audioLatency',    v => {
    s.audioLatency = v;
    // This one CAN be applied live — retune every open receiver.
    try { for (const [, c] of state.voiceConns) audioEngine.tuneAllReceivers(c.pc); } catch (e) {}
  }, b => b.dataset.al);
  opt('.dnop',  'denoise', v => {
    s.denoise = v;
    // Instant A/B while in a call; the full chain rebuilds on next join.
    denoise.setEnabled(v === 'on');
    if (v === 'on' && !denoise.isSupported()) {
      toasts.showToast({
        type: 'warn',
        title: 'DENOISE UNAVAILABLE',
        body: 'This build cannot run the neural suppressor. Your raw microphone will be used.',
        ttl: 6000,
      });
    }
    audioEngine.renderHud();
  }, b => b.dataset.dn);
  // ─ Mesh voice ─
  opt('.mvop', 'meshVoice', v => {
    s.meshVoice = v;
    if (v === 'on') {
      // Probe for real rather than trusting that the APIs merely exist.
      mesh.selfTest().then(r => {
        if (r.supported && r.encoder && r.decoder) return;
        toasts.showToast({
          type: 'warn',
          title: 'MESH VOICE UNAVAILABLE',
          body: r.error || 'This build cannot encode Opus through WebCodecs. Standard voice will be used.',
          ttl: 8000,
        });
      });
    }
  }, b => b.dataset.mv);
  opt('.vrop', 'voiceRoute',      v => { s.voiceRoute = v; },                         b => b.dataset.vr);
  opt('.mbop', 'meshBuffer',      v => { s.meshBuffer = v; mesh.setBufferPreset(v); }, b => b.dataset.mb);
  opt('.mrop', 'meshRedundancy',  v => { s.meshRedundancy = v; },                     b => b.dataset.mr);
  opt('.msop', 'meshSpacing',     v => { s.meshSpacing = v; },                        b => b.dataset.ms);
  opt('.rmop',  'reduceMotion', v => { s.reduceMotion = v; applyA11y(); },           b => b.dataset.rm);
  opt('.hcop',  'highContrast', v => { s.highContrast = v; applyA11y(); },           b => b.dataset.hc);
  opt('.ltop',  'largeTargets', v => { s.largeTargets = v; applyA11y(); },           b => b.dataset.lt);
  opt('.tyop',  'sendTyping',   v => { s.sendTypingPref = v; },                      b => b.dataset.ty);
  opt('.lpop',  'linkPreview',  v => { s.linkPreview = v; },                         b => b.dataset.lp);
  opt('.ibop',  'inbox',        v => { s.inbox = v; },                               b => b.dataset.ib);
  opt('.cpop',  'contentProtection', v => { s.contentProtection = v; },               b => b.dataset.cp);
  opt('.lsop',  'lockOnSleep',  v => { s.lockOnSleep = v; },                         b => b.dataset.ls);
  opt('.ctop',  'coverTraffic', v => { s.coverTraffic = v; },                        b => b.dataset.ct);
  opt('.ecop',  'echoes',       v => { s.echoes = v; },                              b => b.dataset.ec);
  opt('.nbop',  'nearby',       v => { s.nearby = v; setTimeout(refreshPathStatus, 1500); }, b => b.dataset.nb);
  opt('.rlop',  'relays',       v => { s.relays = v; },                              b => b.dataset.rl);
  opt('.rvop',  'relayVolunteer', v => { s.relayVolunteer = v; setTimeout(refreshPathStatus, 3000); }, b => b.dataset.rv);
  $$('.ihop').forEach(b => b.addEventListener('click', () => {
    $$('.ihop').forEach(x => x.classList.toggle('act', x === b));
    s.inviteHintsMode = b.dataset.ih;
    try { window.sirr.updateConfig({ inviteHints: b.dataset.ih === 'off' ? 'off' : 'on', inviteBridge: b.dataset.ih === 'bridge' ? 'on' : 'off' }); } catch (e) {}
  }));
  const saveText = (sel, key, clean) => $(sel)?.addEventListener('change', () => {
    const v = clean($(sel).value);
    s[key] = v;
    try { window.sirr.updateConfig({ [key]: v }); } catch (e) {}
    $('#btn-path-restart')?.classList.add('act');
  });
  saveText('#entry-points', 'entryPoints', v => String(v || '').split(/[\s,]+/).filter(x => /:\d{2,5}$/.test(x)).slice(0, 32).join(', '));
  saveText('#bridge-url', 'bridge', v => /^wss?:\/\/\S+$/i.test(String(v || '').trim()) ? String(v).trim() : '');
  saveText('#bridge-port', 'bridgeServe', v => { const n = parseInt(v, 10); return n > 1023 && n < 65536 ? n : 0; });
  $('#btn-path-restart')?.addEventListener('click', () => window.sirr.restartApp?.());
  opt('.sjop',  'sendJitter',   v => { s.sendJitter = v; },                          b => Number(b.dataset.sj));
  opt('.alop',  'autoLockMin',  v => { s.autoLockMin = v; },                         b => Number(b.dataset.al));
  opt('.phop',  'panicHotkey',  v => { s.panicHotkey = v; },                         b => b.dataset.ph);
}

// ─── NETWORK EVENTS ──────────────────────────────────────────────
function wireNetwork() {
  window.sirr.onMessage(async m => {
    const room = m.room;
    if (!room) return;
    if (room.startsWith('DM') && !state.roomData.has(room)) {
      if (m.dmRequest) {
        // not a contact → a message request. Register it WITHOUT
        // opening (opening = accepting); the user decides from the bar.
        state.roomData.set(room, {
          messages: [], unread: 0, name: m.nickname || 'Message request',
          isDm: true, dmPeer: { fingerprint: m.fingerprint, nickname: m.nickname }, request: true,
        });
        if (!state.roomPeers.has(room)) state.roomPeers.set(room, new Set());
        rooms.ensureChannelsMap(room);
        rooms.renderRail();
        toasts.showToast({ type: 'info', title: 'MESSAGE REQUEST', body: (m.nickname || 'Someone') + ' wants to message you', ttl: 6000 });
      } else {
        const opened = await peers.doOpenDm(m.fingerprint, m.nickname, { silent: true });
        if (opened !== room) return;
      }
    }
    chat.pushMsg(room, {
      peerId: m.peerId, nickname: m.nickname, content: m.content,
      type: m.type || 'text', timestamp: m.timestamp, msgId: m.msgId,
      self: false, fingerprint: m.fingerprint, replyTo: m.replyTo,
      channel: m.channel || 'default',
      fileName: m.fileName, fileSize: m.fileSize,
      sync: !!m.sync,
    });
    if (!m.sync) {
      beep();
      if (document.visibilityState === 'hidden' && state.state.desktopNotifs !== 'off') {
        const mentionsMeHere = m.type === 'text' && typeof m.content === 'string'
          && chat.renderMentionsInText(m.content).mentionsMe;
        const allow = state.state.desktopNotifs === 'all' || (state.state.desktopNotifs === 'mentions' && mentionsMeHere);
        if (allow) {
          // Discreet on purpose: OS notifications can show on a locked
          // screen and are kept in the system's notification history, so
          // they never carry a sender, a room name or message text.
          if (Notification.permission === 'default') Notification.requestPermission();
          if (Notification.permission === 'granted') {
            new Notification('Sirr', { body: 'New message', icon: '../assets/icon.png', silent: true });
          }
        }
      }
    }
  });

  window.sirr.onPeerJoined(p => {
    state.peers.set(p.peerId, { ...p });
    glyphs.setPixels(p.fingerprint, p.avatarPixels);
    const roomsList = Array.isArray(p.rooms) && p.rooms.length
      ? p.rooms
      : (state.state.activeRoom ? [state.state.activeRoom] : []);
    for (const room of roomsList) peers.addPeerToRoom(room, p.peerId);
    if (p.fingerprint && state.contacts.has(p.fingerprint)) {
      const c = state.contacts.get(p.fingerprint);
      c.nickname = p.nickname || c.nickname;
      c.avatarEmoji = p.avatarEmoji || c.avatarEmoji;
      c.lastSeenAt = Date.now();
      peers.renderContacts();
    }
    peers.updatePeers();
    peers.updateStats();
    if (state.state.activeRoom && roomsList.includes(state.state.activeRoom)) {
      chat.sysMsg(p.nickname + ' connected');
    }
    voice.handleNewPeer(p, roomsList);
    beep();
  });

  window.sirr.onPeerUpdated(p => {
    const ex = state.peers.get(p.peerId);
    const wasInActive = ex && (ex.rooms || []).includes(state.state.activeRoom);
    // Profile changes land everywhere at once: chat rows, ledger, rail,
    // contacts, voice list — no reconnect, no restart.
    const renamed = ex && p.nickname && ex.nickname && ex.nickname !== p.nickname;
    const repictured = ex && ((p.avatarEmoji !== undefined && p.avatarEmoji !== ex.avatarEmoji) || (p.avatarPixels !== undefined && p.avatarPixels !== ex.avatarPixels));
    if (renamed && (ex.rooms || []).includes(state.state.activeRoom)) chat.sysMsg(ex.nickname + ' is now known as ' + p.nickname);
    if (ex) {
      ex.nickname = p.nickname;
      if (p.avatarEmoji !== undefined) ex.avatarEmoji = p.avatarEmoji;
      if (p.avatarPixels !== undefined) ex.avatarPixels = p.avatarPixels;
      if (p.status)     ex.status = p.status;
      if (p.statusText !== undefined) ex.statusText = p.statusText;
      if (Array.isArray(p.rooms)) {
        ex.rooms = p.rooms;
        for (const room of p.rooms) peers.addPeerToRoom(room, p.peerId);
        for (const [room, set] of state.roomPeers) {
          if (set.has(p.peerId) && !p.rooms.includes(room)) set.delete(p.peerId);
        }
      }
    } else if (Array.isArray(p.rooms)) {
      state.peers.set(p.peerId, { ...p });
      for (const room of p.rooms) peers.addPeerToRoom(room, p.peerId);
    }
    const nowInActive = Array.isArray(p.rooms) && p.rooms.includes(state.state.activeRoom);
    if (state.state.activeRoom && !wasInActive && nowInActive) {
      chat.sysMsg((p.nickname || p.peerId) + ' connected');
    }
    if (p.avatarPixels !== undefined) glyphs.setPixels(p.fingerprint, p.avatarPixels);
    if (renamed || repictured) {
      chat.refreshAuthor(p.fingerprint, { nickname: p.nickname, avatarEmoji: p.avatarEmoji, avatarPixels: p.avatarPixels });
      for (const [, rd] of state.roomData) if (rd.isDm && rd.dmPeer && rd.dmPeer.fingerprint === p.fingerprint) { rd.dmPeer.nickname = p.nickname; rd.name = p.nickname; }
      rooms.renderRail();
      try { peers.loadContacts().then(() => peers.renderContacts()); } catch (e) {}
      try { voice.renderVoicePresence(); voice.updateVoiceUI(); } catch (e) {}
    }
    peers.updatePeers();
  });

  window.sirr.onPeerLeft(p => {
    state.peers.delete(p.peerId);
    peers.removePeerFromAll(p.peerId);
    chat.clearTypingFor(p.peerId);
    voice.handlePeerLeft(p.peerId);
    peers.updateStats();
    if (p.fingerprint && state.contacts.has(p.fingerprint)) peers.renderContacts();
    if (state.state.activeRoom && p.rooms && p.rooms.includes(state.state.activeRoom)) {
      chat.sysMsg(p.nickname + ' left');
    }
  });

  window.sirr.onRoomJoined(() => {});
  window.sirr.onCryptoError(i => { if (state.state.activeRoom) chat.sysMsg('⚠ ' + i.error); });
  window.sirr.onPeerTyping(i => {
    const ch = i.channel || 'default';
    if (i.room === state.state.activeRoom && ch === state.state.activeTextChannel) {
      chat.showTyping(i.peerId, i.nickname);
    }
    if (i.room) peers.addPeerToRoom(i.room, i.peerId);
  });

  window.sirr.onVoiceSignal(i => voice.handleVoiceSignal(i));
  if (window.sirr.onVoiceMedia) window.sirr.onVoiceMedia(i => voice.handleVoiceMedia(i));
  if (window.sirr.onFileEvent) window.sirr.onFileEvent(e => voice.handleFileEvent(e));
  if (window.sirr.onCharterConflict) window.sirr.onCharterConflict(i => {
    chat.sysMsg('⚠ ' + (i.nickname || 'A member') + ' (' + String(i.claimant || '').slice(0, 9) + ') claims to own this room. Keeping the owner you already know.', i.room);
  });
  window.sirr.onFileTransfer(ft => {
    if (ft.room && ft.peerId) peers.addPeerToRoom(ft.room, ft.peerId);
    voice.handleFileTransfer(ft);
  });

  // Room moves (rekey / eviction): the old room becomes a read-only archive.
  const onRoomMoved = async (d) => {
    if (!d || !d.from || !d.to) return;
    const old = state.roomData.get(d.from);
    if (old) old.moved = d.to;
    await rooms.addRoom(d.to, d.name || old?.name || '');
    chat.sysMsg(d.mine
      ? 'room moved to a fresh code' + (d.evicted ? ' — ' + d.evicted + ' left behind' : '') + '. This one is an archive now.'
      : 'the owner moved this room to a fresh code' + (d.evicted ? ' (' + d.evicted + ' removed)' : '') + '. This one is an archive now.', d.from);
    chat.sysMsg('moved here from the old code', d.to);
    if (state.state.activeRoom === d.from) rooms.switchRoom(d.to);
    rooms.renderRail();
  };
  window.addEventListener('sirr:room-moved', e => onRoomMoved(e.detail));
  window.sirr.onRoomMoved?.(onRoomMoved);
  window.sirr.onRoomMovePending?.(d => {
    chat.sysMsg('a member says this room moved, but it couldn\'t be verified (' + (d.why || '?') + '). Waiting for the owner.', d.room);
  });

  window.sirr.onClockSkew?.(d => {
    const m = Math.abs(Math.round(d.minutes));
    toasts.showToast({ type: 'warn', title: 'CLOCK IS OFF',
      body: 'Your clock is about ' + (m >= 90 ? Math.round(m / 60) + ' h' : m + ' min') + (d.minutes > 0 ? ' behind' : ' ahead of') + ' your peers. Rooms meet by the hour — fix the system clock or you may stop finding people.',
      ttl: 12000 });
  });

  window.sirr.onRoomRenamed(i => {
    if (!state.roomData.has(i.room)) return;
    const rd = state.roomData.get(i.room);
    if (rd.name === i.newName) return;
    rd.name = i.newName;
    if (state.state.activeRoom === i.room) {
      $('#sb-room-label').textContent = i.newName;
      $('#sb-room-label').classList.remove('untitled');
      const ch = rd.channels?.get(state.state.activeTextChannel);
      $('#tb-room').textContent = i.newName + (ch ? ' · ' + ch.name : '');
    }
    rooms.renderRail();
    if (!i.silent) chat.sysMsg('Room renamed to "' + i.newName + '"');
  });

  window.sirr.onChannelCreated(i => {
    if (!state.roomData.has(i.room)) return;
    rooms.absorbChannels(i.room, [i.channel]);
    if (state.state.activeRoom === i.room) rooms.renderChannels();
    if (!i.silent) chat.sysMsg('+ ' + (i.channel.kind === 'voice' ? '♪' : '#') + ' ' + i.channel.name);
  });
  window.sirr.onChannelRenamed(i => {
    const rd = state.roomData.get(i.room); if (!rd || !rd.channels) return;
    const ch = rd.channels.get(i.channelId); if (!ch) return;
    if (ch.name === i.newName) return;
    ch.name = i.newName;
    if (state.state.activeRoom === i.room) {
      rooms.renderChannels();
      if (i.channelId === state.state.activeTextChannel) $('#tb-room').textContent = i.newName;
    }
  });
  window.sirr.onChannelDeleted(i => {
    const rd = state.roomData.get(i.room); if (!rd || !rd.channels) return;
    if (i.channelId === 'default') return;
    const ch = rd.channels.get(i.channelId); if (!ch) return;
    rd.channels.delete(i.channelId);
    if (state.state.activeRoom === i.room && state.state.activeTextChannel === i.channelId) {
      rooms.switchTextChannel('default');
    }
    if (state.state.voiceOn && state.state.voiceRoom === i.room && state.state.voiceChannel === i.channelId) {
      voice.leaveVoice();
    }
    if (state.state.activeRoom === i.room) rooms.renderChannels();
  });
  window.sirr.onChannelsSync(i => {
    if (!state.roomData.has(i.room)) return;
    rooms.absorbChannels(i.room, i.channels);
    if (state.state.activeRoom === i.room) rooms.renderChannels();
  });

  // Deep link. A sirr:// link comes from outside the app (a browser, a
  // chat, a redirect), so it never joins by itself: joining announces you
  // to the room's members and lets them connect to you directly. Codes the
  // user types or pastes in the app still join at once.
  const confirmLinkJoin = (code) => new Promise((resolve) => {
    const ov = $('#link-join-ov');
    if (!ov) return resolve(false);
    $('#link-join-code').textContent = code;
    ov.classList.remove('hidden');
    const done = (yes) => {
      ov.classList.add('hidden');
      for (const [el, fn] of hs) el && el.removeEventListener('click', fn);
      document.removeEventListener('keydown', onKey, true);
      resolve(yes);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const hs = [[$('#btn-linkjoin-yes'), () => done(true)], [$('#btn-linkjoin-no'), () => done(false)],
                [$('#btn-close-linkjoin'), () => done(false)], [$('#link-join-ov .ov-bg'), () => done(false)]];
    for (const [el, fn] of hs) el && el.addEventListener('click', fn);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => $('#btn-linkjoin-no')?.focus(), 0);
  });
  window.sirr.onDeepLinkJoin(async (d) => {
    if (!d || !d.code) return;
    const v = await validateCodeLocal(d.code);
    if (!v.ok) {
      toasts.showToast({ type: 'warn', title: 'BAD INVITE LINK', body: codeReasonMsg(v.reason), ttl: 4000 });
      return;
    }
    const code = v.code;
    if (state.roomData.has(code)) {
      rooms.switchRoom(code);
      return;
    }
    if (!(await confirmLinkJoin(code))) return;
    if (state.roomData.has(code)) { rooms.switchRoom(code); return; }
    if ($('#chat-screen') && !$('#chat-screen').classList.contains('active')) {
      firstJoin(code);
    } else {
      const ok = await rooms.addRoom(code);
      if (ok) {
        rooms.switchRoom(code);
      } else {
        toasts.showToast({ type: 'warn', title: 'JOIN FAILED', body: 'Could not join via link.', ttl: 3500 });
      }
    }
  });

  // Pin events
  window.sirr.onPinToggle(i => {
    if (!i || !i.room || !i.msgId) return;
    const set = chat.getPinnedSet(i.room, i.channel || 'default');
    if (i.pinned) set.set(i.msgId, { preview: i.preview || '', nick: i.nick || '', ts: i.ts || Date.now() });
    else set.delete(i.msgId);
    if (i.room === state.state.activeRoom && (i.channel || 'default') === state.state.activeTextChannel) {
      const el = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(i.msgId) + '"]');
      if (el) el.classList.toggle('pinned', !!i.pinned);
      const pn = $('#pins-ov');
      if (pn && !pn.classList.contains('hidden')) chat.renderPinsPanel();
      chat.updatePinsCountBadge();
    }
    if (!i.silent && i.pinned) {
      toasts.showToast({ type: 'info', title: 'PINNED',
        body: '<b>' + esc(i.nick || '?') + '</b> pinned a message.', ttl: 2800 });
    }
  });
  window.sirr.onPinsSync(i => {
    if (!i || !i.room || !Array.isArray(i.pins)) return;
    const set = chat.getPinnedSet(i.room, i.channel || 'default');
    for (const p of i.pins) {
      if (!p || !p.msgId) continue;
      if (set.has(p.msgId)) continue;
      set.set(p.msgId, { preview: p.preview || '', nick: p.nick || '', ts: p.ts || 0 });
    }
    if (i.room === state.state.activeRoom && (i.channel || 'default') === state.state.activeTextChannel) {
      const pn = $('#pins-ov');
      if (pn && !pn.classList.contains('hidden')) chat.renderPinsPanel();
      chat.updatePinsCountBadge();
      for (const p of i.pins) {
        const el = document.querySelector('#messages .tx[data-msgid="' + CSS.escape(p.msgId) + '"]');
        if (el) el.classList.add('pinned');
      }
    }
  });

  // Room ownership / admin
  window.sirr.onRoomCharter(async i => {
    if (!i || !i.room) return;
    await admin.fetchRoomAdmin(i.room);
    if (i.room === state.state.activeRoom) peers.updatePeers();
  });
  window.sirr.onAdminUpdate(async i => {
    if (!i || !i.room) return;
    await admin.fetchRoomAdmin(i.room);
    if (i.room === state.state.activeRoom) peers.updatePeers();
  });
  window.sirr.onAdminSync(async i => {
    if (!i || !i.room) return;
    await admin.fetchRoomAdmin(i.room);
    if (i.room === state.state.activeRoom) peers.updatePeers();
  });

  // Message edits + authoritative deletes (peer broadcasts AND echoes of
  // our own writes — the chat module's apply* helpers are idempotent).
  window.sirr.onMessageEdited(i => chat.applyMessageEdit(i));
  window.sirr.onMessageDeletedForAll(i => chat.applyMessageDeleteForAll(i));
  window.sirr.onMessagesExpired(list => chat.applyMessagesExpired(list));

  // Contact-add notification
  window.sirr.onContactAdd(i => {
    if (!i || !i.fingerprint) return;
    const nick = i.nickname || i.fingerprint.slice(0, 8);
    if (state.contacts.has(i.fingerprint)) {
      const c = state.contacts.get(i.fingerprint);
      c.nickname = nick; c.avatarEmoji = i.avatarEmoji || c.avatarEmoji || '';
      c.lastSeenAt = Date.now();
      peers.renderContacts();
      return;
    }
    toasts.showToast({
      type: 'action',
      title: 'CONTACT REQUEST',
      body: '<b>' + esc(nick) + '</b> has added you.',
      id: 'contact-add-' + i.fingerprint,
      actions: [
        { label: 'Add back', primary: true, onClick: (close) => {
            peers.doAddContact(i.fingerprint, nick, i.avatarEmoji);
            close();
          } },
        { label: 'Ignore', onClick: (close) => close() },
      ],
    });
    beep();
  });
}

// ─── Join-screen key plate (v7) ──────────────────────────────────
// Renders the identity three ways: hex dump, randomart, grouped
// fingerprint. Uses the public key when the bridge exposes one, else
// the fingerprint bytes — and labels the plate with which it is.
function renderKeyPlate(identity) {
  try {
    const pk = identity && (identity.publicKeyHex || identity.publicKey);
    const pkBytes = (typeof pk === 'string' && /^[0-9a-fA-F:\s-]+$/.test(pk)) ? glyphs.hexBytes(pk) : [];
    const fpBytes = glyphs.hexBytes(identity && identity.fingerprint);
    const bytes = pkBytes.length >= 16 ? pkBytes.slice(0, 32) : fpBytes.slice(0, 32);
    if (!bytes.length) return;
    const lbl = $('#join-key-label');
    if (lbl) lbl.textContent = (pkBytes.length >= 16 ? 'Public key' : 'Identity fingerprint') + ' · ' + bytes.length + ' B';
    const hex = $('#join-hex');
    if (hex) hex.innerHTML = glyphs.hexDumpHtml(bytes);
    const art = $('#join-art');
    if (art) art.innerHTML = glyphs.randomart(fpBytes.length ? fpBytes : bytes, 'X25519', 'SHA256');
    const big = $('#join-fp-big');
    if (big) {
      const g = glyphs.fpGroups(identity.fingerprint, 4);
      big.innerHTML = g.map((x, i) => i === g.length - 1 ? '<b>' + x + '</b>' : x).join(' ');
    }
  } catch (e) { console.warn('[keyplate]', e); }
}

// ─── Boot ────────────────────────────────────────────────────────
async function boot() {
  try {
    try {
      const ver = await window.sirr.getVersion();
      const v = 'v' + String(ver || '').trim();
      ['#ver-ledger', '#ver-brand', '#ver-about'].forEach(sel => {
        const el = $(sel);
        if (!el) return;
        if (sel === '#ver-ledger') el.textContent = 'SIRR · ' + v;
        else el.textContent = v;
      });
    } catch (e) {}

    const identity = await window.sirr.getIdentity();
    const config   = await window.sirr.getConfig();
    if (identity.temporary) {
      const b = $('#temp-id-banner');
      if (b) {
        b.classList.remove('hidden');
        document.body.classList.add('has-temp-id');
        const fit = () => document.body.style.setProperty('--temp-id-h', b.offsetHeight + 'px');
        fit(); window.addEventListener('resize', fit);
      }
    }
    const s = state.state;

    s.myNickname    = config.nickname || identity.nickname;
    s.myFingerprint = identity.fingerprint;
    s.myPeerId      = identity.peerId || '';
    s.accentColor   = config.accentColor   || '#4ff0a0';
    s.fontScale     = config.fontScale     || 1;
    s.density       = config.density       || 'default';
    s.bubble        = config.bubble        || 'flat';
    s.msgLayout     = config.msgLayout === 'cards' ? 'cards' : 'irc';
    s.chatBg        = config.chatBg        || 'none';
    s.timeFormat    = config.timeFormat    || '12';
    s.notifSound    = config.notifSound    || 'on';
    s.avatarEmoji   = config.avatarEmoji   || '';
    s.avatarImage   = config.avatarImage   || '';
    s.avatarPixels  = config.avatarPixels  || '';
    glyphs.setPixels(identity.fingerprint, s.avatarPixels);
    s.statusText    = config.statusText    || '';
    s.autoDownload  = config.autoDownload  || 'off';
    s.desktopNotifs = config.desktopNotifs || 'all';
    s.mentionToasts = config.mentionToasts || 'on';
    s.sendTypingPref= config.sendTyping    || 'on';
    s.vcAutoMute    = config.vcAutoMute    || 'off';
    s.noiseGate     = config.noiseGate     || 'off';
    s.reduceMotion  = config.reduceMotion  || 'off';
    s.highContrast  = config.highContrast  || 'off';
    s.largeTargets  = config.largeTargets  || 'off';
    s.linkPreview   = config.linkPreview   || 'off';
    s.inbox         = config.inbox === 'on' ? 'on' : 'off';
    s.contentProtection = config.contentProtection === 'on' ? 'on' : 'off';
    s.lockOnSleep   = config.lockOnSleep === 'on' ? 'on' : 'off';
    s.coverTraffic  = config.coverTraffic === 'on' ? 'on' : 'off';
    s.nearby        = config.nearby === 'on' ? 'on' : 'off';
    s.echoes        = config.echoes === 'on' ? 'on' : 'off';
    s.relays        = ['off', 'auto', 'always'].includes(config.relays) ? config.relays : 'auto';
    s.relayVolunteer = config.relayVolunteer === 'on' ? 'on' : 'off';
    s.inviteHintsMode = config.inviteHints === 'off' ? 'off' : (config.inviteBridge === 'on' ? 'bridge' : 'on');
    s.entryPoints   = config.entryPoints || '';
    s.bridge        = config.bridge || '';
    s.bridgeServe   = Number(config.bridgeServe || 0);
    s.sendJitter    = Number(config.sendJitter || 0);
    s.autoLockMin   = Number(config.autoLockMin || 0);
    s.panicHotkey   = config.panicHotkey === 'on' ? 'on' : 'off';
    s.audioProfile    = config.audioProfile    || 'voice';
    s.audioRedundancy = config.audioRedundancy || 'on';
    s.audioLatency    = config.audioLatency    || 'balanced';
    s.denoise         = config.denoise         || 'off';
    s.meshVoice       = config.meshVoice       || 'off';
    s.voiceRoute      = config.voiceRoute === 'swarm' ? 'swarm' : 'auto';
    s.meshBuffer      = config.meshBuffer      || 'balanced';
    s.meshRedundancy  = config.meshRedundancy  || 'on';
    s.meshCopies      = config.meshCopies      || '2';
    s.meshSpacing     = config.meshSpacing     || '3';
    // Notification log survives restarts now.
    try { toasts.hydrate(config.notifLog); } catch (e) {}
    s.audioInputId  = config.audioInputId  || '';
    s.audioOutputId = config.audioOutputId || '';
    // Optional user-supplied STUN servers, e.g.
    //   "stun:stun.mycoturn.example:3478"
    // Comma-separated in config.stunServers. Empty → privacy defaults.
    try {
      const raw = String(config.stunServers || '').trim();
      if (raw) {
        state.setIceServers(raw.split(',').map(u => ({ urls: u.trim() })).filter(x => x.urls));
      }
    } catch (e) {}


    // Init feature modules. Each module's init() owns its DOM listeners
    // (pins panel, quick switcher, profile card click handlers, etc.).
    chat.init();
    rooms.init();
    voice.init();
    if (peers.init) peers.init();

    $('#in-nick').value = s.myNickname;
    $('#join-fp').textContent = s.myFingerprint;
    renderKeyPlate(identity);
    applyAccent(s.accentColor); applyFont(s.fontScale); applyDensity(s.density);
    applyChatBg(s.chatBg); applyBubble(s.bubble); applyLayout(s.msgLayout); applyA11y();
    if (peers.updateMyAvatarCells) peers.updateMyAvatarCells();

    const saved = await window.sirr.getRooms();
    for (const r of saved) {
      if (!state.roomData.has(r.code)) state.roomData.set(r.code, { messages: [], unread: 0, name: r.name || r.code });
      if (r.moved && r.moved.to) state.roomData.get(r.code).moved = r.moved.to;
      if (!state.roomPeers.has(r.code)) state.roomPeers.set(r.code, new Set());
      if (r.isDm) {
        const rd = state.roomData.get(r.code);
        rd.isDm = true;
        rd.dmPeer = r.dmPeer || null;
        if (r.request) rd.request = true;
      }
      rooms.ensureChannelsMap(r.code);
    }
    // Channels, then every channel's history, fetched concurrently rather
    // than one IPC round trip after another: boot time stays flat as the
    // number of rooms grows.
    const chanLists = await Promise.all(saved.map(r => window.sirr.getChannels(r.code).catch(() => null)));
    saved.forEach((r, i) => { try { rooms.absorbChannels(r.code, chanLists[i]); } catch (e) {} });
    const histJobs = [];
    for (const r of saved) {
      const rd = state.roomData.get(r.code);
      for (const [chId, ch] of rd.channels) {
        histJobs.push(window.sirr.getHistory(r.code, chId).then(hist => {
          if (hist && hist.length > 0) ch.messages = hist.filter(m => m.type !== 'reaction');
        }).catch(() => {}));
      }
    }
    await Promise.all(histJobs);

    await peers.loadContacts();

    try {
      const bl = await window.sirr.getBlocklist();
      for (const fp of Object.keys(bl || {})) state.blocklist.add(fp);
    } catch (e) {}

    try {
      const all = await window.sirr.getAllRosters();
      for (const [code, entries] of Object.entries(all || {})) {
        if (!state.roomRoster.has(code)) state.roomRoster.set(code, new Map());
        const map = state.roomRoster.get(code);
        for (const [fp, rec] of Object.entries(entries || {})) {
          if (rec.avatarPixels) glyphs.setPixels(fp, rec.avatarPixels);
          map.set(fp, {
            fingerprint: fp,
            nickname: rec.nickname || '',
            avatarEmoji: rec.avatarEmoji || '',
            avatarPixels: rec.avatarPixels || '',
            firstSeenAt: rec.firstSeenAt || 0,
            lastSeenAt:  rec.lastSeenAt  || 0,
          });
        }
      }
    } catch (e) {}

    try {
      const pinJobs = [];
      for (const r of saved) {
        const rd = state.roomData.get(r.code);
        if (!rd || !rd.channels) continue;
        for (const chId of rd.channels.keys()) {
          pinJobs.push(window.sirr.getPins(r.code, chId).then(pins => {
            const set = chat.getPinnedSet(r.code, chId);
            for (const [msgId, rec] of Object.entries(pins || {})) {
              set.set(msgId, { preview: rec.preview || '', nick: rec.nick || '', ts: rec.ts || 0 });
            }
          }).catch(() => {}));
        }
      }
      await Promise.all(pinJobs);
    } catch (e) {}

    if (saved.length > 0) {
      enterChat();
      rooms.renderRail();
      const initial = saved.find(r => !r.isDm) || saved[0];
      rooms.switchRoom(initial.code);
    }

    try {
      const knownPeers = await window.sirr.getPeers();
      for (const p of knownPeers) {
        state.peers.set(p.peerId, { ...p });
        if (Array.isArray(p.rooms)) for (const room of p.rooms) peers.addPeerToRoom(room, p.peerId);
      }
      peers.updatePeers();
    } catch (e) {}

    setInterval(() => peers.updateStats(), 5000);
    startIdleWatcher();

    // ── Join-screen DHT status indicator ─────────────────────────────
    // Poll network status every second until the swarm is confirmed live,
    // then switch to polling peer count so the user can see activity.
    // Stops as soon as the user has entered the chat screen.
    const dhtEl = $('#dht-status');
    if (dhtEl) {
      let dhtLive = false;
      const dhtPoller = setInterval(async () => {
        // Once we're in chat, stop updating the join-screen element.
        if (!$('#join-screen')?.classList.contains('active')) {
          clearInterval(dhtPoller);
          return;
        }
        try {
          if (!dhtLive) {
            const ns = await window.sirr.getNetworkStatus();
            if (ns && ns.initialized) {
              dhtLive = true;
              dhtEl.innerHTML = '<span class="dht-dot live"></span>LIVE';
              $('#join-key')?.classList.add('live');
            }
          } else {
            // Already live — show peer count if any peers are visible.
            const st = await window.sirr.getStats();
            if (st && st.peers > 0) {
              dhtEl.innerHTML = '<span class="dht-dot live"></span>LIVE &middot; ' + st.peers + ' peer' + (st.peers === 1 ? '' : 's');
            }
          }
        } catch (e) {}
      }, 1000);
    }

    console.log('[SIRR] Boot OK — myPeerId=', s.myPeerId);
  } catch (err) {
    console.error('[SIRR] Boot failed:', err);
  }
}

// ─── Entry ───────────────────────────────────────────────────────
// `<script type="module">` defers automatically, so the DOM is ready by the
// time this file evaluates. Wire DOM + network listeners synchronously, then
// kick off the async boot.
wireDom();
wireNetwork();
boot();


// ─── Right-click menus ──────────────────────────────────────────────
function _copy(txt, what) {
  try { navigator.clipboard.writeText(String(txt)); } catch (e) {}
}
function _peerByFp(fp) { for (const p of state.peers.values()) if (p.fingerprint === fp) return p; return null; }
function _peerMenu(fp, nick, extra = []) {
  const contacts = state.contacts || new Map();
  const isContact = contacts.has ? contacts.has(fp) : !!contacts[fp];
  const me = fp === state.state.myFingerprint;
  return [
    ...extra,
    { label: 'View profile', act: () => peers.openProfile(fp) },
    !me && { label: 'Message', act: async () => { const c = await peers.doOpenDm(fp, nick); if (c) rooms.switchRoom(c); } },
    !me && (isContact
      ? { label: 'Remove contact', act: () => peers.doRemoveContact(fp) }
      : { label: 'Add contact', act: () => peers.doAddContact(fp, nick, (_peerByFp(fp) || {}).avatarEmoji || '') }),
    'sep',
    { label: 'Copy fingerprint', hint: fp.slice(0, 9), act: () => _copy(fp, 'fingerprint') },
    !me && 'sep',
    !me && { label: 'Block', danger: true, act: async () => {
      await window.sirr.blockPeer(fp, nick);
      toasts.showToast({ type: 'info', title: 'BLOCKED', body: nick || fp, ttl: 2500 });
    } },
  ].filter(Boolean);
}

function wireContextMenus() {
  document.addEventListener('contextmenu', async (e) => {
    const t = e.target;
    if (t.closest('input, textarea, [contenteditable="true"]')) return;   // keep native copy/paste there

    // Message
    const bubble = t.closest('.tx[data-msgid]');
    if (bubble) {
      e.preventDefault();
      const msg = chat.findMsgInActiveChannel(bubble.dataset.msgid);
      if (!msg) return;
      const btn = (a) => bubble.querySelector('[data-act="' + a + '"]');
      const act = (a) => () => { const b = btn(a); if (b) b.click(); };
      const items = [
        { reactions: ['👍', '❤️', '😂', '🔥', '👀', '🙏', '😮'], act: (em) => chat.addReaction(msg.msgId, em, state.state.myNickname) },
        btn('reply') && { label: 'Reply', act: act('reply') },
        btn('react') && { label: 'Add reaction…', act: act('react') },
        btn('edit') && { label: 'Edit message', act: act('edit') },
        btn('pin') && { label: 'Pin / unpin', act: act('pin') },
        'sep',
        msg.type === 'text' && { label: 'Copy text', act: () => _copy(msg.content, 'message') },
        { label: 'Copy message ID', hint: msg.msgId.slice(0, 8), act: () => _copy(msg.msgId, 'message id') },
        (msg.fileRef && window.sirr.fileSave) && { label: 'Save file…', act: () => window.sirr.fileSave(msg.fileRef) },
        !msg.self && msg.fingerprint && 'sep',
        !msg.self && msg.fingerprint && { label: 'View ' + (msg.nickname || 'author') + '’s profile', act: () => peers.openProfile(msg.fingerprint) },
        !msg.self && msg.fingerprint && { label: 'Message ' + (msg.nickname || 'author'), act: async () => { const c = await peers.doOpenDm(msg.fingerprint, msg.nickname); if (c) rooms.switchRoom(c); } },
        'sep',
        btn('delete') && { label: 'Delete for me', danger: true, act: act('delete') },
        btn('delete-all') && { label: 'Delete for everyone', danger: true, act: act('delete-all') },
      ].filter(Boolean);
      ctx.openMenu(e.clientX, e.clientY, items, (msg.nickname || '') + ' · ' + (chat.fmtTime ? chat.fmtTime(msg.timestamp) : ''));
      return;
    }

    // Voice participant
    const vu = t.closest('.vu-row[data-pid]');
    if (vu) {
      e.preventDefault();
      const pid = vu.dataset.pid, fp = vu.dataset.fp, p = state.peers.get(pid);
      const nick = p ? p.nickname : pid;
      const extra = [
        { slider: { label: 'VOL', min: 0, max: 100, value: voice.getPeerVolume(pid), onInput: (v) => voice.setPeerVolume(pid, v) } },
        { label: voice.isPeerLocallyMuted(pid) ? 'Unmute for me' : 'Mute for me', act: () => voice.togglePeerLocalMute(pid) },
        'sep',
      ];
      ctx.openMenu(e.clientX, e.clientY, fp ? _peerMenu(fp, nick, extra) : extra, nick);
      return;
    }

    // Member / contact row
    const prow = t.closest('[data-key^="fp:"]');
    if (prow) {
      e.preventDefault();
      const fp = peers.fpFromRow(prow);
      const p = _peerByFp(fp);
      const c = state.contacts && (state.contacts.get ? state.contacts.get(fp) : state.contacts[fp]);
      const nick = (p && p.nickname) || (c && c.nickname) || fp;
      ctx.openMenu(e.clientX, e.clientY, _peerMenu(fp, nick), nick);
      return;
    }

    // Room / DM in the rail
    const rr = t.closest('.rail-room[data-code]');
    if (rr) {
      e.preventDefault();
      const code = rr.dataset.code, rd = state.roomData.get(code) || {};
      const items = [
        { label: 'Open', act: () => rooms.switchRoom(code) },
        rd.unread && { label: 'Mark as read', act: () => { rd.unread = 0; rd.mentionUnread = 0; rooms.renderRail(); rooms.updateGlobalUnread && rooms.updateGlobalUnread(); } },
        'sep',
        !rd.isDm && { label: 'Copy room code', act: () => _copy(code, 'room code') },
        !rd.isDm && { label: 'Copy invite link', act: async () => _copy(await window.sirr.buildInviteUrl(code), 'invite link') },
        rd.isDm && rd.dmPeer && { label: 'View profile', act: () => peers.openProfile(rd.dmPeer.fingerprint || rd.dmPeer) },
        !rd.isDm && { label: 'Rename…', act: () => { rooms.switchRoom(code); setTimeout(() => $('#sb-room-label')?.dispatchEvent(new MouseEvent('dblclick')), 50); } },
        'sep',
        { label: rd.isDm ? 'Close conversation' : 'Leave room', danger: true, act: () => rooms.removeRoom(code) },
      ].filter(Boolean);
      ctx.openMenu(e.clientX, e.clientY, items, rd.isDm ? ('@' + (rd.dmPeer?.nickname || rd.name || 'DM')) : (rd.name && rd.name !== code ? rd.name : code));
      return;
    }

    // Channel
    const ch = t.closest('.chan-row[data-id]');
    if (ch && state.state.activeRoom) {
      e.preventDefault();
      const id = ch.dataset.id;
      const room = state.state.activeRoom;
      const rec = rooms.getChannelRec ? rooms.getChannelRec(room, id) : null;
      const items = [
        rec && rec.kind === 'voice'
          ? { label: 'Join voice', act: () => voice.joinVoiceChannel(id) }
          : { label: 'Open', act: () => rooms.switchTextChannel(id) },
        { label: 'Copy channel ID', act: () => _copy(id, 'channel id') },
        id !== 'default' && 'sep',
        id !== 'default' && { label: 'Rename…', act: () => rooms.beginRenameChannel(ch, id) },
        id !== 'default' && { label: 'Delete channel', danger: true, act: async () => {
          const r = await window.sirr.deleteChannel(room, id);
          if (!r || r.ok === false) toasts.showToast({ type: 'warn', title: 'NOT ALLOWED', body: 'You need the delete-channel permission', ttl: 2500 });
        } },
      ].filter(Boolean);
      ctx.openMenu(e.clientX, e.clientY, items, (rec && rec.name) || id);
    }
  });
}
