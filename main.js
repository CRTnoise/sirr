/**
 * Sirr — main process
 * ════════════════════════
 * Owns everything the renderer must not touch: keys, storage, the swarm,
 * file I/O and the OS. The renderer talks to it only through the IPC
 * surface in preload.js, and every handler checks that the call comes
 * from the app window's top frame.
 *
 *   lib/crypto-layer   identity key, forward-secret sessions, room signing keys
 *   lib/network        Hyperswarm rooms, the wire protocol, membership proofs
 *   lib/storage        rooms, contacts, history (SQLite), sealed by lib/vault
 *   lib/transfers      BOLT file transfer, streamed to encrypted files
 *   lib/core-events    every "is this peer allowed to…" decision
 */

const { app, BrowserWindow, ipcMain, Menu, Tray, session, desktopCapturer, clipboard, nativeImage, dialog, shell, safeStorage, powerMonitor, globalShortcut } = require('electron');
const AppLock = require('./lib/applock');
const { Pathways, serveBridge } = require('./lib/pathways');
const { Nearby } = require('./lib/nearby');
const { LanCarrier } = require('./lib/nearby-lan');
const { BleCarrier } = require('./lib/nearby-ble');
const { Echoes } = require('./lib/echoes');
const TransferManager = require('./lib/transfers');
const msgsig = require('./lib/msgsig');
const Vault = require('./lib/vault');
const Backup = require('./lib/backup');
const NetGuard = require('./lib/netguard');
const { wireCore } = require('./lib/core-events');
const fs = require('fs');
const http = require('http');
const https = require('https');
const QRCode = require('qrcode');

const path = require('path');
const SirrCrypto = require('./lib/crypto-layer');
const SirrNetwork = require('./lib/network');
const SirrStorage = require('./lib/storage');
const RoomCode = require('./lib/roomcode');

// ── Crash safety ─────────────────────────────────────────────────────
// An uncaught throw in main must not lose pending config writes (rooms,
// contacts, blocklist live there). Flush, log, then exit non-zero.
process.on('uncaughtException', (err) => {
  try { console.error('[sirr] uncaughtException:', err); } catch (e) {}
  try { if (sirrStorage) sirrStorage.flushSync(); } catch (e) {}
  try { if (sirrStorage) sirrStorage.close(); } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[sirr] unhandledRejection:', reason); } catch (e) {}
});

// Every renderer is sandboxed, including ones created by future code paths.
app.enableSandbox();

let mainWindow, sirrCrypto, sirrNetwork, sirrStorage, sirrVault;
let appLock = null, lockWindow = null;
let echoes = null, _echoTimer = null;
let pathways = null, nearby = null, lanCarrier = null, bleCarrier = null, bridgeServer = null;
let sirrTransfers = null;
function _uniquePath(dir, name) {
  const safe = TransferManager.safeName(name);
  const ext = path.extname(safe), base = path.basename(safe, ext);
  let p = path.join(dir, safe), k = 1;
  while (fs.existsSync(p) && k < 1000) p = path.join(dir, base + ' (' + (k++) + ')' + ext);
  return p;
}
let _sweepTimer = null;

// Disappearing messages: delete everything past its TTL and tell the renderer
// which msgIds vanished so any open view can drop them live. Safe to call
// often — it's a single indexed DELETE plus a list the same size as what
// actually expired (usually zero).
function _runSweep() {
  if (!sirrStorage) return;
  let removed = [];
  try { removed = sirrStorage.sweepExpiredMessages(Date.now()); } catch (e) { removed = []; }
  if (removed && removed.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('messages-expired', removed);
  }
}
let tray = null; // Global reference to prevent garbage collection
let isQuitting = false; // Flag to distinguish between 'X' and 'Quit'
// ─── Deep-link protocol: sirr://join/<code> ─────────────────────
// We require a single-instance lock so that clicking a `sirr://...`
// link while the app is already running routes into the existing window
// instead of spawning a duplicate process. The queued deep link is
// delivered to the renderer as soon as it's ready to receive it.
let pendingDeepLink = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find(a => typeof a === 'string' && a.startsWith('sirr://'));
    if (url) handleDeepLink(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
// macOS delivers deep links via open-url rather than argv.
app.on('open-url', (e, url) => { e.preventDefault(); handleDeepLink(url); });

// Register ourselves as handler for sirr:// — on dev we pass explicit
// args so Electron's CLI invocation is reproducible.
try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('sirr', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('sirr');
  }
} catch (e) {}

// Scan initial argv (Windows delivers the URL on first launch via argv)
for (const a of process.argv) {
  if (typeof a === 'string' && a.startsWith('sirr://')) {
    pendingDeepLink = a;
    break;
  }
}

function handleDeepLink(url) {
  const code = RoomCode.parseInviteUrl(url);
  if (!code) return;
  try { pathways && pathways.addHints(RoomCode.parseInviteHints(url)); } catch (e) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deep-link:join', { code });
  } else {
    pendingDeepLink = url;
  }
}

// ─── Popup browser hardening ────────────────────────────────────────
// Options applied to every in-app popup that renders remote content. The
// popup MUST NOT get our preload (it would expose `window.sirr` to the
// remote page), MUST NOT have nodeIntegration, MUST be sandboxed, and lives
// in its own session partition so cookies/storage never mix with the app.
function _popupWindowOptions(_url) {
  return {
    width: 1100,
    height: 780,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // In-memory: cookies from links you open die with the app, so sites
      // can't track you across sessions through Sirr's link window.
      partition: 'sirr-browser',
      // Deliberately omit `preload` — remote web content must never see
      // the sirr IPC bridge.
    },
  };
}

// Apply navigation + popup guards to every web-contents ever created so a
// popup can't spawn a third, unhardened window, and can't be redirected to
// non-http(s) schemes (sirr://, file://, javascript:).
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => {
    const isMain = (mainWindow && wc === mainWindow.webContents) || (lockWindow && !lockWindow.isDestroyed() && wc === lockWindow.webContents);
    // The app window never navigates: it is a single page. Allowing any
    // file:// URL would let a script injected into it load some other local
    // HTML file (a received download, say) with the preload bridge attached.
    if (isMain) ev.preventDefault();
    else if (!/^https?:\/\//i.test(url)) ev.preventDefault();
  });
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    // The voice module pops out shared-screen / camera streams via
    // `window.open('', name, ...)`, which Chromium normalizes to `about:blank`.
    // Only the main window may spawn one — they're our own UI surface, no
    // remote content, sandboxed, no preload, no node. Anything from a
    // non-main wc (e.g. a popup spawning another popup) keeps the strict
    // http(s)-only rule.
    const isMain = mainWindow && wc === mainWindow.webContents;
    if (isMain && (url === 'about:blank' || url === '')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 900, height: 560, backgroundColor: '#000',
          autoHideMenuBar: true,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        },
      };
    }
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: _popupWindowOptions(url) };
  });
});

// ─── Link preview fetcher: SSRF-guarded, see lib/netguard.js ──────────
const { resolveSafeUrl: _resolveSafePreviewUrl, pinnedLookup: _pinnedLookup } = NetGuard;

function _fetchPreviewHop(url, userAgent, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, {
      method: 'GET',
      lookup: _pinnedLookup,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const status = Number(res.statusCode) || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(location ? { redirect: location } : null);
      }
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('html')) {
        res.resume();
        return finish(null);
      }
      let size = 0;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (settled) return;
        size += Buffer.byteLength(chunk, 'utf8');
        if (size > 256 * 1024) {
          settled = true;
          req.destroy();
          return resolve(null);
        }
        body += chunk;
      });
      res.on('end', () => finish({ body }));
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error('preview-fetch-failed'));
    };
    req.on('error', fail);
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('preview-timeout'));
      resolve(null);
    });
    req.end();
  });
}

