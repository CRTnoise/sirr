/**
 * Sirr — Toasts + Notification Centre  
 * ═══════════════════════════════════════════════════════════════════
 *
 * ─── WHAT WAS WRONG WITH THE OLD ONE ─────────────────────────────
 * The unread count was a standalone integer, incremented and
 * decremented by hand alongside a separate per-entry `seen` flag. Two
 * sources of truth for one fact, so they drifted, and every drift was
 * permanent. Concretely:
 *
 *  1. Log truncation at 50 entries did `log.length = 50`, silently
 *     dropping entries that might be unread WITHOUT decrementing the
 *     counter. The badge then pointed at notifications that no longer
 *     existed. This is the "I removed it and it's still unread" bug.
 *
 *  2. A notification arriving while the panel was OPEN still counted as
 *     unread, so closing a panel you had just read left a badge behind.
 *
 *  3. The counter was clamped with Math.min(99, n + 1) going up but
 *     decremented freely coming down, so passing 99 unread desynced it
 *     permanently.
 *
 *  4. dismissNotif() reimplemented the badge update inline rather than
 *     calling updateNotifsBadge(), so the two could disagree.
 *
 * ─── THE FIX ─────────────────────────────────────────────────────
 * Unread is DERIVED, never stored: log.filter(r => !r.read).length.
 * One source of truth. Truncation, dismissal, grouping and clearing
 * all update the count correctly by construction, because there is
 * nothing else they could do.
 *
 * ─── OTHER CHANGES ───────────────────────────────────────────────
 *  • Bodies are sanitised. `body` has always been injected as HTML by
 *    ~59 call sites that escape their own dynamic parts. That is a
 *    convention with no enforcement, inside a security product. Bodies
 *    now pass a tag/attribute whitelist, so a missed escape anywhere
 *    becomes a rendering bug instead of script execution.
 *  • Identical notifications collapse into one row with a count rather
 *    than flooding the list.
 *  • Entries that arrive while you are looking at the panel are read
 *    immediately. Entries you had not seen stay visibly marked for the
 *    duration of the visit, so clearing the badge does not hide what
 *    was new.
 *  • Filters (All / Unread) and a non-destructive "mark all read",
 *    separate from the destructive "clear all".
 *  • Timestamps refresh while the panel is open instead of freezing at
 *    render time.
 *  • The log survives a restart.
 */

const LOG_MAX          = 60;
const PERSIST_MAX      = 30;
const PERSIST_DEBOUNCE = 1500;
const GROUP_WINDOW     = 5 * 60 * 1000;   // collapse identical entries within 5 min

const log = [];
let seq = 0;
let panelOpen = false;
let filter = 'all';            // 'all' | 'unread'
let highlight = new Set();     // ids that were unread when the panel opened
let tsTimer = null;
let persistTimer = null;

// ─── helpers ──────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Whitelist sanitiser. Call sites legitimately pass small formatting
// markup (<b>, <span class="mon">), so we keep that and drop the rest
// rather than escaping wholesale and breaking every existing toast.
const ALLOWED_TAGS  = new Set(['B', 'I', 'EM', 'STRONG', 'SPAN', 'DIV', 'CODE', 'BR', 'SMALL']);
const ALLOWED_ATTRS = new Set(['class']);

function sanitize(html) {
  if (html == null) return '';
  try {
    const doc = new DOMParser().parseFromString(
      '<div id="r">' + String(html) + '</div>', 'text/html');
    const root = doc.getElementById('r');
    if (!root) return esc(html);

    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) continue;               // text is fine
        if (child.nodeType !== 1) { child.remove(); continue; }
        if (!ALLOWED_TAGS.has(child.tagName)) {
          // Unwrap rather than delete — keeps the text, loses the tag.
          child.replaceWith(doc.createTextNode(child.textContent || ''));
          continue;
        }
        for (const attr of [...child.attributes]) {
          const n = attr.name.toLowerCase();
          if (!ALLOWED_ATTRS.has(n) || n.startsWith('on')) child.removeAttribute(attr.name);
        }
        walk(child);
      }
    };
    walk(root);
    return root.innerHTML;
  } catch (e) {
    return esc(html);
  }
}

function fmtTs(ts) {
  const diff = Date.now() - ts;
  if (diff < 45 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return Math.max(1, Math.floor(diff / 60000)) + 'm ago';
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + 'h ago';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const $id = (i) => document.getElementById(i);

// ═══════════════════════════════════════════════════════════════════
//  STATE — unread is derived, never stored
// ═══════════════════════════════════════════════════════════════════
export function unreadCount() {
  let n = 0;
  for (const r of log) if (!r.read) n += 1;
  return n;
}

/** Repaint badge + panel from the log. The only path state takes to DOM. */
function sync() {
  const n   = unreadCount();
  const btn = $id('btn-notifs');
  const cnt = $id('notifs-count');
  if (cnt) cnt.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
  if (btn) btn.classList.toggle('has-unread', n > 0);
  if (panelOpen) render();
  schedulePersist();
}

export const updateNotifsBadge = sync;   // preserved for existing callers

// ═══════════════════════════════════════════════════════════════════
//  PERSISTENCE
// ═══════════════════════════════════════════════════════════════════
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE);
}

