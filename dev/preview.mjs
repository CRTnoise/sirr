/**
 * Screenshot the renderer in plain Chromium with dev/preview-stub.js.
 *
 *   node dev/preview.mjs [rendererDir] [outPrefix]
 *
 * Writes <outPrefix>-{join,chat,empty}.png. Needs playwright.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const rendererDir = path.resolve(process.argv[2] || path.join(root, 'renderer'));
const out = process.argv[3] || path.join(root, 'dev', 'shot');
const scale = Number(process.env.SCALE || 1);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const base = u.startsWith('/renderer/') ? path.join(rendererDir, u.slice('/renderer/'.length)) : path.join(root, u);
  if (!base.startsWith(root) && !base.startsWith(rendererDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(base, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    let body = buf;
    if (base.endsWith('index.html')) {
      body = buf.toString('utf8').replace('<head>', '<head><script src="/dev/preview-stub.js"></script>')
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(base)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch();
const sizes = (process.env.SIZES || '1280x800').split(',').map(s => s.split('x').map(Number));
const errors = [];
for (const [w, h] of sizes) {
  for (const screen of (process.env.SCREENS || 'join,chat,empty').split(',')) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale, colorScheme: 'dark' });
    page.on('pageerror', e => errors.push(screen + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(screen + ' console: ' + m.text()); });
    await page.goto(`http://localhost:${port}/renderer/index.html?screen=${screen}`);
    await page.waitForTimeout(1200);
    const suffix = sizes.length > 1 ? `-${w}` : '';
    await page.screenshot({ path: `${out}-${screen}${suffix}.png` });
    await page.close();
  }
}
await browser.close();
server.close();
if (errors.length) { console.log('page errors:\n  ' + [...new Set(errors)].join('\n  ')); }
console.log('wrote', out + '-*.png');
