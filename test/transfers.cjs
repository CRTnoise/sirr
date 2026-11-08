/**
 * File transfer tests (BOLT) — real SirrNetwork + TransferManager
 * pairs over an in-memory duplex that chops writes into odd sizes and
 * applies backpressure. Legacy interop is tested against the ACTUAL
 * previous network stack when available (../orig or SIRR_OLD_LIB).
 *
 *   node test-transfers.cjs
 */
const os = require('os'), fs = require('fs'), path = require('path');
const { Duplex } = require('stream');
const crypto = require('crypto');

const hsPath = require.resolve('hyperswarm');
require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: class {
  constructor() { this.keyPair = { publicKey: crypto.randomBytes(32) }; }
  on() {} join() { return { flushed: async () => {}, destroy: async () => {} }; }
  async destroy() {}
} };
const SirrNetwork = require('../lib/network.js');
const SirrCrypto = require('../lib/crypto-layer.js');
const TransferManager = require('../lib/transfers.js');
const Vault = require('../lib/vault.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const sec = (n) => console.log('\n── ' + n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(5); } return false; };
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'phx-' + n));

function pair({ rate = 0, tamper = null } = {}) {
  const mk = () => new Duplex({ highWaterMark: 64 * 1024, read() {}, write(chunk, enc, cb) {
    if (tamper) chunk = tamper(chunk);
    let o = 0;
    const step = () => {
      if (this.destroyed || this._peer.destroyed) return cb();
      while (o < chunk.length) {
        const n = Math.min(chunk.length - o, 1 + ((o * 31) % 4093));
        this._peer.push(chunk.subarray(o, o + n)); o += n;
        // Throttle on bytes across ALL writes (a per-write boundary never
        // triggers for BOLT's ~61 KB frames).
        this._acc = (this._acc || 0) + n;
        if (rate && this._acc >= 65536) { this._acc -= 65536; return setTimeout(step, rate); }
      }
      cb();
    };
    step();
  } });
  const a = mk(), b = mk(); a._peer = b; b._peer = a;
  return [a, b];
}

async function node(name, Net = SirrNetwork) {
  const c = new SirrCrypto(tmp(name)); await c.init();
  const n = new Net(c); await n.init(name);
  await n.joinRoom('ROOM');
  const events = [];
  let tm = null;
  if (Net === SirrNetwork) {
    const rx = tmp(name + '-rx');
    // receive with at-rest encryption on, like the app does.
    tm = new TransferManager({ network: n, dir: rx, myFingerprint: () => c.getFingerprint(), myNickname: () => name, vault: new Vault(rx).init() });
    await tm.init();
    tm.on('event', e => events.push(e));
  }
  return { n, c, tm, events, pk: n.swarm.keyPair.publicKey };
}
function connect(A, B, opts) {
  const [sa, sb] = pair(opts);
  A.n._onConn(sa, { publicKey: B.pk, topics: [] });
  B.n._onConn(sb, { publicKey: A.pk, topics: [] });
  return { sa, sb, aPidOfB: B.pk.toString('hex').slice(0, 12), bPidOfA: A.pk.toString('hex').slice(0, 12) };
}
async function ready(A, B, link) {
  return until(() => A.n.crypto.hasSession(link.aPidOfB) && B.n.crypto.hasSession(link.bPidOfA)
    && A.n.peers.get(link.aPidOfB)?.rooms.has('ROOM') && B.n.peers.get(link.bPidOfA)?.rooms.has('ROOM'));
}
function file(name, bytes) { const p = path.join(tmp('src'), name); fs.writeFileSync(p, bytes); return p; }
const ev = (X, id, e) => X.events.find(x => x.id === id && x.ev === e);