// preview images. The renderer's CSP only allows data:/blob: images
// (remote loads would leak your IP to every image host), so og:image never
// displayed. Main fetches it through the same private-range guard and
// DNS-pinned lookup as the page itself and returns a small data: URL.
async function _fetchPreviewImage(rawUrl, userAgent, hops = 2) {
  const safe = await _resolveSafePreviewUrl(rawUrl);
  if (!safe) return '';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const transport = safe.protocol === 'https:' ? https : http;
    const req = transport.request(safe, { method: 'GET', lookup: _pinnedLookup, headers: { 'User-Agent': userAgent, 'Accept': 'image/*' } }, (res) => {
      const status = Number(res.statusCode) || 0;
      if (status >= 300 && status < 400 && res.headers.location && hops > 0) {
        res.resume();
        let next; try { next = new URL(res.headers.location, safe).toString(); } catch (e) { return finish(''); }
        return _fetchPreviewImage(next, userAgent, hops - 1).then(finish, () => finish(''));
      }
      const ct = String(res.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
      if (status !== 200 || !/^image\/(png|jpeg|gif|webp)$/.test(ct)) { res.resume(); return finish(''); }
      const parts = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 512 * 1024) { req.destroy(); return finish(''); }
        parts.push(c);
      });
      res.on('end', () => finish('data:' + ct + ';base64,' + Buffer.concat(parts).toString('base64')));
    });
    req.on('error', () => finish(''));
    req.setTimeout(5000, () => { req.destroy(); finish(''); });
    req.end();
  });
}

// A generic browser User-Agent: naming the app would tell every linked
// site that this visitor runs a privacy messenger.
const PREVIEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function _fetchLinkPreviewDocument(startUrl, userAgent) {
  const MAX_REDIRECTS = 5;
  const deadline = Date.now() + 5000;
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const res = await _fetchPreviewHop(current, userAgent, remaining).catch(() => null);
    if (!res) return null;
    if (res.redirect) {
      const next = await _resolveSafePreviewUrl(res.redirect, current);
      if (!next) return null;
      current = next.toString();
      continue;
    }
    return { url: current, body: res.body };
  }
  return null;
}

// ─── Permissions ────────────────────────────────────────────────────
// Only media-related permissions are granted; everything else is denied.
// Only the app window may ask, and only for capture and notifications.
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture', 'notifications']);
const _isAppContents = (wc) => !!(wc && mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents);

function setupSession() {
  const s = session.defaultSession;
  // No spellchecker: on Windows and Linux Chromium downloads Hunspell
  // dictionaries from a Google CDN at startup — a request outside the swarm,
  // on every launch, that tells a third party this IP runs the app.
  try { s.setSpellCheckerEnabled(false); s.setSpellCheckerLanguages([]); } catch (e) {}
  s.setPermissionRequestHandler((wc, perm, cb) => cb(_isAppContents(wc) && ALLOWED_PERMISSIONS.has(perm)));
  s.setPermissionCheckHandler((wc, perm) => _isAppContents(wc) && ALLOWED_PERMISSIONS.has(perm));
  s.setDisplayMediaRequestHandler(handleDisplayMediaRequest);
}

// Per-picker state keyed by webContents.id (assigned by Electron per window).
// We load a real HTML file (picker.html) instead of a data: URL because
// Electron 28 blocks inline scripts in data: URLs via CSP — that caused
// the UI to render but all click/cancel handlers to silently fail.
const pendingPickers = new Map(); // wcId -> { resolve, sources, items, window }

ipcMain.handle('sirr:picker:get-sources', (e) => {
  const p = pendingPickers.get(e.sender.id);
  return p ? p.items : [];
});

ipcMain.on('sirr:picker:pick', (e, id) => {
  const p = pendingPickers.get(e.sender.id);
  if (!p) return;
  const src = p.sources.find(s => s.id === id);
  p.resolve(src ? { video: src } : null);
});

ipcMain.on('sirr:picker:cancel', (e) => {
  const p = pendingPickers.get(e.sender.id);
  if (p) p.resolve(null);
});

// Proper screen/window picker. When the renderer calls getDisplayMedia(),
// Electron calls this handler. We open a small chooser window listing the
// available sources with thumbnails and resolve with the user's pick.
async function handleDisplayMediaRequest(_req, cb) {
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });
  } catch (e) {
    cb(); return;
  }
  if (!sources.length) { cb(); return; }
  if (sources.length === 1) { cb({ video: sources[0] }); return; }

  const picker = new BrowserWindow({
    width: 780, height: 520, parent: mainWindow, modal: true, show: false,
    backgroundColor: '#0b0d10', frame: false, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const items = sources.map(s => ({
    id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(),
  }));

  const wcId = picker.webContents.id;

  let resolved = false;
  const resolve = (pick) => {
    if (resolved) return;
    resolved = true;
    pendingPickers.delete(wcId);
    try { if (!picker.isDestroyed()) picker.close(); } catch (e) {}
    // pick === null means user cancelled — call cb() with no args so
    // Electron rejects the getDisplayMedia() promise with NotAllowedError
    // instead of throwing "video requested but none provided".
    if (pick && pick.video) cb({ video: pick.video });
    else cb();
  };

  pendingPickers.set(wcId, { resolve, sources, items, window: picker });

  picker.once('ready-to-show', () => picker.show());
  picker.on('closed', () => resolve(null));
  picker.loadFile(path.join(__dirname, 'picker.html'));
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 800, minHeight: 540,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#0b0d10', frame: true, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // closing to tray hides the window, and a hidden page gets its
      // timers throttled to 1 Hz (then once a minute). Voice heartbeats,
      // ICE recovery and mesh playback all run on timers — a call must
      // keep working while Sirr sits in the tray.
      backgroundThrottling: false,
      // Chromium's spellchecker fetches Hunspell dictionaries from a Google
      // CDN on Windows and Linux: a network request outside the swarm that
      // reveals the user's IP. Off.
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Opt-in: keep the window out of screenshots, screen recordings and
  // screen shares (Windows and macOS; no effect on Linux).
  try { mainWindow.setContentProtection(sirrStorage.getConfig().contentProtection === 'on'); } catch (e) {}
  // External http(s) links get an in-app popup that's hardened via the
  // `web-contents-created` handler defined at module scope (no preload, no
  // nodeIntegration, sandboxed, separate session). Non-http(s) navigations
  // are denied there too.

  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault(); // Stop the window from destroying
      mainWindow.hide();      // Just hide it
    }
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingDeepLink) {
      const url = pendingDeepLink;
      pendingDeepLink = null;
      // Small delay so the renderer's boot() has wired its listener.
      setTimeout(() => handleDeepLink(url), 400);
    }
  });
}
function createTray() {
  // Use your app icon. If on macOS, name it 'trayTemplate.png' for auto-color switching
  // A tray icon is drawn at 16–24 px (more on HiDPI), so it gets its own
  // glyph and real per-size bitmaps instead of a downscaled app icon:
  // Windows picks from a multi-size .ico, macOS gets a template image the
  // menu bar can tint, Linux gets 32 px with a 64 px @2x.
  const A = (f) => path.join(__dirname, 'assets', f);
  let icon;
  if (process.platform === 'win32') {
    icon = nativeImage.createFromPath(A('tray.ico'));
  } else if (process.platform === 'darwin') {
    icon = nativeImage.createFromPath(A('trayTemplate.png'));
    icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(A('trayTemplate@2x.png')) });
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(A('tray-32.png'));
    icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(A('tray-64.png')) });
  }
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'SHOW SIRR', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'QUIT', click: () => {
        isQuitting = true; 
        app.quit(); 
      } 
    }
  ]);

  tray.setToolTip('Sirr');
  tray.setContextMenu(contextMenu);

  // Clicking the tray icon restores the window
  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}
