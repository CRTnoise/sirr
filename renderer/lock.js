// Lock screen. Talks only to window.sirrLock (preload-lock.js).
(() => {
  const f = document.getElementById('f'), p = document.getElementById('p');
  const msg = document.getElementById('msg'), go = document.getElementById('go');
  let timer = null;
  const hold = (s) => {
    clearInterval(timer); go.disabled = true;
    const tick = () => {
      if (s <= 0) { clearInterval(timer); go.disabled = false; msg.textContent = 'Wrong passphrase.'; p.focus(); return; }
      msg.textContent = 'Wrong passphrase. Try again in ' + s + ' s.'; s--;
    };
    tick(); timer = setInterval(tick, 1000);
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (go.disabled || !p.value) return;
    go.disabled = true; msg.textContent = 'Deriving key…'; document.body.classList.add('busy');
    const r = await window.sirrLock.unlock(p.value);
    document.body.classList.remove('busy');
    if (r && r.ok) { p.value = ''; msg.textContent = 'Opening…'; return; }
    p.select();
    if (r && r.wait) hold(r.wait); else { go.disabled = false; msg.textContent = 'Wrong passphrase.'; }
  });
  document.getElementById('quit').addEventListener('click', () => window.sirrLock.quit());
})();
