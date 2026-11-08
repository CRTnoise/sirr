// modules/sigil-editor.js — draw your own sigil.
//
// A pixel grid of 8, 12, 16, 24 or 32 cells a side. Click or drag to draw,
// right-click (or the eraser) to erase, mirror to draw both halves at once.
// Changing the size resamples what's there, so detail can be added later.
// What you draw replaces your name's strokes inside the seal; the rim
// stays your fingerprint (glyphs.sigilSvg), which is what tells copies apart.

import * as glyphs from './glyphs.js';

export function mountSigilEditor(root, { name, fingerprint, value, onSave }) {
  let n = 16, bits = new Uint8Array(n * n), mirror = true, erase = false, painting = 0;
  const start = glyphs.parsePixels(value);
  if (start) { n = start.n; bits = start.bits; }
  else bits = glyphs.interiorAt(name(), n);

  root.innerHTML = `
    <div class="sge">
      <div class="sge-grid" role="grid" aria-label="Sigil drawing grid"></div>
      <div class="sge-side">
        <div class="sge-preview" aria-hidden="true"></div>
        <div class="sp sge-sizes">${glyphs.PIXEL_SIZES.map(s => `<button data-n="${s}">${s}</button>`).join('')}</div>
        <div class="sge-tools">
          <button class="topt" data-t="mirror">MIRROR</button>
          <button class="topt" data-t="erase">ERASER</button>
          <button class="topt ghost" data-t="name">FROM NAME</button>
          <button class="topt ghost" data-t="invert">INVERT</button>
          <button class="topt ghost" data-t="clear">CLEAR</button>
        </div>
        <div class="sge-actions">
          <button class="topt sge-save" data-t="save">USE THIS SIGIL</button>
          <button class="topt ghost" data-t="reset">USE GENERATED</button>
        </div>
      </div>
    </div>`;
  const grid = root.querySelector('.sge-grid'), prev = root.querySelector('.sge-preview');

  function build() {
    grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    grid.innerHTML = '<i></i>'.repeat(n * n);
    paint();
    root.querySelectorAll('.sge-sizes button').forEach(b => b.classList.toggle('act', +b.dataset.n === n));
  }
  function paint() {
    const cells = grid.children;
    for (let i = 0; i < n * n; i++) cells[i].className = bits[i] ? 'on' : '';
    prev.innerHTML = glyphs.sigilSvg(name(), fingerprint(), '', glyphs.encodePixels(n, bits));
  }
  function setCell(i, v) {
    bits[i] = v;
    if (mirror) { const x = i % n, y = (i / n) | 0; bits[y * n + (n - 1 - x)] = v; }
  }
  const idxOf = (e) => { const el = e.target.closest('.sge-grid > i'); return el ? [...grid.children].indexOf(el) : -1; };
  grid.addEventListener('contextmenu', e => e.preventDefault());
  grid.addEventListener('pointerdown', e => {
    const i = idxOf(e); if (i < 0) return;
    painting = (erase || e.button === 2) ? -1 : 1;
    setCell(i, painting > 0 ? 1 : 0); paint();
    grid.setPointerCapture?.(e.pointerId);
  });
  grid.addEventListener('pointermove', e => {
    if (!painting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.parentNode !== grid) return;
    const i = [...grid.children].indexOf(el);
    if (i >= 0 && bits[i] !== (painting > 0 ? 1 : 0)) { setCell(i, painting > 0 ? 1 : 0); paint(); }
  });
  const stop = () => { painting = 0; };
  grid.addEventListener('pointerup', stop); grid.addEventListener('pointercancel', stop);

  root.querySelector('.sge-sizes').addEventListener('click', e => {
    const b = e.target.closest('button[data-n]'); if (!b) return;
    const m = +b.dataset.n; if (m === n) return;
    const out = new Uint8Array(m * m);       // nearest-neighbour resample
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) out[y * m + x] = bits[Math.floor((y + 0.5) * n / m) * n + Math.floor((x + 0.5) * n / m)];
    n = m; bits = out; build();
  });
  root.querySelector('.sge-side').addEventListener('click', e => {
    const t = e.target.closest('[data-t]')?.dataset.t; if (!t) return;
    if (t === 'mirror') { mirror = !mirror; e.target.classList.toggle('act', mirror); return; }
    if (t === 'erase') { erase = !erase; e.target.classList.toggle('act', erase); return; }
    if (t === 'name') bits = glyphs.interiorAt(name(), n);
    if (t === 'invert') bits = bits.map(b => 1 - b);
    if (t === 'clear') bits = new Uint8Array(n * n);
    if (t === 'save') { onSave(glyphs.encodePixels(n, bits)); return; }
    if (t === 'reset') { onSave(''); bits = glyphs.interiorAt(name(), n); }
    paint();
  });
  root.querySelector('[data-t="mirror"]').classList.toggle('act', mirror);
  build();
  return { refresh: paint };
}