// ─── App lock window ────────────────────────────────────────────────
// With the lock on, this small window is the only thing that exists until
// the passphrase is right: no main window, no IPC surface, no network.
function showLockWindow() {
  return new Promise((resolve) => {
    lockWindow = new BrowserWindow({
      width: 420, height: 460, resizable: false, minimizable: true, maximizable: false,
      icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      backgroundColor: '#0b0d10', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-lock.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    Menu.setApplicationMenu(null);
    lockWindow.loadFile(path.join(__dirname, 'renderer', 'lock.html'));
    lockWindow.once('ready-to-show', () => lockWindow.show());
    let fails = 0, busyUntil = 0, settled = false;
    const own = (e) => lockWindow && !lockWindow.isDestroyed() && e.sender === lockWindow.webContents;
    ipcMain.handle('lock:unlock', async (e, pass) => {
      if (!own(e) || settled) return { ok: false };
      // Back-off after wrong guesses: 1 s, 2 s, 4 s … 30 s.
      const now = Date.now();
      if (now < busyUntil) return { ok: false, wait: Math.ceil((busyUntil - now) / 1000) };
      let r = 'bad';
      try { r = appLock.unlock(String(pass || '')); } catch (err) { r = 'bad'; }
      if (r === 'bad') {
        fails++; busyUntil = Date.now() + Math.min(30000, 1000 * 2 ** (fails - 1));
        return { ok: false, wait: Math.ceil((busyUntil - Date.now()) / 1000) };
      }
      settled = true;
      resolve(r);
      return { ok: true };
    });
    ipcMain.handle('lock:quit', (e) => { if (own(e)) app.exit(0); });
    lockWindow.on('closed', () => { lockWindow = null; if (!settled) app.exit(0); });
  });
}
function closeLockWindow() {
  try { ipcMain.removeHandler('lock:unlock'); ipcMain.removeHandler('lock:quit'); } catch (e) {}
  if (lockWindow && !lockWindow.isDestroyed()) { const w = lockWindow; lockWindow = null; w.destroy(); }
}

// ─── Panic wipe ─────────────────────────────────────────────────────
// Keys first (crypto-shredding makes every other byte on disk noise at
// that instant), then the rest; no flush may write anything afterwards.
async function panicWipe({ exit = true } = {}) {
  isQuitting = true; _shutdownDone = true;
  try { if (_sweepTimer) clearInterval(_sweepTimer); } catch (e) {}
  try { if (sirrStorage && sirrStorage._flushTimer) { clearTimeout(sirrStorage._flushTimer); sirrStorage._flushTimer = null; } } catch (e) {}
  try { sirrStorage && (sirrStorage.flushSync = () => {}); } catch (e) {}
  try { if (sirrCrypto) { sirrCrypto.sessionKeys.clear(); if (sirrCrypto.identity) sirrCrypto.identity.secretKey.fill(0); } } catch (e) {}
  try { appLock.wipe(); } catch (e) {}
  try { sirrStorage && sirrStorage.close(); } catch (e) {}
  try { appLock.wipe(); } catch (e) {}   // second pass: files the DB held open
  try { await session.defaultSession.clearStorageData(); await session.defaultSession.clearCache(); } catch (e) {}
  if (exit) app.exit(0);
}

// Lock = forget every key in memory by restarting into the lock screen.
function lockNow() {
  if (!appLock || !appLock.isEnabled()) return false;
  app.relaunch();
  app.quit();
  return true;
}

app.whenReady().then(async () => {
  setupSession();
  // At-rest encryption: hand the crypto layer (identity key) and the vault
  // (everything else) an adapter over Electron's safeStorage
  // (DPAPI / Keychain / libsecret), wrapped by the optional app lock.
  // Without an OS keystore (and no lock) both fall back to 0600 files and
  // we log a visible warning.
  const keystore = {
    isAvailable: () => { try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; } },
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
  appLock = new AppLock(SirrStorage.defaultDir(), keystore);
  if (appLock.isEnabled()) {
    const r = await showLockWindow();
    if (r === 'duress') {
      await panicWipe({ exit: false });
      isQuitting = false; _shutdownDone = false;
      appLock = new AppLock(SirrStorage.defaultDir(), keystore);
    }
  }
  await bootCore(appLock.box());
  closeLockWindow();
  armAutoLock();
});

// ─── Pathways & nearby (see lib/pathways.js, lib/nearby.js) ─────────
function applyBridgeServe(port) {
  try { if (bridgeServer) { bridgeServer.close(); bridgeServer = null; } } catch (e) {}
  const p = Number(port) || 0;
  if (!p || !sirrNetwork || (pathways && pathways.usingBridge)) return;
  try { bridgeServer = serveBridge(sirrNetwork.swarm.dht, { port: p }); bridgeServer.on('error', () => {}); } catch (e) { bridgeServer = null; }
}
function applyNearby(on) {
  if (!on) {
    try { lanCarrier && lanCarrier.stop(); } catch (e) {}
    try { bleCarrier && bleCarrier.stop(); } catch (e) {}
    try { nearby && nearby.stop(); } catch (e) {}
    nearby = lanCarrier = bleCarrier = null;
    return;
  }
  if (nearby || !sirrNetwork || !sirrNetwork.swarm) return;
  nearby = new Nearby({ network: sirrNetwork, keyPair: sirrNetwork.swarm.keyPair });
  nearby.start();
  lanCarrier = new LanCarrier(nearby);
  lanCarrier.start().catch((e) => console.warn('[nearby] LAN carrier failed:', e.message));
  if (BleCarrier.available()) bleCarrier = new BleCarrier(nearby).start();
}

// ─── Echoes: offline delivery inside the DHT (lib/echoes.js) ────────
function applyEchoes(on) {
  clearTimeout(_echoTimer); _echoTimer = null;
  if (!on) { echoes = null; return; }
  if (!echoes) {
    echoes = new Echoes({
      dht: () => (sirrNetwork && sirrNetwork.swarm ? sirrNetwork.swarm.dht : null),
      secretFor: (room) => sirrNetwork._echoSecret(room),
      myFp: () => sirrCrypto.getFingerprint(),
    });
    echoes.on('echo', (e) => { try { core && core.acceptEcho(e.room, e.m); } catch (x) {} });
    echoes.on('fail', () => {});
  }
  // With cover traffic on, polls (each of which re-puts what it reads) run
  // on a random schedule, so writing an echo looks like any other refresh.
  const next = () => {
    const cover = sirrStorage.getConfig().coverTraffic === 'on';
    const ms = cover ? 90e3 + Math.random() * 150e3 : 10 * 60e3;
    _echoTimer = setTimeout(async () => { await pollEchoes(); if (echoes) next(); }, ms);
    if (_echoTimer.unref) _echoTimer.unref();
  };
  setTimeout(() => pollEchoes().catch(() => {}), 20000).unref?.();
  next();
}
async function pollEchoes() {
  if (!echoes || !echoes.available()) return;
  for (const r of sirrStorage.getRooms()) {
    if (r.moved || r.ephemeral) continue;
    const writers = Object.keys(sirrStorage.getRoster(r.code) || {});
    if (r.isDm && r.dmPeer && r.dmPeer.fingerprint) writers.push(r.dmPeer.fingerprint);
    if (!writers.length) continue;
    try { await echoes.poll(r.code, [...new Set(writers)]); } catch (e) {}
  }
}
function maybeEcho(room, msg) {
  if (!echoes || !echoes.available() || msg.type !== 'text') return;
  const rec = sirrStorage.getRoomRecord(room);
  if (!rec || rec.ephemeral || rec.moved) return;
  // Only when someone who should get it isn't here to receive it.
  const online = new Set(sirrNetwork.peersInRoom(room).map(pid => sirrNetwork.peerInfo(pid)?.fingerprint));
  const members = Object.keys(sirrStorage.getRoster(room) || {});
  if (rec.isDm && rec.dmPeer && rec.dmPeer.fingerprint) members.push(rec.dmPeer.fingerprint);
  if (!members.some(fp => fp !== sirrCrypto.getFingerprint() && !online.has(fp))) return;
  echoes.write(room, msg);
}

function armAutoLock() {
  // Lock when the OS locks or sleeps, and after N idle minutes (opt-in).
  const cfg = () => { try { return sirrStorage.getConfig(); } catch (e) { return {}; } };
  const onOs = () => { if (cfg().lockOnSleep === 'on') lockNow(); };
  try { powerMonitor.on('lock-screen', onOs); powerMonitor.on('suspend', onOs); } catch (e) {}
  setInterval(() => {
    const m = Number(cfg().autoLockMin || 0);
    if (m > 0 && appLock.isEnabled()) {
      try { if (powerMonitor.getSystemIdleTime() >= m * 60) lockNow(); } catch (e) {}
    }
  }, 30000).unref?.();
  applyPanicHotkey();
}
function applyPanicHotkey() {
  try { globalShortcut.unregister('CommandOrControl+Alt+Shift+X'); } catch (e) {}
  const c = (() => { try { return sirrStorage.getConfig(); } catch (e) { return {}; } })();
  if (c.panicHotkey === 'on') {
    try { globalShortcut.register('CommandOrControl+Alt+Shift+X', () => { panicWipe(); }); } catch (e) {}
  }
}

async function bootCore(secretBox) {
  let vault;
  try {
    vault = new Vault(SirrStorage.defaultDir(), secretBox).init();
  } catch (e) {
    // Never fall through to an unencrypted start here: the config loader
    // would see an unreadable config and write factory defaults over it.
    dialog.showErrorBox('Sirr — cannot unlock your data',
      'Your messages and rooms are encrypted with a key protected by the operating system keychain, and it could not be opened (' + (e && e.message) + ').\n\nUnlock your keychain / keyring and start Sirr again. Nothing was changed.');
    app.exit(1);
    return;
  }
  sirrVault = vault;
  if (!vault.protectedByKeystore) {
    console.warn('[sirr] OS keystore unavailable — data key stored as a 0600 file. Install a keyring (gnome-keyring / kwallet) for full at-rest protection.');
  }
  sirrStorage = new SirrStorage(undefined, { vault });
  try {
    const r = sirrStorage.sealAtRest();
    if (sirrStorage.messages.migratedRows || r.files) {
      console.log('[sirr] encrypted at rest:', sirrStorage.messages.migratedRows || 0, 'messages,', r.files, 'files');
    }
  } catch (e) { console.warn('[sirr] at-rest sealing failed', e); }
  sirrCrypto = new SirrCrypto(sirrStorage.getDataDir(), secretBox);
  await sirrCrypto.init();
  sirrStorage.setSelfIdentity(sirrCrypto.getFingerprint(), sirrCrypto.getIdentityId());
  if (!sirrCrypto.atRestEncrypted) {
    console.warn('[sirr] OS keystore unavailable — identity key stored as plaintext (0600). Install a keyring (gnome-keyring / kwallet) to enable at-rest encryption.');
  }
  sirrNetwork = new SirrNetwork(sirrCrypto);
  const cfg = sirrStorage.getConfig();
  pathways = new Pathways({
    remembered: Array.isArray(cfg.dhtNodes) ? cfg.dhtNodes : [],
    entry: String(cfg.entryPoints || '').split(/[\s,]+/).filter(Boolean),
    bridge: cfg.bridge || '',
    relays: cfg.relays || 'auto',
    volunteer: cfg.relayVolunteer === 'on',
  });
  pathways.on('remember', (list) => { try { sirrStorage.updateConfig({ dhtNodes: list }); } catch (e) {} });
  pathways.on('bridge-hint', (url) => { try { const c = sirrStorage.getConfig(); if (!c.bridge) sirrStorage.updateConfig({ bridgeHint: url }); } catch (e) {} });
  await sirrNetwork.init(cfg.nickname, { inbox: cfg.inbox === 'on', pathways });
  applyBridgeServe(cfg.bridgeServe);
  applyNearby(cfg.nearby === 'on');
  applyEchoes(cfg.echoes === 'on');
  sirrNetwork.avatarEmoji = cfg.avatarEmoji || '';
  sirrNetwork.avatarPixels = /^(8|12|16|24|32):[A-Za-z0-9+/]{1,176}={0,2}$/.test(cfg.avatarPixels || '') ? cfg.avatarPixels : '';
  sirrNetwork.statusText = cfg.statusText || '';
  sirrNetwork.setCoverTraffic(cfg.coverTraffic === 'on');
  sirrNetwork.setSendJitter(cfg.sendJitter || 0);
  sirrNetwork.status = 'active';

  // file transfers (BOLT + legacy) run here in main, streaming to disk.
  sirrTransfers = new TransferManager({
    network: sirrNetwork,
    dir: path.join(sirrStorage.getDataDir(), 'received'),
    myFingerprint: () => sirrCrypto.getFingerprint(),
    myNickname: () => sirrNetwork.nickname || '',
    vault,
    log: (...a) => console.warn('[transfers]', ...a),
  });
  try { await sirrTransfers.init(); } catch (e) { console.warn('[transfers] init failed', e); }

  // Disappearing-message sweeper: run once at boot (catches anything that
  // expired while the app was closed) then every 20s. Cheap, indexed.
  _runSweep();
  _sweepTimer = setInterval(_runSweep, 20000);

  // Seed the blocklist from persisted config before any rooms are joined —
  // otherwise a blocked peer could briefly connect during startup.
  sirrNetwork.setBlocklist(Object.keys(sirrStorage.getBlocklist()));
  createWindow();
  createTray();
  registerIPC();
  registerNetworkEvents();
  for (const r of sirrStorage.getRooms()) {
    if (r.isDm && r.dmPeer && r.dmPeer.publicKey) sirrNetwork.setDmPeerKey(r.code, r.dmPeer.publicKey);
    try { await sirrNetwork.joinRoom(r.code); } catch (e) {}
  }
}

// This fires only when the app is truly exiting (from the Tray 'QUIT'
// button). Electron does NOT await async event handlers, so without the
// preventDefault gate the process could exit before network.destroy()
// (graceful LEAVE broadcast + swarm teardown) and the WAL checkpoint ran.
let _shutdownDone = false;
app.on('before-quit', (event) => {
  isQuitting = true;
  if (_shutdownDone) return;
  event.preventDefault();
  _shutdownDone = true;
  try { if (_sweepTimer) clearInterval(_sweepTimer); } catch (e) {}
  try { sirrTransfers && sirrTransfers.shutdown(); } catch (e) {}
  try { applyNearby(false); if (bridgeServer) bridgeServer.close(); } catch (e) {}
  (async () => {
    try {
      if (sirrNetwork) {
        console.log('Shutting down network...');
        // Hard cap so a stuck DHT teardown can't hang the quit forever.
        await Promise.race([
          sirrNetwork.destroy(),
          new Promise(res => setTimeout(res, 4000)),
        ]);
      }
    } catch (e) {}
    // Force any pending debounced config write to disk — we may have queued
    // roster touches / permission changes that weren't yet flushed.
    try { if (sirrStorage) sirrStorage.flushSync(); } catch (e) {}
    // Close the SQLite handle so WAL has a chance to checkpoint cleanly.
    try { if (sirrStorage) sirrStorage.close(); } catch (e) {}
    app.exit(0);
  })();
});

function registerIPC() {
  // ── Trusted-sender guard ───────────────────────────────────────────
  // Every `sirr` IPC handler is reachable only from the main window's
  // top frame. Popups carry no preload so they can't call invoke() through
  // the bridge anyway, but this closes the residual surface (e.g. a future
  // iframe/webview, or a compromised renderer frame) at the main-process
  // boundary instead of relying on renderer-side facts.
  const _trusted = (e) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      if (e.sender !== mainWindow.webContents) return false;
      if (e.senderFrame && e.senderFrame !== mainWindow.webContents.mainFrame) return false;
      return true;
    } catch (err) { return false; }
  };
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (e, ...args) => {
      if (!_trusted(e)) {
        // A legitimate call from the main window should always pass. If this
        // ever fires it means the guard is rejecting a real call (frame/timing
        // mismatch) — log loudly rather than silently returning null, which
        // would surface to the user as a blank fingerprint / "FAILED" with no
        // explanation.
        console.error('[sirr] IPC guard rejected channel:', channel,
          '| hasMainWindow:', !!mainWindow,
          '| senderIsMain:', !!(mainWindow && e.sender === mainWindow.webContents));
        return null;
      }
      return fn(e, ...args);
    });
  };

  handle('get-room-ttl', (_, room) => {
    return { ttl: sirrStorage.getRoomTTL(room) };
  });
  handle('get-room-ephemeral', (_, room) => ({ on: sirrStorage.isRoomEphemeral(String(room || '')) }));
  handle('set-room-ephemeral', (_, { room, on }) => ({ ok: sirrStorage.setRoomEphemeral(String(room || ''), !!on), on: !!on }));
  handle('set-room-ttl', (_, { room, ttl }) => {
    // ttl in ms; 0 = off. Whitelist to sane presets so a bad renderer value
    // can't set a nonsensical expiry. Presets: off, 30s, 5m, 1h, 1d, 1w.
    const ALLOWED = new Set([0, 30000, 300000, 3600000, 86400000, 604800000]);
    const v = ALLOWED.has(Number(ttl)) ? Number(ttl) : 0;
    const ok = sirrStorage.setRoomTTL(room, v);
    if (ok) _runSweep();  // apply the new policy at once
    return { ok, ttl: v };
  });

  handle('clipboard-write', (_, text) => {
    try { clipboard.writeText(String(text ?? '')); return true; } catch (e) { return false; }
  });

  // Single source of truth for the app's version string — comes from
  // package.json via Electron's `app.getVersion()`. Renderer stamps this
  // into every v{#} placeholder on boot, so we stop drifting across HTML,
  // comments, and User-Agent strings.
  handle('get-version', () => app.getVersion());

  // ─── Audio engine assets ───────────────────────────────────
  // The renderer is loaded with loadFile(), so its origin is file:// and
  // Chromium refuses fetch() there. The RNNoise wasm and its AudioWorklet
  // both have to reach the renderer some other way, so main reads them off
  // disk and hands them over as bytes / source text. This also means the
  // renderer never needs filesystem or network access to load them.
  //
  // Returns { wasm: ArrayBuffer|null, worklet: string|null, error?: string }.
  // A null on either side is not fatal — the renderer falls back to the
  // raw microphone and the call proceeds normally.
  let _audioAssetCache = null;
  handle('get-audio-assets', () => {
    if (_audioAssetCache) return _audioAssetCache;
    const out = { wasm: null, worklet: null, meshPlayback: null };
    try {
      const wasmPath = path.join(__dirname, 'assets', 'wasm', 'rnnoise.wasm');
      const wlPath   = path.join(__dirname, 'renderer', 'worklets', 'rnnoise-worklet.js');
      const mpPath   = path.join(__dirname, 'renderer', 'worklets', 'mesh-playback.js');
      out.wasm    = fs.readFileSync(wasmPath);
      out.worklet = fs.readFileSync(wlPath, 'utf8');
      out.meshPlayback = fs.readFileSync(mpPath, 'utf8');
      _audioAssetCache = out;
    } catch (e) {
      out.error = String(e && e.message || e);
      console.warn('[main] audio assets unavailable:', out.error);
    }
    return out;
  });

  handle('get-identity', () => ({
    nickname: sirrStorage.getConfig().nickname,
    fingerprint: sirrCrypto.getFingerprint(),
    publicKey: sirrCrypto.getPublicKeyB64(),
    peerId: sirrNetwork.myId,
    dataDir: sirrStorage.getDataDir(),
  }));

  handle('get-config', () => sirrStorage.getConfig());

  handle('update-config', (_, p) => {
    // The renderer may only touch preference-style keys. Structural state
    // (rooms / contacts / blocklist) has dedicated, validated IPC paths —
    // letting a generic merge clobber it would corrupt the ledger.
    const BLOCKED_KEYS = new Set(['rooms', 'contacts', 'blocklist', 'createdAt']);
    const clean = {};
    for (const [k, v] of Object.entries(p && typeof p === 'object' ? p : {})) {
      if (BLOCKED_KEYS.has(k)) continue;
      clean[k] = v;
    }
    const u = sirrStorage.updateConfig(clean);
    if (clean.nickname) {
      sirrNetwork.nickname = String(clean.nickname).slice(0, 20);
      sirrNetwork.reannounce();
    }
    if (clean.avatarEmoji !== undefined) {
      sirrNetwork.avatarEmoji = clean.avatarEmoji;
      sirrNetwork.reannounce();
    }
    if (clean.avatarPixels !== undefined) {
      sirrNetwork.avatarPixels = /^(8|12|16|24|32):[A-Za-z0-9+/]{1,176}={0,2}$/.test(String(clean.avatarPixels)) ? String(clean.avatarPixels) : '';
      sirrNetwork.reannounce();
    }
    if (clean.statusText !== undefined) {
      sirrNetwork.updateStatus('active', clean.statusText);
    }
    if (clean.inbox !== undefined) sirrNetwork.setInboxEnabled(clean.inbox === 'on');
    if (clean.contentProtection !== undefined && mainWindow) mainWindow.setContentProtection(clean.contentProtection === 'on');
    if (clean.panicHotkey !== undefined) applyPanicHotkey();
    if (clean.coverTraffic !== undefined) sirrNetwork.setCoverTraffic(clean.coverTraffic === 'on');
    if (clean.nearby !== undefined) applyNearby(clean.nearby === 'on');
    if (clean.echoes !== undefined) applyEchoes(clean.echoes === 'on');
    if (clean.bridgeServe !== undefined) applyBridgeServe(clean.bridgeServe);
    if (clean.relays !== undefined && pathways) pathways.relayMode = ['off', 'auto', 'always'].includes(clean.relays) ? clean.relays : 'auto';
    if (clean.relayVolunteer !== undefined && pathways && sirrNetwork.swarm) {
      if (clean.relayVolunteer === 'on' && !pathways.usingBridge) pathways.startRelay(sirrNetwork.swarm.dht).catch(() => {});
      else if (clean.relayVolunteer !== 'on') pathways.stopRelay().catch(() => {});
    }
    if (clean.sendJitter !== undefined) sirrNetwork.setSendJitter(clean.sendJitter);
    return u;
  });

  // ── App lock / panic ────────────────────────────────────────────
  handle('lock-status', () => ({ enabled: appLock.isEnabled(), keystore: !!(sirrVault && sirrVault.protectedByKeystore) }));
  handle('lock-enable', async (_, { pass, duress, current } = {}) => {
    try {
      // Changing the passphrase needs the current one.
      if (appLock.isEnabled() && appLock.unlock(String(current || '')) !== 'ok') return { ok: false, error: 'Current passphrase is wrong.' };
      appLock.enable(String(pass || ''), duress ? String(duress) : '');
      sirrVault.reseal();
      sirrCrypto.reseal();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('lock-disable', async (_, { pass } = {}) => {
    try {
      if (appLock.unlock(String(pass || '')) !== 'ok') return { ok: false, error: 'Wrong passphrase.' };
      appLock.disableBegin();
      sirrVault.reseal();
      sirrCrypto.reseal();
      appLock.disableCommit();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('lock-now', () => ({ ok: lockNow() }));
  handle('panic-wipe', async () => { await panicWipe(); return { ok: true }; });

  // Idle / auto-away: renderer pings us when the user goes idle or returns.
  // We just flip the network-side flag and broadcast — no persistence.
  handle('set-idle-status', (_, { status }) => {
    sirrNetwork.updateStatus(status === 'away' ? 'away' : 'active');
    return { ok: true };
  });

  // Persist the user's room drag order.
  handle('reorder-rooms', (_, { codes }) => {
    const ok = sirrStorage.reorderRooms(codes || []);
    return { ok };
  });

  // Opt-in link preview. Fetched from the main process so the URL doesn't
  // get CORS-blocked and so the renderer can't be redirected to arbitrary
  // origins. Hard caps: 5s timeout, 256 KB body, http/https only, public
  // hosts only (SSRF guard — reject loopback, RFC1918, link-local, and any
  // hostname that resolves to one of those ranges). Redirects are followed
  // manually so every hop is revalidated before we request it. Returns null
  // for anything it can't safely parse.
  handle('fetch-link-preview', async (_, url) => {
    if (typeof url !== 'string') return null;
    const safeUrl = await _resolveSafePreviewUrl(url);
    if (!safeUrl) return null;
    const doc = await _fetchLinkPreviewDocument(
      safeUrl.toString(),
      PREVIEW_UA
    );
    if (!doc) return null;
    const body = doc.body || '';
    const pick = (re) => { const m = body.match(re); return m ? m[1].trim() : ''; };
    const unescape = (s) => s
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
    const title = unescape(
      pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<title[^>]*>([^<]+)<\/title>/i)
    );
    const description = unescape(
      pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    );
    let image = unescape(
      pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    );
    // Resolve to an absolute URL and only let well-formed http(s) through.
    // The raw meta content is attacker-controlled HTML — never hand the
    // renderer a string it might interpolate into markup unvalidated.
    try {
      const imgUrl = image ? new URL(image, doc.url) : null;
      image = (imgUrl && /^https?:$/i.test(imgUrl.protocol)) ? imgUrl.toString().slice(0, 2048) : '';
    } catch (e) { image = ''; }
    if (image) {
      try { image = await _fetchPreviewImage(image, PREVIEW_UA); }
      catch (e) { image = ''; }
    }
    let siteName = '';
    try { siteName = new URL(doc.url).hostname.replace(/^www\./, ''); } catch (e) {}
    return {
      url: doc.url,
      title: title.slice(0, 200),
      description: description.slice(0, 400),
      image,
      siteName,
    };
  });

  handle('join-room', async (_, code) => {
    // A freshly typed code must parse and checksum (that is what stops a
    // typo from silently creating a new, empty room). DM codes and rooms
    // already in config were accepted before. Joining always uses the
    // canonical spelling: the code derives the rendezvous topics, so two
    // spellings of one code would never meet.
    try {
      let norm = RoomCode.normalize(code);
      if (!sirrStorage.getRoomRecord(norm)) {
        const v = RoomCode.validate(norm);
        if (!v.ok) return { ok: false, error: 'INVALID_CODE', reason: v.reason };
        norm = v.code;
      }
      await sirrNetwork.joinRoom(norm);
      sirrStorage.addRoom(norm);
      sirrStorage.pinIdentity(norm, sirrCrypto.getFingerprint(), sirrCrypto.getIdentityId());
      return {
        ok: true, joined: true,
        channels: sirrStorage.getChannels(norm),
        history: sirrStorage.getHistory(norm, 'default'),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Like join-room, but records the caller as the room's owner. Used by
  // the "Create new room" flow — the person who generates a code becomes
  // its owner. Idempotent: repeat calls don't displace an existing owner.
  handle('create-room', async (_, code) => {
    try {
      const v = RoomCode.validate(code);
      if (!v.ok) return { ok: false, error: 'INVALID_CODE', reason: v.reason };
      const norm = v.code;
      await sirrNetwork.joinRoom(norm);
      sirrStorage.addRoom(norm, null, {
        asOwner: true,
        myFingerprint: sirrCrypto.getFingerprint(),
      });
      sirrStorage.pinIdentity(norm, sirrCrypto.getFingerprint(), sirrCrypto.getIdentityId());
      return {
        ok: true, joined: true,
        channels: sirrStorage.getChannels(norm),
        history: sirrStorage.getHistory(norm, 'default'),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ─── Room admin / permissions ────────────────────────────────────
  // Fingerprint of the current user + owner fingerprint + full admin
  // table, returned together so the renderer can render the "manage"
  // panel in one round-trip.
  handle('get-room-admin', (_, code) => {
    const owner = sirrStorage.getRoomOwner(code) || {};
    const myFp = sirrCrypto.getFingerprint();
    return {
      owner,
      myFingerprint: myFp,
      isOwner: !!(owner.fingerprint && owner.fingerprint === myFp),
      admins: sirrStorage.getAdmins(code),
      perms: sirrStorage.getPerms(code, myFp),
      permKeys: SirrStorage.ROOM_PERMS,
    };
  });
  // Owner-only: grant or revoke admin perms for a peer, broadcast the
  // change, return the new admin record (or null on revoke).
  handle('set-admin', (_, { code, fingerprint, perms }) => {
    const myFp = sirrCrypto.getFingerprint();
    if (!sirrStorage.isRoomOwner(code, myFp)) return { ok: false, error: 'NOT_OWNER' };
    if (!fingerprint) return { ok: false, error: 'NO_TARGET' };
    if (fingerprint === myFp) return { ok: false, error: 'SELF' };
    const rec = sirrStorage.setAdmin(code, fingerprint, perms, myFp);
    sirrNetwork.broadcastAdminUpdate(code, fingerprint, rec);
    return { ok: true, admin: rec };
  });
  handle('remove-admin', (_, { code, fingerprint }) => {
    const myFp = sirrCrypto.getFingerprint();
    if (!sirrStorage.isRoomOwner(code, myFp)) return { ok: false, error: 'NOT_OWNER' };
    const ok = sirrStorage.removeAdmin(code, fingerprint);
    if (ok) sirrNetwork.broadcastAdminUpdate(code, fingerprint, null);
    return { ok };
  });

  // New rooms get a code that commits to their creator (lib/roomcode.js).
  handle('generate-room-code', () => RoomCode.generate(sirrCrypto.getIdentityId()));
  handle('build-invite-url',   (_, code) => {
    const c = sirrStorage.getConfig();
    // Entry points ride along so the invitee can get in even if the default
    // bootstrap nodes are blocked where they are. DHT nodes are public
    // infrastructure; a bridge is only included if the user said so.
    let hints = [];
    if (c.inviteHints !== 'off' && pathways) {
      hints = [...pathways.remembered].sort(() => Math.random() - 0.5).slice(0, 2).map(n => n.host + ':' + n.port);
      if (c.inviteBridge === 'on' && c.bridge) hints.push(c.bridge);
    }
    return RoomCode.toInviteUrl(code, c.inviteBase, hints);
  });
  handle('note-invite-hints', (_, url) => { try { pathways && pathways.addHints(RoomCode.parseInviteHints(String(url || ''))); } catch (e) {} return true; });
  handle('pathways-stats', () => ({
    ...(pathways ? pathways.stats() : {}),
    nearby: nearby ? nearby.stats() : null,
    ble: bleCarrier ? bleCarrier.state : (BleCarrier.available() ? 'off' : 'unavailable'),
    servingBridge: !!bridgeServer,
    bridgeHint: sirrStorage.getConfig().bridgeHint || '',
  }));
  handle('restart-app', () => { app.relaunch(); app.quit(); return true; });

  handle('leave-room', async (_, code) => {
    await sirrNetwork.leaveRoom(code);
    sirrStorage.removeRoom(code);
    return { ok: true };
  });

  // Owner only: move everyone (but `evict`) to a fresh code.
  handle('move-room', async (_, { code, evict } = {}) => {
    try {
      const m = await core.moveRoom(String(code || ''), Array.isArray(evict) ? evict : []);
      return { ok: true, to: m.to, name: sirrStorage.getRoomRecord(m.to)?.name || '' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  handle('rename-room', (_, { code, name }) => {
    const myFp = sirrCrypto.getFingerprint();
    if (!sirrStorage.hasPerm(code, myFp, 'renameRoom')) return { ok: false, error: 'NO_PERM' };
    sirrStorage.renameRoom(code, name);
    sirrNetwork.broadcastRoomRename(code, name);
    return { ok: true };
  });

  handle('get-rooms', () => sirrStorage.getRooms());
  handle('get-channels', (_, code) => sirrStorage.getChannels(code));
  handle('get-history', (_, { code, channel }) => sirrStorage.getHistory(code, channel || 'default'));
  handle('clear-history', (_, { code, channel }) => { sirrStorage.clearHistory(code, channel || 'default'); return { ok: true }; });

  // ─── Channels ────────────────────────────────────────────────────
  handle('create-channel', (_, { room, kind, name }) => {
    const myFp = sirrCrypto.getFingerprint();
    if (!sirrStorage.hasPerm(room, myFp, 'createChannel')) return { ok: false, error: 'NO_PERM' };
    const id = SirrStorage.makeChannelId(kind === 'voice' ? 'voice' : 'text');
    const channel = { id, kind: kind === 'voice' ? 'voice' : 'text', name: String(name || 'channel').slice(0, 30), createdAt: Date.now() };
    const channels = sirrStorage.addChannel(room, channel);
    if (!channels) return { ok: false };
    sirrNetwork.broadcastChannelCreate(room, channel, false);
    return { ok: true, channel };
  });
  handle('rename-channel', (_, { room, channelId, name }) => {
    const myFp = sirrCrypto.getFingerprint();
    if (!sirrStorage.hasPerm(room, myFp, 'renameChannel')) return { ok: false, error: 'NO_PERM' };
    const channels = sirrStorage.renameChannel(room, channelId, String(name || '').slice(0, 30));
    if (!channels) return { ok: false };
    sirrNetwork.broadcastChannelRename(room, channelId, name, false);
    return { ok: true };
  });
  handle('delete-channel', (_, { room, channelId }) => {
    const myFp = sirrCrypto.getFingerprint();
    if (!sirrStorage.hasPerm(room, myFp, 'deleteChannel')) return { ok: false, error: 'NO_PERM' };
    const channels = sirrStorage.removeChannel(room, channelId);
    if (!channels) return { ok: false };
    sirrNetwork.broadcastChannelDelete(room, channelId);
    return { ok: true };
  });

  handle('send-message', (_, { room, content, type, extra }) => {
    // Type whitelist + outbound caps. Text is capped at 4000 chars to
    // match the edit-message limit (one consistent contract everywhere);
    // images/files carry data-URL payloads and are bounded by the wire
    // layer's MAX_LINE_BYTES instead.
    const VALID_TYPES = new Set(['text', 'image', 'file', 'invite', 'reaction']);
    const t = VALID_TYPES.has(type) ? type : 'text';
    let body = String(content ?? '');
    if (t === 'text') body = body.slice(0, 4000);
    if (t === 'reaction') body = body.slice(0, 512);
    // Disappearing messages: compute the absolute expiry from the room TTL and
    // carry it in `extra` so the network layer puts it on the wire — every
    // peer then expires this message at the same instant, not on their own
    // receive-time clock.
    const ttl = sirrStorage.getRoomTTL(room);
    const sendExtra = { ...(extra || {}) };
    let expiresAt = 0;
    if (ttl > 0 && t !== 'reaction') {
      expiresAt = Date.now() + ttl;
      sendExtra.expiresAt = expiresAt;
    }
    const r = sirrNetwork.sendMessage(room, body, t, sendExtra);
    const channel = (extra && extra.channel) || 'default';
    const msg = {
      nickname: sirrStorage.getConfig().nickname,
      content: body, type: t,
      timestamp: r.timestamp, msgId: r.msgId, self: true,
      // Stored with our fingerprint + room signature so that when someone
      // later relays it to a member who was offline, it's verifiable.
      fingerprint: sirrCrypto.getFingerprint(),
      sig: r.sig || undefined,
      channel,
      replyTo: extra?.replyTo || null,
      fileName: extra?.fileName || '',
      fileSize: extra?.fileSize || 0,
      expiresAt,
    };
    sirrStorage.appendMessage(room, channel, msg);
    try { maybeEcho(room, msg); } catch (e) {}
    return { ...r, message: msg };
  });

  // ─── BOLT file transfer ────────────────────────────────────
  // `path` only ever comes from preload's webUtils.getPathForFile() on a
  // File the user dropped/picked — the page itself cannot name a path.
  handle('ft-send', async (_, d) => {
    if (!d || typeof d !== 'object') return { ok: false, error: 'bad request' };
    const req = { room: String(d.room || ''), channel: String(d.channel || 'default'), name: String(d.name || '') };
    if (typeof d.path === 'string' && d.path) req.path = d.path;
    else if (d.bytes instanceof Uint8Array) req.bytes = d.bytes;
    else return { ok: false, error: 'nothing to send' };
    if (!sirrStorage.getRooms().some(r => r.code === req.room)) return { ok: false, error: 'not in that room' };
    return sirrTransfers.send(req);
  });
  handle('ft-cancel', (_, id) => ({ ok: sirrTransfers.cancel(String(id || '')) }));
  handle('ft-save', async (_, id) => {
    const loc = sirrTransfers.locate(String(id || ''));
    if (!loc) return { ok: false, error: 'This file is no longer available on this device.' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('downloads'), TransferManager.safeName(loc.name)),
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try { return await sirrTransfers.saveTo(String(id), filePath); }
    catch (e) { return { ok: false, error: e.message }; }
  });
  handle('ft-show', (_, id) => {
    const loc = sirrTransfers.locate(String(id || ''));
    if (!loc || !loc.path) return { ok: false };
    if (loc.enc) return { ok: false, reason: 'encrypted — use Save' };   // on-disk copy is ciphertext
    shell.showItemInFolder(loc.path);
    return { ok: true };
  });
  handle('ft-info', (_, id) => {
    const loc = sirrTransfers.locate(String(id || ''));
    return loc ? { ok: true, name: loc.name, size: loc.size } : { ok: false };
  });

  handle('send-file-start', (_, d) => { sirrNetwork.sendFileStart(d);    return { ok: true }; });
  // Awaits socket drain: the renderer's `await sendFileChunk()` is now real
  // backpressure, so a big upload can't queue hundreds of MB in memory or
  // bury voice signaling behind it.
  handle('send-file-chunk', async (_, d) => { await sirrNetwork.sendFileChunkRaw(d); return { ok: true }; });
  handle('send-file-end',   (_, d) => { sirrNetwork.sendFileEnd(d);      return { ok: true }; });
  handle('delete-message', (_, { room, channel, msgId }) => {
    return sirrStorage.deleteMessage(room, channel || 'default', msgId);
  });

  // Edit a message (author only). Stores the new content locally and
  // broadcasts an encrypted MSG_EDIT to every peer in the room.
  handle('edit-message', (_, { room, channel, msgId, content }) => {
    if (!room || !msgId) return { ok: false, error: 'BAD_ARGS' };
    const myFp = sirrCrypto.getFingerprint();
    const ch = channel || 'default';
    const txt = String(content || '').slice(0, 4000);
    if (!txt.trim()) return { ok: false, error: 'EMPTY' };
    const r = sirrStorage.editMessage(room, ch, msgId, txt, myFp);
    if (!r.ok) return r;
    const editedAt = Date.now();
    sirrNetwork.broadcastMsgEdit(room, ch, msgId, txt, editedAt);
    try { sirrStorage.messages.mergeMeta(room, ch, msgId, { editSig: sirrNetwork.lastEditSig || undefined, editedAt }); } catch (e) {}
    return { ok: true, message: r.message, editedAt };
  });

  // Delete-for-all. Owner / any room admin can wipe any message; the
  // original author can always wipe their own. Storage applies the delete
  // locally; network broadcasts so peers can do the same.
  handle('delete-for-all', (_, { room, channel, msgId }) => {
    if (!room || !msgId) return { ok: false, error: 'BAD_ARGS' };
    const myFp = sirrCrypto.getFingerprint();
    const ch = channel || 'default';
    const existing = sirrStorage.messages.getMessage(room, ch, msgId);
    if (!existing) return { ok: false, error: 'NOT_FOUND' };
    const isAuthor = existing.fingerprint === myFp || (!existing.fingerprint && existing.self);
    if (!isAuthor && !sirrStorage.canModerate(room, myFp)) {
      return { ok: false, error: 'NO_PERM' };
    }
    const r = sirrStorage.deleteMessage(room, ch, msgId);
    if (!r.ok) return r;
    sirrNetwork.broadcastMsgDeleteForAll(room, ch, msgId);
    return { ok: true, message: r.message };
  });

  handle('send-typing', (_, { room, channel }) => { sirrNetwork.sendTyping(room, channel || 'default'); return { ok: true }; });

  // mesh audio over the Hyperswarm link. Fire-and-forget (send,
  // not invoke) — 50 packets/s per peer must not each await a reply.
  ipcMain.on('voice-media', (e, m) => {
    if (!_trusted(e) || !m || !m.peerId) return;
    const data = m.data;
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 4096) return;
    sirrNetwork.sendVoiceMedia(String(m.peerId), data, String(m.room || ''));
  });

  handle('voice-signal', (_, { peerId, signalType, data, room, channel }) => {
    if (peerId) sirrNetwork.sendVoiceSignal(peerId, signalType, data, room, channel);
    else sirrNetwork.broadcastVoiceSignal(signalType, data, room, channel);
    return { ok: true };
  });

  handle('get-peers', () => sirrNetwork.getPeers());
  handle('get-stats', () => ({
    ...sirrNetwork.getStats(),
    storage: sirrStorage.getStorageStats(),
  }));

  // QR code — compact data-URL PNG. Dark modules on a light ground: many
  // phone scanners can't read inverted (light-on-dark) codes.
  handle('generate-qr', async (_, text) => {
    try {
      return await QRCode.toDataURL(String(text || ''), {
        width: 192,
        margin: 1,
        color: { dark: '#0b0c0e', light: '#e8e6df' },
        errorCorrectionLevel: 'M',
      });
    } catch (e) { return null; }
  });

  // Lightweight network-ready probe — tells the renderer whether Hyperswarm
  // has been initialised (swarm object exists), independent of peer count.
  handle('get-network-status', () => ({
    initialized: !!(sirrNetwork && sirrNetwork.swarm),
  }));

  // ─── Contacts ────────────────────────────────────────────────────
  handle('get-contacts', () => sirrStorage.getContacts());
  // Explicit add — triggered by user clicking "Add" on a peer. We save
  // locally, then fire a CONTACT_ADD to that peer if they're online so
  // they see the "has added you" toast.
  handle('add-contact', (_, { fingerprint, nickname, avatarEmoji }) => {
    if (!fingerprint) return { ok: false };
    const rec = sirrStorage.addContact(fingerprint, { nickname, avatarEmoji });
    const pid = sirrNetwork.findPeerByFingerprint(fingerprint);
    if (pid) sirrNetwork.sendContactAddTo(pid);
    return { ok: true, contact: rec };
  });
  handle('remove-contact', (_, { fingerprint }) => {
    return { ok: sirrStorage.removeContact(fingerprint) };
  });

  // ─── DMs ─────────────────────────────────────────────────────────
  // Open (or join, if already known) the hidden room for a DM pair.
  handle('accept-dm-request', async (_, code) => {
    if (!sirrStorage.getRoomRecord(code)) return { ok: false };
    sirrStorage.setDmRequest(code, false);
    try { await sirrNetwork.joinRoom(code); } catch (e) {}
    return { ok: true };
  });
  handle('decline-dm-request', async (_, { code, block }) => {
    const rec = sirrStorage.getRoomRecord(code);
    if (!rec) return { ok: false };
    const fp = rec.dmPeer && (rec.dmPeer.fingerprint || rec.dmPeer);
    try { await sirrNetwork.leaveRoom(code); } catch (e) {}
    sirrStorage.removeRoom(code);
    if (block && fp) { sirrStorage.blockPeer(fp, {}); sirrNetwork.setBlocklist(Object.keys(sirrStorage.getBlocklist())); }
    return { ok: true };
  });
  handle('open-dm', async (_, { fingerprint, nickname }) => {
    if (!fingerprint) return { ok: false, error: 'no fingerprint' };
    const myFp = sirrCrypto.getFingerprint();
    const code = sirrStorage.dmRoomCode(myFp, fingerprint);
    if (!code) return { ok: false, error: 'bad fingerprint' };
    try {
      await sirrNetwork.joinRoom(code);
    } catch (e) { /* already joined */ }
    const room = sirrStorage.addDmRoom(code, fingerprint, nickname);
    // opening a DM yourself accepts it, and reaches their inbox so the
    // message gets through even if you share no room.
    sirrStorage.setDmRequest(code, false);
    sirrNetwork.reachInbox(fingerprint);
    return {
      ok: true,
      room,
      channels: sirrStorage.getChannels(code),
      history: sirrStorage.getHistory(code, 'default'),
    };
  });
  handle('get-dm-rooms', () => sirrStorage.getDmRooms());

  // ─── Room roster (persisted "has-access" ledger) ─────────────────
  handle('get-roster', (_, code) => sirrStorage.getRoster(code));
  handle('get-all-rosters', () => sirrStorage.getAllRosters());

  // ─── Blocklist ───────────────────────────────────────────────────
  handle('get-blocklist', () => sirrStorage.getBlocklist());
  handle('block-peer', (_, { fingerprint, nickname }) => {
    const rec = sirrStorage.blockPeer(fingerprint, { nickname });
    sirrNetwork.setBlocklist(Object.keys(sirrStorage.getBlocklist()));
    return { ok: true, record: rec };
  });
  handle('unblock-peer', (_, { fingerprint }) => {
    const ok = sirrStorage.unblockPeer(fingerprint);
    sirrNetwork.setBlocklist(Object.keys(sirrStorage.getBlocklist()));
    return { ok };
  });

  // ─── Export / Import ─────────────────────────────────────────────
  // Backups are always sealed with a passphrase (lib/backup.js): the file
  // carries the identity key and every room code.
  handle('export-all-data', async (_, passphrase) => {
    try { Backup.checkPassphrase(passphrase); }
    catch (e) { return { ok: false, error: e.message }; }
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Sirr backup',
      defaultPath: 'sirr-backup-' + new Date().toISOString().slice(0, 10) + '.sirrbk',
      filters: [{ name: 'Sirr backup', extensions: ['sirrbk'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    try {
      const bundle = sirrStorage.exportAll(() => sirrCrypto.exportIdentity());
      fs.writeFileSync(filePath, Backup.seal(bundle, passphrase), { mode: 0o600 });
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message || 'write failed' };
    }
  });
  handle('import-all-data', async (_, passphrase) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Sirr backup',
      properties: ['openFile'],
      filters: [{ name: 'Sirr backup', extensions: ['sirrbk'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, cancelled: true };
    try {
      const st = fs.statSync(filePaths[0]);
      if (st.size > 512 * 1024 * 1024) return { ok: false, error: 'File is too large to be a backup.' };
      const bundle = Backup.open(fs.readFileSync(filePaths[0], 'utf8'), passphrase);
      sirrStorage.importAll(bundle, (id) => sirrCrypto.importIdentity(id));
      return { ok: true, path: filePaths[0] };
    } catch (e) {
      return { ok: false, error: e.message || 'import failed' };
    }
  });

  // ─── Pinned messages ─────────────────────────────────────────────
  handle('get-pins', (_, { room, channel }) => {
    return sirrStorage.getPins(room, channel || 'default');
  });
  // Toggle a pin locally and broadcast to peers. `extra` carries the
  // preview/nick/ts so remote peers who never saw the original message can
  // still render a meaningful pins panel entry.
  handle('toggle-pin', (_, { room, channel, msgId, pinned, preview, nick, ts }) => {
    const ch = channel || 'default';
    const info = { preview: preview || '', nick: nick || '', ts: ts || Date.now() };
    sirrStorage.setPin(room, ch, msgId, !!pinned, info);
    sirrNetwork.broadcastPinToggle(room, ch, msgId, !!pinned, info);
    return { ok: true };
  });
}

let core = null;
function registerNetworkEvents() {
  // the logic lives in lib/core-events.js, shared with Sirr Mobile.
  core = wireCore({
    storage: sirrStorage, network: sirrNetwork, crypto: sirrCrypto, transfers: sirrTransfers,
    send: (ch, d) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, d); },
    attention: () => { if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true); },
    downloadsDir: () => app.getPath('downloads'),
  });
}
