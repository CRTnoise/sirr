// modules/ctxmenu.js — right-click menus.
// One sharp, mono panel used everywhere: messages, rooms, channels, voice
// participants, members. Items: { label, act, danger, hint } | 'sep' |
// { reactions: [...], act(emoji) } | { slider: {label,min,max,value,onInput} }.
let el = null;

function close () {
  if (!el) return;
  el.remove(); el = null;
  document.removeEventListener('mousedown', onDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
  document.removeEventListener('scroll', close, true);
}
function onDown (e) { if (el && !el.contains(e.target)) close(); }
function onKey (e) { if (e.key === 'Escape') close(); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function openMenu (x, y, items, title) {
  close();
  el = document.createElement('div');
  el.className = 'ctx';
  let h = title ? '<div class="ctx-t">' + esc(title) + '</div>' : '';
  items.forEach((it, i) => {
    if (!it) return;
    if (it === 'sep') { h += '<div class="ctx-sep"></div>'; return; }
    if (it.reactions) {
      h += '<div class="ctx-rx">' + it.reactions.map((e) => '<button data-i="' + i + '" data-e="' + esc(e) + '">' + esc(e) + '</button>').join('') + '</div>';
      return;
    }
    if (it.slider) {
      const s = it.slider;
      h += '<label class="ctx-sl"><span>' + esc(s.label) + '</span><input type="range" data-i="' + i + '" min="' + s.min + '" max="' + s.max + '" value="' + s.value + '"><b>' + s.value + '%</b></label>';
      return;
    }
    h += '<button class="ctx-i' + (it.danger ? ' danger' : '') + '" data-i="' + i + '"><span>' + esc(it.label) + '</span>' + (it.hint ? '<em>' + esc(it.hint) + '</em>' : '') + '</button>';
  });
  el.innerHTML = h;
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    const it = items[+b.dataset.i];
    close();
    try { it.reactions ? it.act(b.dataset.e) : it.act(); } catch (err) { console.warn('[ctx]', err); }
  });
  el.addEventListener('input', (e) => {
    const inp = e.target.closest('input[type=range]'); if (!inp) return;
    const it = items[+inp.dataset.i];
    inp.nextElementSibling.textContent = inp.value + '%';
    try { it.slider.onInput(+inp.value); } catch (err) {}
  });
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
  }, 0);
}
export const closeMenu = close;
