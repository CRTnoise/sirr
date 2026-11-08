/**
 * Room admin / owner UI — first extracted module from the renderer monolith.
 *
 * This is a plain <script> (not an ES module) so it coexists with the still-
 * IIFE-wrapped app.js without forcing a module conversion of the whole file.
 * It exposes exactly one global: `window.SirrAdmin`. app.js wires its
 * below. Nothing in this file touches app.js's internal state directly.
 *

 * Loaded by index.html BEFORE app.js so the namespace exists when app.js
 * boots.
 */
// Namespace imports to match the rest of the renderer modules. With named
// imports, the local binding `state` would refer to the inner state object
// — making `state.roomAdminState` undefined (since roomAdminState is a
// separate top-level export, not a property of the inner state). That
// silently broke isOwnerOfActiveRoom + the OWNER/ADMIN tags.
import * as state from './state.js';
import * as chat from './chat.js';
import * as peers from './peers.js';
const { ROOM_PERM_LABELS } = state;





  
  

  // Pull the latest admin snapshot for a room and cache it. Callers re-render
  // peer rows after this resolves so OWNER/ADMIN badges update.
  export async function fetchRoomAdmin(code) {
    if (!code ) return null;
    try {
      const data = await window.sirr.getRoomAdmin(code);
      if (data) state.roomAdminState.set(code, data);
      return data;
    } catch (e) { return null; }
  }

  // True only when we're the verified owner of the active room. Gates the
  // right-click "manage" action and the Save/Remove buttons in the panel.
  export function isOwnerOfActiveRoom() {
    const code = state.state.activeRoom;
    if (!code || !state.roomAdminState) return false;
    const s = state.roomAdminState.get(code);
    return !!(s && s.isOwner);
  }

  // Returns { isOwner, admin } for a fingerprint in a room, or null if we
  // don't have the snapshot yet. `admin` is the perm record (or null for
  // plain members).
  export function permsForFingerprint(code, fp) {
    if (!state.roomAdminState) return null;
    const s = state.roomAdminState.get(code);
    if (!s) return null;
    if (s.owner && s.owner.fingerprint === fp) return { isOwner: true, admin: null };
    const a = (s.admins && s.admins[fp]) || null;
    return { isOwner: false, admin: a };
  }

  // Inline HTML badge for the peer-list row. Owner → amber OWNER tag; any
  // peer with ≥1 granted perm → green ADMIN tag; plain members → empty. The
  // inline style attribute is static — style-src allows 'unsafe-inline' so
  // this stays CSP-safe.
  export function roleTagHtml(code, fp) {
    if (!code || !fp) return '';
    const info = permsForFingerprint(code, fp);
    if (!info) return '';
    if (info.isOwner) {
      return '<span class="role-tag role-owner" style="margin-left:8px;padding:1px 6px;font-size:9px;letter-spacing:.08em;background:color-mix(in oklch, var(--warn) 14%, transparent);color:var(--warn);font-family:var(--mono);">OWNER</span>';
    }
    if (info.admin) {
      return '<span class="role-tag role-admin" style="margin-left:8px;padding:1px 6px;font-size:9px;letter-spacing:.08em;background:var(--a10);color:var(--accent);font-family:var(--mono);">ADMIN</span>';
    }
    return '';
  }

  // Owner-only overlay. Built from DOM primitives (no HTML template literal
  // with user data) so nickname/fp are guaranteed text-only regardless of
  // what the roster contains.
  export function openAdminPanel(fp, nickname) {
    const code = state.state.activeRoom;
    if (!code || !fp) return;
    const adm = state.roomAdminState && state.roomAdminState.get(code);
    if (!adm || !adm.isOwner) return;           // only owner can manage
    if (fp === adm.myFingerprint) return;       // can't demote yourself
    const existing = (adm.admins && adm.admins[fp]) || null;

    const back = document.createElement('div');
    back.className = 'ov';
    Object.assign(back.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: '9999',
    });
    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#14141b', border: '1px solid #2a2a33', borderRadius: '10px',
      padding: '20px 22px', width: '420px', color: '#e4e7ea',
      fontFamily: 'var(--sans)',
    });
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:6px;font-family:var(--mono)';
    title.textContent = 'Manage admin';
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:4px';
    sub.textContent = nickname || fp.slice(0, 8);
    const fpEl = document.createElement('div');
    fpEl.style.cssText = 'font-size:11px;color:var(--txt-dim);font-family:var(--mono);margin-bottom:16px';
    fpEl.textContent = fp;
    card.append(title, sub, fpEl);

    const perms = (adm.permKeys || Object.keys(ROOM_PERM_LABELS));
    const inputs = {};
    for (const k of perms) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;font-size:13px;border-top:1px solid #22222a';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!(existing && existing[k]);
      inputs[k] = cb;
      const lbl = document.createElement('span');
      lbl.textContent = ROOM_PERM_LABELS[k] || k;
      row.append(cb, lbl);
      card.appendChild(row);
    }

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:18px';
    const mkBtn = (txt, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = txt;
      b.style.cssText = 'padding:8px 14px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid #333;'
        + (primary ? 'background:var(--accent);color:var(--acc-ink);border-color:transparent;font-weight:600;' : 'background:transparent;color:var(--txt);');
      return b;
    };
    const cancel = mkBtn('Cancel', false);
    const removeBtn = mkBtn('Remove admin', false);
    removeBtn.style.color = '#ff6b6b';
    removeBtn.style.borderColor = '#3a2222';
    const save = mkBtn('Save', true);
    if (!existing) removeBtn.style.display = 'none';

    const close = () => { try { back.remove(); } catch (e) {} };
    cancel.addEventListener('click', close);
    back.addEventListener('click', ev => { if (ev.target === back) close(); });
    removeBtn.addEventListener('click', async () => {
      const r = await window.sirr.removeAdmin(code, fp);
      if (r && r.ok) {
        await fetchRoomAdmin(code);
        peers.updatePeers();
        chat.sysMsg('Admin removed for ' + (nickname || fp.slice(0, 8)));
      }
      close();
    });
    save.addEventListener('click', async () => {
      const out = {};
      for (const k of perms) out[k] = !!inputs[k].checked;
      const r = await window.sirr.setAdmin(code, fp, out);
      if (r && r.ok) {
        await fetchRoomAdmin(code);
        peers.updatePeers();
        chat.sysMsg('Permissions updated for ' + (nickname || fp.slice(0, 8)));
      } else if (r && r.error) {
        chat.sysMsg('⚠ ' + r.error);
      }
      close();
    });
    bar.append(removeBtn, cancel, save);
    card.appendChild(bar);
    back.appendChild(card);
    document.body.appendChild(back);
  }
  /*
  window.SirrAdmin = {
    
    fetchRoomAdmin,
    isOwnerOfActiveRoom,
    permsForFingerprint,
    roleTagHtml,
    openAdminPanel,
  };*/