function persistNow() {
  persistTimer = null;
  try {
    const slim = log.slice(0, PERSIST_MAX).map(r => ({
      i: r.id, t: r.type, h: r.title,
      b: String(r.body || '').slice(0, 300),
      s: r.ts, r: r.read ? 1 : 0,
      c: r.count > 1 ? r.count : undefined,
    }));
    window.sirr?.updateConfig?.({ notifLog: slim });
  } catch (e) { /* best-effort, never load-bearing */ }
}

/** Restore a persisted log. Called once from app.js boot. */
export function hydrate(saved) {
  if (!Array.isArray(saved)) { sync(); return; }
  try {
    for (const r of saved) {
      if (!r || typeof r !== 'object') continue;
      log.push({
        id:    String(r.i || ('h' + (++seq))),
        type:  String(r.t || 'info'),
        title: String(r.h || ''),
        body:  String(r.b || ''),
        ts:    Number(r.s) || Date.now(),
        read:  !!r.r,
        count: Number(r.c) || 1,
      });
    }
    log.sort((a, b) => b.ts - a.ts);
    if (log.length > LOG_MAX) log.length = LOG_MAX;
  } catch (e) {}
  sync();
}

// ═══════════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════════
function logNotification(entry) {
  const type  = entry.type  || 'info';
  const title = entry.title || '';
  const body  = entry.body  || '';
  const now   = Date.now();

  // Explicit id → replace in place (progress toasts and the like).
  if (entry.id) {
    const i = log.findIndex(r => r.id === entry.id);
    if (i >= 0) {
      const prev = log[i];
      log.splice(i, 1);
      log.unshift({ ...prev, type, title, body, ts: now, read: panelOpen });
      trim(); sync(); return;
    }
  }

  // Identical recent entry → collapse with a count instead of flooding.
  const head = log[0];
  if (head && head.type === type && head.title === title &&
      head.body === body && (now - head.ts) < GROUP_WINDOW) {
    head.count = (head.count || 1) + 1;
    head.ts = now;
    if (!panelOpen) head.read = false;
    trim(); sync(); return;
  }

  log.unshift({
    id: entry.id || ('n' + (++seq) + '_' + now.toString(36)),
    type, title, body, ts: now,
    // The whole point: something arriving while you are reading the
    // panel is already read. The old code counted it unread, which is
    // how you got a badge for a notification you were looking at.
    read: panelOpen,
    count: 1,
  });
  trim();
  sync();
}

// Truncation is now safe: unread is derived, so dropping unread entries
// updates the count automatically instead of stranding it.
function trim() { if (log.length > LOG_MAX) log.length = LOG_MAX; }

// ═══════════════════════════════════════════════════════════════════
//  PANEL
// ═══════════════════════════════════════════════════════════════════
export function openNotifsPanel() {
  panelOpen = true;
  // Remember what was unread so those rows stay visibly marked for this
  // visit. The badge clears immediately (you are looking at them) but
  // you can still see which ones were new.
  highlight = new Set(log.filter(r => !r.read).map(r => r.id));
  for (const r of log) r.read = true;

  const ov = $id('notifs-ov');
  if (ov) ov.classList.remove('hidden');
  sync();
  render();

  if (tsTimer) clearInterval(tsTimer);
  tsTimer = setInterval(() => { if (panelOpen) refreshTimestamps(); }, 30000);
}

export function closeNotifsPanel() {
  panelOpen = false;
  highlight.clear();
  const ov = $id('notifs-ov');
  if (ov) ov.classList.add('hidden');
  if (tsTimer) { clearInterval(tsTimer); tsTimer = null; }
  persistNow();
}

export function setFilter(f) {
  filter = (f === 'unread') ? 'unread' : 'all';
  const bar = $id('notifs-filters');
  if (bar) for (const b of bar.querySelectorAll('[data-nf]')) {
    b.classList.toggle('act', b.dataset.nf === filter);
  }
  render();
}

/** Non-destructive counterpart to clear-all. */
export function markAllRead() {
  for (const r of log) r.read = true;
  highlight.clear();
  sync();
  render();
}

export function clearAllNotifs() {
  log.length = 0;
  highlight.clear();
  sync();
  render();
  persistNow();
}

export function dismissNotif(id) {
  const i = log.findIndex(r => r.id === id);
  if (i < 0) return;
  log.splice(i, 1);
  highlight.delete(id);
  // No manual counter bookkeeping — that was the entire bug class.
  sync();
  render();
}

const TYPE_MARK = { info: '·', success: '✓', warn: '!', action: '?', error: '×' };

function visible() {
  // While the panel is open everything is technically read, so "unread"
  // means "was unread when you opened it" — which is what you want.
  return filter === 'unread'
    ? log.filter(r => highlight.has(r.id) || !r.read)
    : log;
}

export function renderNotifsPanel() { render(); }

