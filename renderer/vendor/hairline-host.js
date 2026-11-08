/**
 * Host for hairline figures. A figure file ends with `hairline({...})`; this
 * collects them so the UI can mount one into any element (see
 * modules/figure.js). Classic script: it must run before the figure files.
 */
(() => {
  const figures = new Map();
  window.hairline = (fig) => { if (fig && fig.name) figures.set(fig.name, fig); };
  window.__hairlineFigures = figures;
})();
