// modules/figure.js — mount a hairline figure into the UI.
//
// Figures register themselves through vendor/hairline-host.js. A mount
// returns { destroy } and must be destroyed when its element leaves the
// page: figures join a shared frame loop.

export function mountFigure(host, name) {
  const HL = window.HL, fig = window.__hairlineFigures && window.__hairlineFigures.get(name);
  if (!HL || !fig || !host) return null;
  try {
    HL.inject(document);
    const stage = document.createElement('div');
    stage.className = 'figure-stage';
    stage.setAttribute('data-hairline', fig.name);
    stage.setAttribute('data-hairline-theme', 'dark');
    stage.setAttribute('role', 'img');
    stage.setAttribute('aria-label', fig.means);
    const svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, stage);
    const read = document.createElement('div');
    read.className = 'figure-read';
    read.setAttribute('aria-hidden', 'true');
    host.append(stage, read);
    const handle = fig.mount({ stage, svg, read }, fig.range[1]);
    return { destroy() { try { handle.destroy(); } catch (e) {} stage.remove(); read.remove(); } };
  } catch (e) {
    return null;
  }
}