(async () => {
  const A = await node('alice'), B = await node('bob');
  let link = connect(A, B);
  ok(await ready(A, B, link), 'peers ready');
  ok(A.n.peerHasCap(link.aPidOfB, 'bolt1') && B.n.peerHasCap(link.bPidOfA, 'bolt1'), 'both advertise bolt1');

  async function sendAndCheck(label, name, bytes) {
    const p = file(name, bytes);
    const r = await A.tm.send({ room: 'ROOM', channel: 'general', path: p });
    const got = await until(() => ev(B, r.id, 'complete') || ev(B, r.id, 'failed'), 30000);
    const done = ev(B, r.id, 'complete');
    ok(got && done, label + ': received');
    if (!done) { console.log('   ', JSON.stringify(ev(B, r.id, 'failed'))); return null; }
    const out = (await B.tm.read(r.id, Infinity));
    ok(Buffer.compare(out, bytes) === 0, label + ': byte-identical');
    ok(done.verified === true && done.channel === 'general', label + ': SHA-256 verified, channel kept');
    ok(await until(() => ev(A, r.id, 'complete')), label + ': sender sees delivery');
    const sc = ev(A, r.id, 'complete');
    ok(sc && sc.delivered === 1, label + ': delivered 1/1 (receiver-confirmed)');
    return done;
  }

  sec('BOLT — sizes & content');
  for (const [lab, n, b] of [
    ['empty', 'empty.bin', Buffer.alloc(0)],
    ['1 byte', 'one.bin', Buffer.from([42])],
    ['exactly one chunk', 'c1.bin', crypto.randomBytes(61440)],
    ['chunk + 1', 'c2.bin', crypto.randomBytes(61441)],
    ['random 5 MB', 'r5.bin', crypto.randomBytes(5 * 1024 * 1024 + 7)],
  ]) await sendAndCheck(lab, n, b);
  const text = Buffer.from(fs.readFileSync(__filename, 'utf8').repeat(80));
  const d = await sendAndCheck('text ' + (text.length / 1e6).toFixed(1) + ' MB', 'notes.txt', text);
  if (d) { ok(d.ratio < 0.5, 'LZ4 shrank text on the wire to ' + (d.ratio * 100).toFixed(0) + '%'); console.log('   wire size: ' + (d.ratio * 100).toFixed(0) + '% of original'); }
  const jpg = crypto.randomBytes(300000);
  const dj = await sendAndCheck('.jpg skips compression', 'photo.jpg', jpg);
  if (dj) ok(dj.ratio === 1, 'known-compressed type sent raw');

  sec('throughput (in-memory, one core, both ends in one process)');
  {
    const big = crypto.randomBytes(64 * 1024 * 1024);
    const p = file('big.bin', big);
    const t0 = Date.now();
    const r = await A.tm.send({ room: 'ROOM', path: p });
    await until(() => ev(B, r.id, 'complete'), 60000);
    const s = (Date.now() - t0) / 1000;
    ok(!!ev(B, r.id, 'complete'), '64 MB delivered');
    console.log('   64 MB random: ' + (64 / s).toFixed(0) + ' MB/s end-to-end (encrypt + frame + demux + decrypt + hash + disk)');
  }

  sec('resume after the link drops mid-transfer');
  {
    const bytes = crypto.randomBytes(24 * 1024 * 1024);
    const p = file('resume.bin', bytes);
    // slow link so we can cut it mid-way
    link.sa.destroy(); link.sb.destroy();
    await wait(50);
    link = connect(A, B, { rate: 4 });   // throttled: slow enough to cut mid-transfer
    await ready(A, B, link);
    const r = await A.tm.send({ room: 'ROOM', path: p });
    await until(() => { const e = B.events.filter(x => x.id === r.id && x.ev === 'progress').pop(); return e && e.bytes > 6 * 1024 * 1024; }, 30000);
    const before = B.events.filter(x => x.id === r.id && x.ev === 'progress').pop().bytes;
    link.sa.destroy(); link.sb.destroy();
    ok(await until(() => ev(A, r.id, 'paused') && ev(B, r.id, 'paused')), 'both sides pause');
    await wait(100);
    link = connect(A, B);
    ok(await until(() => ev(B, r.id, 'resumed')), 'receiver resumed (from ' + (before / 1048576).toFixed(1) + ' MB)');
    const res = ev(B, r.id, 'resumed');
    ok(res && res.from > 0 && res.from % 61440 === 0, 'resume offset is chunk-aligned and non-zero');
    ok(await until(() => ev(B, r.id, 'complete'), 30000), 'completed after resume');
    if (ev(B, r.id, 'complete')) ok(Buffer.compare((await B.tm.read(r.id, Infinity)), bytes) === 0 && ev(B, r.id, 'complete').verified, 'resumed file byte-identical & verified');
  }

  sec('cancel');
  {
    link.sa.destroy(); link.sb.destroy(); await wait(30);
    link = connect(A, B, { rate: 3 }); await ready(A, B, link);
    const r = await A.tm.send({ room: 'ROOM', path: file('c.bin', crypto.randomBytes(20 * 1024 * 1024)) });
    await until(() => ev(B, r.id, 'progress'));
    A.tm.cancel(r.id);
    ok(await until(() => ev(B, r.id, 'failed')), 'sender cancel reaches receiver');
    ok(!fs.readdirSync(B.tm.dir).some(n => n.startsWith(r.id)), 'receiver removed the partial file');
    const r2 = await A.tm.send({ room: 'ROOM', path: file('c2.bin', crypto.randomBytes(20 * 1024 * 1024)) });
    await until(() => ev(B, r2.id, 'progress'));
    B.tm.cancel(r2.id);
    ok(await until(() => { const c = ev(A, r2.id, 'complete'); return c && c.delivered === 0; }), 'receiver cancel stops the sender');
  }

  sec('tampering in transit');
  {
    link.sa.destroy(); link.sb.destroy(); await wait(30);
    let armed = false, hit = false;
    link = connect(A, B, { tamper: (c) => { if (armed && !hit && c.length > 60000 && c[0] === 0xB0) { hit = true; c = Buffer.from(c); c[5000] ^= 0xff; } return c; } });
    await ready(A, B, link);
    armed = true;
    const r = await A.tm.send({ room: 'ROOM', path: file('t.bin', crypto.randomBytes(2 * 1024 * 1024)) });
    ok(await until(() => ev(B, r.id, 'failed')), 'flipped bit → receiver rejects');
    ok((ev(B, r.id, 'failed') || {}).reason === 'data failed authentication', 'reason: authentication');
    ok(await until(() => { const c = ev(A, r.id, 'complete'); return c && c.delivered === 0; }), 'sender told it failed');
  }

  sec('JSON path: peer without BOLT advertised');
  {
    link.sa.destroy(); link.sb.destroy(); await wait(30);
    link = connect(A, B); await ready(A, B, link);
    A.n.peers.get(link.aPidOfB).caps = new Set();         // make B look old to A
    for (const size of [0, 1000, 524288, 600000, 3 * 1024 * 1024 + 1]) {
      const bytes = crypto.randomBytes(size);
      const r = await A.tm.send({ room: 'ROOM', path: file('l' + size + '.bin', bytes) });
      await until(() => ev(B, r.id, 'complete') || ev(B, r.id, 'failed'));
      const c = ev(B, r.id, 'complete');
      ok(c && Buffer.compare((await B.tm.read(r.id, Infinity)), bytes) === 0, 'legacy ' + size + ' B delivered byte-identical' + (c ? '' : ' — ' + JSON.stringify(ev(B, r.id, 'failed'))));
    }
  }


  A.tm.shutdown(); B.tm.shutdown();
  await A.n.destroy(); await B.n.destroy();
  console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