function render() {
  const list  = $id('notifs-list');
  const total = $id('notifs-total');
  if (!list) return;

  const n = unreadCount();
  if (total) total.textContent = n > 0 ? (log.length + ' · ' + n + ' new') : String(log.length);

  const rows = visible();
  if (!rows.length) {
    list.innerHTML = '<div class="notifs-empty">' +
      (filter === 'unread' ? 'Nothing new.' : 'No notifications yet.') + '</div>';
    return;
  }

  list.innerHTML = rows.map(r => {
    const isNew = highlight.has(r.id) || !r.read;
    return '<div class="notif-row n-' + esc(r.type) + (isNew ? ' unseen' : '') +
             '" data-nid="' + esc(r.id) + '">' +
      '<span class="n-dot" aria-hidden="true">' + esc(TYPE_MARK[r.type] || '·') + '</span>' +
      '<div class="n-body">' +
        (r.title ? '<div class="n-title">' + esc(r.title) +
          ((r.count > 1) ? '<span class="n-count">×' + r.count + '</span>' : '') + '</div>' : '') +
        (r.body ? '<div class="n-text">' + sanitize(r.body) + '</div>' : '') +
        '<div class="n-meta" data-ts="' + r.ts + '">' + esc(fmtTs(r.ts)) + '</div>' +
      '</div>' +
      '<button class="n-dismiss" data-act="dismiss" title="Dismiss" aria-label="Dismiss">&times;</button>' +
    '</div>';
  }).join('');
}

// Re-stamp relative times in place. A full re-render would fight the
// scroll position and whichever row the pointer is on.
function refreshTimestamps() {
  const list = $id('notifs-list');
  if (!list) return;
  for (const el of list.querySelectorAll('.n-meta[data-ts]')) {
    const ts = Number(el.dataset.ts);
    if (ts) el.textContent = fmtTs(ts);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TOASTS
// ═══════════════════════════════════════════════════════════════════
// showToast({ type, title, body, actions, ttl, id, silent })
//   type:    'info' | 'success' | 'warn' | 'error' | 'action'
//   body:    small formatting markup allowed; sanitised on render.
//   silent:  transient UI feedback that should NOT enter the log.
//   id:      repeat calls replace rather than stack.
// Returns close().
export function showToast(opts) {
  const o = opts || {};
  const stack = $id('toast-stack');
  const type = o.type || 'info';
  const isAction = type === 'action' || (Array.isArray(o.actions) && o.actions.length > 0);

  if (o.silent !== true) {
    try { logNotification({ id: o.id, type, title: o.title, body: o.body }); } catch (e) {}
  }
  if (!stack) return () => {};

  if (o.id) {
    const prev = stack.querySelector('[data-toast-id="' + CSS.escape(o.id) + '"]');
    if (prev) prev.remove();
  }

  const el = document.createElement('div');
  el.className = 'toast ' + type;
  if (o.id) el.setAttribute('data-toast-id', o.id);
  el.setAttribute('role', isAction ? 'alertdialog' : 'status');

  el.innerHTML =
    '<div class="toast-content">' +
      (o.title ? '<div class="toast-title">' + esc(o.title) + '</div>' : '') +
      (o.body  ? '<div class="toast-body">'  + sanitize(o.body) + '</div>' : '') +
      '<div class="toast-actions"></div>' +
    '</div>' +
    '<button class="toast-x" aria-label="Dismiss">&times;</button>';

  let timer = null;
  const close = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!el.isConnected) return;
    el.classList.add('closing');
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  };

  el.querySelector('.toast-x').addEventListener('click', close);
  const bar = el.querySelector('.toast-actions');

  if (isAction && Array.isArray(o.actions) && o.actions.length) {
    for (const a of o.actions) {
      const b = document.createElement('button');
      b.className = 'toast-btn' + (a.primary ? ' primary' : '');
      b.textContent = a.label;
      b.addEventListener('click', () => {
        try { if (typeof a.onClick === 'function') a.onClick(close); }
        catch (e) { close(); }
      });
      bar.appendChild(b);
    }
  } else {
    const d = document.createElement('button');
    d.className = 'toast-btn';
    d.textContent = 'Dismiss';
    d.addEventListener('click', close);
    bar.appendChild(d);
  }

  // Pause auto-dismiss while the pointer is over the toast. A toast that
  // vanishes as you reach for its button is infuriating.
  const ttl = typeof o.ttl === 'number' ? o.ttl : 5000;
  const arm = () => { if (!isAction && ttl > 0) timer = setTimeout(close, ttl); };
  el.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('mouseleave', arm);

  stack.appendChild(el);
  arm();
  return close;
}

/** Wire the panel's own controls. Called once from app.js. */
export function init() {
  // Note: the dismiss handler lives in app.js's existing #notifs-list
  // delegate. Adding a second one here would double-fire.
  const bar = $id('notifs-filters');
  if (bar) {
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nf]');
      if (b) setFilter(b.dataset.nf);
    });
  }
  const mar = $id('btn-notifs-read');
  if (mar) mar.addEventListener('click', markAllRead);
  sync();
}
