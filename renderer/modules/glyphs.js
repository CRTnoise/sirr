/**
 * glyphs.js — Cipher ledger visual primitives (v7).
 *
 * Pure functions that turn key material into markup. No DOM access, no
 * state, no network: safe to import from any module.
 *
 *   sigilSvg(name, fp)    17×17 seal: the name draws the inside, the
 *                         fingerprint's 64 bits are the rim (see below).
 *   avatarHtml(...)       image > emoji > identicon, the one avatar rule.
 *   hexBytes(str)         fingerprint / key string → byte array.
 *   hexDumpHtml(bytes)    offset-labelled hex dump (8 bytes per row).
 *   randomart(bytes)      OpenSSH "drunken bishop" visual fingerprint.
 *   groupFp(str)          "6556 6DA2 088C 3634" display grouping.
 *   ICON                  square-capped 24px stroke icons (one family).
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ─── Sigils ─────────────────────────────────────────────────────────
 * A 17×17 seal drawn from two things:
 *
 *   the NAME  draws the inside. Its letters are pen strokes: each byte
 *             of the (NFKC, lower-cased) name turns the pen one of eight
 *             ways and moves it 1–4 cells, bouncing off the walls; every
 *             word starts a new stroke from the spine. The left half is
 *             drawn and mirrored, so a name reads as an emblem with a
 *             shape of its own — "ana" and "anna" look related but not
 *             alike, "nadia" and "ravi" nothing alike.
 *   the KEY   draws the rim. The 64 cells of the border ARE the 64 bits
 *             of the fingerprint, one cell per bit, clockwise from the
 *             top-left. Two different identities can never share a rim.
 *
 * So a sigil is unique per person by construction (the rim is the
 * fingerprint), and recognisable per name (the inside). Someone who copies
 * your nickname gets your inside and a different rim — the difference is
 * meant to be seen, which is why the inside is not keyed: a name that
 * looks identical with a different border is exactly the warning sign.
 */
const SG = 17, SGI = SG - 2, SGMID = 8;

function fnv32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** The inside: a 15×15 bitmap drawn by the name. */
export function sigilInterior(name) {
  const norm = String(name || '?').normalize('NFKC').toLowerCase().trim() || '?';
  const cells = new Uint8Array(SGI * SGI);
  const set = (x, y) => { cells[y * SGI + x] = 1; cells[y * SGI + (SGI - 1 - x)] = 1; };
  const words = norm.split(/[\s_.\-]+/).filter(Boolean);
  const bytes = (w) => [...new TextEncoder().encode(w)];
  const spin = fnv32(norm), spin2 = fnv32('sigil|' + norm);   // the whole name nudges every stroke
  let x = 7, y = 7, heading = spin & 7;
  const step = (b, i) => {
    const v = (b ^ (spin2 >>> ((i * 7) % 25))) & 0xff;      // all 8 bits of the byte count
    heading = (heading + (v & 7) + ((v >> 6) & 1)) & 7;
    const len = 1 + ((v >> 3) & 3);
    for (let k = 0; k < len; k++) {
      let [dx, dy] = DIRS[heading];
      if (x + dx < 0 || x + dx > 7) { heading = (8 - heading) & 7; dx = -dx; }   // bounce off the spine / wall
      if (y + dy < 0 || y + dy > SGI - 1) { heading = (12 - heading) & 7; dy = -dy; }
      x += dx; y += dy;
      set(x, y);
    }
  };
  let i = 0;
  words.forEach((w, wi) => {
    // each word starts a new stroke, at a place set by its order and letters
    const hw = fnv32(w + '|' + wi);
    x = hw & 7; y = (hw >>> 3) % SGI;
    set(x, y);
    for (const b of bytes(w)) step(b, i++);
  });
  // the name's own hash signs off the drawing: four more strokes, so short
  // names are as full (and as distinct) as long ones
  for (let k = 0; k < 4; k++) step((spin2 >>> (k * 8)) & 0xff, i++);
  let lit = cells.reduce((a, c) => a + c, 0);
  for (let r = 0; lit < 24 && r < 3; r++) {
    for (const b of bytes(norm).reverse()) step(b ^ (0x55 + r), i++);
    lit = cells.reduce((a, c) => a + c, 0);
  }
  return cells;
}

