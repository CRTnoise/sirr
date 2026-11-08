// Screen / window picker for screen share. Talks to main through
// picker-preload.js; loaded by picker.html.
(function () {
  const esc = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  const g = document.getElementById('g');
  const cancelBtn = document.getElementById('cancel');

  cancelBtn.addEventListener('click', () => window.sirrPicker.cancel());
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') window.sirrPicker.cancel(); });

  window.sirrPicker.getSources().then(items => {
    if (!items || !items.length) {
      g.innerHTML = '<div class="empty">No screens or windows available.</div>';
      return;
    }
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'it';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.innerHTML = '<img src="' + esc(it.thumbnail) + '"><div class="nm">' + esc(it.name) + '</div>';
      const pick = () => window.sirrPicker.pick(it.id);
      el.addEventListener('click', pick);
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      g.appendChild(el);
    }
  }).catch(() => {
    g.innerHTML = '<div class="empty">Failed to load sources.</div>';
  });
})();
