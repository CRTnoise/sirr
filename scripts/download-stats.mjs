#!/usr/bin/env node
// Download counts for the README, without any third-party badge service.
//
// Reads every published release through the GitHub API, adds up the
// download counts per kind of file (across all versions), and writes small
// SVG counters in Sirr's colours plus a stats.json into <outDir>. The
// "Download stats" workflow publishes them on the `stats` branch, and the
// README shows them from there.
//
//   GH_TOKEN=… REPO=owner/name node scripts/download-stats.mjs out
//   STATS_FIXTURE=releases.json node scripts/download-stats.mjs out   (offline)
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'out';
const repo = process.env.REPO || 'CRTnoise/sirr';
const KINDS = [
  ['win-setup', /setup.*\.exe$/i],
  ['win-portable', /portable.*\.exe$/i],
  ['linux-appimage', /\.appimage$/i],
  ['linux-deb', /\.deb$/i],
];

async function releases() {
  if (process.env.STATS_FIXTURE) return JSON.parse(fs.readFileSync(process.env.STATS_FIXTURE, 'utf8'));
  const all = [];
  for (let page = 1; page < 20; page++) {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sirr-download-stats',
                 ...(process.env.GH_TOKEN ? { authorization: 'Bearer ' + process.env.GH_TOKEN } : {}) },
    });
    if (!r.ok) throw new Error('GitHub API ' + r.status + ': ' + (await r.text()).slice(0, 200));
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => n.toLocaleString('en-US');
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const C = { bg: '#0b0d10', edge: '#262a31', dim: '#8b919a', hi: '#e3e6ea', acc: '#4fe0a0' };

// A row of label/value cells, e.g. [['DOWNLOADS', '1,204']]. Widths come
// from character counts — every font in the stack is monospaced.
function chip(cells, { h = 24, size = 11 } = {}) {
  const cw = size * 0.62, track = 1.4, pad = 10;
  let x = 0, body = '';
  cells.forEach(([label, value], i) => {
    const lw = label ? label.length * (cw + track) : 0;
    const vw = value.length * cw;
    const w = pad + lw + (label && value ? 8 : 0) + vw + pad;
    if (i) body += `<line x1="${x}" y1="5" x2="${x}" y2="${h - 5}" stroke="${C.edge}"/>`;
    if (label) body += `<text x="${x + pad}" y="${h / 2}" fill="${C.dim}" letter-spacing="${track}">${esc(label)}</text>`;
    if (value) body += `<text x="${x + pad + lw + (label ? 8 : 0)}" y="${h / 2}" fill="${i === 0 && cells.length > 1 ? C.acc : C.hi}">${esc(value)}</text>`;
    x += w;
  });
  const W = Math.ceil(x);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(cells.map(c => c.filter(Boolean).join(' ')).join(', '))}">`
    + `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="4" fill="${C.bg}" stroke="${C.edge}"/>`
    + `<g font-family="${MONO}" font-size="${size}" dominant-baseline="central">${body}</g></svg>\n`;
}

const list = (await releases()).filter((r) => !r.draft);
const counts = Object.fromEntries(KINDS.map(([k]) => [k, 0]));
for (const r of list) for (const a of r.assets || []) {
  const kind = KINDS.find(([, re]) => re.test(a.name));
  if (kind) counts[kind[0]] += a.download_count || 0;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const latest = list.find((r) => !r.prerelease);
const version = latest ? latest.tag_name : '—';

fs.mkdirSync(out, { recursive: true });
for (const [k] of KINDS) fs.writeFileSync(path.join(out, k + '.svg'), chip([['DOWNLOADS', fmt(counts[k])]]));
fs.writeFileSync(path.join(out, 'summary.svg'),
  chip([['LATEST', version], ['DOWNLOADS', fmt(total)], ['', 'FREE · AGPL-3.0']], { h: 28, size: 12 }));
fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify({ version, total, counts, updated: new Date().toISOString() }, null, 2) + '\n');
console.log(version, total, counts);