/** The rim: the fingerprint's 64 bits, clockwise from the top-left corner. */
export function sigilRim(fp) {
  const hex = String(fp || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 16).padEnd(16, '0');
  const bits = [];
  for (const ch of hex) { const v = parseInt(ch, 16); for (let k = 3; k >= 0; k--) bits.push((v >> k) & 1); }
  const pos = [];
  for (let c = 0; c < SG - 1; c++) pos.push([c, 0]);
  for (let r = 0; r < SG - 1; r++) pos.push([SG - 1, r]);
  for (let c = SG - 1; c > 0; c--) pos.push([c, SG - 1]);
  for (let r = SG - 1; r > 0; r--) pos.push([0, r]);
  return pos.map((p, k) => [p[0], p[1], bits[k]]);   // 64 positions, 64 bits
}

/* ─── Drawn sigils ──────────────────────────────────────────────────
 * People can draw their own inside, at 8, 12, 16, 24 or 32 cells a side.
 * The drawing replaces the name's strokes; the rim stays the fingerprint,
 * so a copied drawing still shows a different seal.
 *
 * Wire/storage form: "<n>:<base64 of n×n bits, row-major, MSB first>"
 * (32×32 = 128 bytes → 172 characters at most).
 */
export const PIXEL_SIZES = [8, 12, 16, 24, 32];
export function parsePixels(str) {
  const m = /^(8|12|16|24|32):([A-Za-z0-9+/]{1,176}={0,2})$/.exec(String(str || ''));
  if (!m) return null;
  const n = +m[1];
  let raw;
  try { raw = atob(m[2]); } catch (e) { return null; }
  if (raw.length !== Math.ceil(n * n / 8)) return null;
  const bits = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) bits[i] = (raw.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
  return { n, bits };
}
export function encodePixels(n, bits) {
  const bytes = new Uint8Array(Math.ceil(n * n / 8));
  for (let i = 0; i < n * n; i++) if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  let b = ''; for (const x of bytes) b += String.fromCharCode(x);
  return n + ':' + btoa(b);
}
/** The name's generated inside, resampled to n×n (a starting point for drawing). */
export function interiorAt(name, n) {
  const src = sigilInterior(name), out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    out[y * n + x] = src[Math.min(SGI - 1, Math.floor((y + 0.5) * SGI / n)) * SGI + Math.min(SGI - 1, Math.floor((x + 0.5) * SGI / n))];
  }
  return out;
}

// Drawn sigils of the people we know, by fingerprint (set by app.js as
// peers announce them). Every avatar render consults it.
const PIX = new Map();
const fpKey = (fp) => String(fp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
export function setPixels(fp, px) {
  const k = fpKey(fp);
  if (!k) return;
  if (px && parsePixels(px)) PIX.set(k, px); else PIX.delete(k);
}

/** SVG markup of a sigil. Colour comes from CSS (`currentColor`). */
export function sigilSvg(name, fp, extraClass, pixels) {
  const drawn = parsePixels(pixels || (fp ? PIX.get(fpKey(fp)) : ''));
  let d = '';
  if (drawn) {
    // n×n cells inside the 15-unit interior
    const { n, bits } = drawn, c = SGI / n, f = (v) => +(v).toFixed(3);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!bits[y * n + x]) continue;
        let w = 1; while (x + w < n && bits[y * n + x + w]) w++;
        d += 'M' + f(1 + x * c) + ' ' + f(1 + y * c) + 'h' + f(w * c) + 'v' + f(c) + 'h-' + f(w * c) + 'z';
        x += w - 1;
      }
    }
  } else {
    const cells = sigilInterior(name);
    for (let y = 0; y < SGI; y++) {
      for (let x = 0; x < SGI; x++) {
        if (!cells[y * SGI + x]) continue;
        let w = 1; while (x + w < SGI && cells[y * SGI + x + w]) w++;
        d += 'M' + (x + 1) + ' ' + (y + 1) + 'h' + w + 'v1h-' + w + 'z';
        x += w - 1;
      }
    }
  }
  let r = '';
  if (fp) for (const [cx, cy, on] of sigilRim(fp)) if (on) r += 'M' + cx + ' ' + cy + 'h1v1h-1z';
  return '<svg class="sig' + (extraClass ? ' ' + extraClass : '') + '" viewBox="0 0 17 17"' + (drawn && drawn.n > SGI ? '' : ' shape-rendering="crispEdges"') + ' aria-hidden="true">'
    + (r ? '<path class="sig-rim" d="' + r + '"/>' : '')
    + '<path d="' + d + '"/></svg>';
}

/** Back-compat name: a sigil of `name` sealed with fingerprint `seed`. */
export function identiconHtml(seed, extraClass, name) {
  const fpLike = /^[0-9a-f\s]{16,}$/i.test(String(seed || ''));
  return sigilSvg(name || (fpLike ? '' : seed) || seed, fpLike ? seed : '', extraClass);
}

/** The one avatar rule: uploaded image > chosen emoji > key identicon.
 *  `seed` should be the fingerprint; falls back to the nickname. */
export function avatarHtml(nickname, emoji, image, seed, pixels) {
  if (image) return '<img src="' + esc(image) + '" alt="">';
  // A drawn sigil beats an emoji: it still carries the fingerprint rim.
  if (pixels || (seed && PIX.has(fpKey(seed)))) return sigilSvg(nickname, seed, '', pixels);
  if (emoji) return '<span class="av-emoji">' + esc(emoji) + '</span>';
  return identiconHtml(seed || nickname || '?', '', nickname);
}

/** Hex string (any separators) → bytes. Odd trailing nibble is dropped. */
export function hexBytes(str) {
  const hex = String(str || '').replace(/[^0-9a-fA-F]/g, '');
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export function hexDumpHtml(bytes) {
  let h = '';
  for (let i = 0; i < bytes.length; i += 8) {
    h += '<span class="off">' + i.toString(16).padStart(4, '0') + '</span>';
    for (let j = i; j < i + 8; j++) {
      h += j < bytes.length
        ? '<span>' + bytes[j].toString(16).padStart(2, '0') + '</span>'
        : '<span class="pad">··</span>';
    }
  }
  return h;
}

/** OpenSSH-style randomart (17×9 field, drunken bishop walk).
 *  Returns escaped HTML with the start/end cells wrapped in <b>. */
export function randomart(bytes, title, foot) {
  const W = 17, H = 9, sym = ' .o+=*BOX@%&#/^';
  const f = new Array(W * H).fill(0);
  let x = 8, y = 4;
  for (const b of bytes) {
    for (let s = 0; s < 4; s++) {
      const d = (b >> (s * 2)) & 3;
      x += (d & 1) ? 1 : -1; y += (d & 2) ? 1 : -1;
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
      f[y * W + x]++;
    }
  }
  const frame = (label) => {
    const l = label ? '[' + label + ']' : '';
    const left = Math.floor((W - l.length) / 2);
    return '+' + '-'.repeat(Math.max(0, left)) + l + '-'.repeat(Math.max(0, W - left - l.length)) + '+';
  };
  let out = esc(frame(title || 'X25519')) + '\n';
  for (let j = 0; j < H; j++) {
    let row = '|';
    for (let i = 0; i < W; i++) {
      if (i === 8 && j === 4) row += '<b>S</b>';
      else if (i === x && j === y) row += '<b>E</b>';
      else row += esc(sym[Math.min(f[j * W + i], sym.length - 1)]);
    }
    out += row + '|\n';
  }
  return out + esc(frame(foot || 'SHA256'));
}

/** "6556-6DA2…" → ["6556","6DA2",…] (upper-case 4-char groups). */
export function fpGroups(str, max) {
  const hex = String(str || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const g = [];
  for (let i = 0; i < hex.length && g.length < (max || 4); i += 4) g.push(hex.slice(i, i + 4));
  return g;
}

/* One icon family: 24px grid, 1.5 stroke, square caps, mitred joins. */
const svg = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true" class="ic"><path d="' + d + '"/></svg>';
export const ICON = {
  reply:  svg('M10 6l-6 6 6 6M4 12h11a5 5 0 0 1 5 5v2'),
  react:  svg('M4 4h16v16H4zM12 8v8M8 12h8'),
  pin:    svg('M9 3h6v7l3 4H6l3-4zM12 14v7'),
  unpin:  svg('M9 3h6v7l3 4H6l3-4zM12 14v7M3 3l18 18'),
  copy:   svg('M8 8h12v12H8zM4 16V4h12'),
  edit:   svg('M4 20h4L19 9l-4-4L4 16zM13 7l4 4'),
  trash:  svg('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6'),
  close:  svg('M5 5l14 14M19 5L5 19'),
  file:   svg('M5 3h10l4 4v14H5zM15 3v4h4M8 12h8M8 16h8'),
  save:   svg('M12 4v11M7 10l5 5 5-5M4 20h16'),
};
