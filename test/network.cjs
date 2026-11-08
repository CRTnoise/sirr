/**
 * Network layer tests — two real SirrNetwork instances (real crypto,
 * real framing, real handlers) wired back-to-back over an in-memory
 * duplex pair that deliberately chops every write into small, oddly
 * sized chunks and applies backpressure like a congested socket.
 * Hyperswarm itself is stubbed; everything above the socket is real.
 *
 *   node test-network.cjs
 */
const os = require('os'), fs = require('fs'), path = require('path');
const { Duplex } = require('stream');
const crypto = require('crypto');

// ── Stub Hyperswarm: we hand sockets to _onConn ourselves ─────────────
const hsPath = require.resolve('hyperswarm');
require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: class {
  constructor() { this.keyPair = { publicKey: crypto.randomBytes(32) }; }
  on() {} join() { return { flushed: async () => {}, destroy: async () => {} }; }
  async destroy() {}
} };
const SirrNetwork = require('../lib/network.js');
const SirrCrypto = require('../lib/crypto-layer.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const sec = (n) => console.log('\n── ' + n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(10); } return false; };

// A socket pair whose writes arrive split into 1..37-byte-ish chunks (so
// multi-byte UTF-8 sequences straddle boundaries), with a small
// high-water mark so write() returns false and 'drain' matters.
function pair() {
  const mk = () => new Duplex({ highWaterMark: 64 * 1024, read() {}, write(chunk, enc, cb) {
    let o = 0;
    const step = () => {
      while (o < chunk.length) {
        const n = Math.min(chunk.length - o, 1 + ((o * 31) % 997));
        this._peer.push(chunk.subarray(o, o + n)); o += n;
        if (o % 65536 < n) return setImmediate(step);   // yield: simulate a slow link
      }
      cb();
    };
    step();
  } });
  const a = mk(), b = mk(); a._peer = b; b._peer = a;
  return [a, b];
}

(async () => {
  async function mk(name) {
    const c = new SirrCrypto(fs.mkdtempSync(path.join(os.tmpdir(), 'ph-' + name))); await c.init();
    const n = new SirrNetwork(c); await n.init(name); return n;
  }
  const A = await mk('alice'), B = await mk('bob');
  const room = 'TESTROOM';
  await A.joinRoom(room); await B.joinRoom(room);
  const [sa, sb] = pair();
  // Connection keys must be each node's real swarm key: room membership
  // tags are bound to the pair of keys on the connection.
  const pkA = A.swarm.keyPair.publicKey, pkB = B.swarm.keyPair.publicKey;
  A._onConn(sa, { publicKey: pkB, topics: [] });
  B._onConn(sb, { publicKey: pkA, topics: [] });
  const bAtA = pkB.toString('hex').slice(0, 12), aAtB = pkA.toString('hex').slice(0, 12);

  sec('handshake');
  ok(await until(() => A.crypto.isForwardSecret(bAtA) && B.crypto.isForwardSecret(aAtB)), 'v2 forward-secret session both ways');
  ok(A.peers.get(bAtA)?.rooms.has(room) && B.peers.get(aAtB)?.rooms.has(room), 'shared room reconciled');

  sec('contact-add notification (guards against a wire-type collision on 0x30)');
  {
    let got = null;
    B.on('contact-add', c => { got = c; });
    A.sendContactAddTo(bAtA);
    await until(() => got);
    ok(got && got.peerId === aAtB, 'CONTACT_ADD reaches its own handler');
  }

  sec('swarm voice link');
  const got = [];
  B.on('voice-media', m => got.push(m));
  const pkt = new Uint8Array(300); for (let i = 0; i < 300; i++) pkt[i] = (i * 7) & 255; pkt[0] = 0xB1;
  ok(A.sendVoiceMedia(bAtA, pkt, room) === true, 'send accepted');
  await until(() => got.length === 1);
  ok(got.length === 1, 'packet delivered');
  ok(got[0]?.peerId === aAtB, 'attributed to sender');
  ok(got[0] && Buffer.compare(Buffer.from(got[0].data), Buffer.from(pkt)) === 0, 'bytes intact');
  ok(A.sendVoiceMedia(bAtA, pkt, 'NOT-SHARED') === false, 'refuses a room the peer is not in');
  ok(A.sendVoiceMedia(bAtA, new Uint8Array(5000), room) === false, 'refuses oversize packet');
  // A peer can't smuggle media into a room we don't share with them
  const before = got.length;
  A._send(sa, { type: 0x16, room: 'NOT-SHARED', d: Buffer.from(pkt).toString('base64') });
  await wait(100);
  ok(got.length === before, 'receiver drops media for an unshared room');

  sec('flood cap');
  got.length = 0;
  for (let i = 0; i < 400; i++) A._send(sa, { type: 0x16, room, d: Buffer.from(pkt).toString('base64') });
  await wait(500);
  ok(got.length > 0 && got.length <= 150, 'inbound media rate capped (' + got.length + '/400)');

  sec('UTF-8 across chunk boundaries');
  let sig = null;
  B.on('voice-signal', s => { if (s.type === 0x14 && s.data.length > 1000) sig = s; });
  const big = '🎙é中ض'.repeat(20000);
  A.sendVoiceSignal(bAtA, 0x14, big, room, 'vc');
  await until(() => sig, 10000);
  ok(sig && sig.data === big, 'multi-byte text survives arbitrary chunking');
  let upd = null;
  B.on('peer-updated', p => { upd = p; });
  A.updateStatus('active', 'Réunion 🎧 — مرحبا');
  await until(() => upd && upd.statusText);
  ok(upd && upd.statusText === 'Réunion 🎧 — مرحبا', 'status text with emoji/Arabic arrives intact');

  sec('file chunk backpressure');
  let chunks = 0;
  B.on('file-transfer', () => chunks++);
  const data = 'A'.repeat(700000);
  const t0 = Date.now();
  let queuedMax = 0;
  for (let i = 0; i < 12; i++) {
    await A.sendFileChunkRaw({ room, fileId: 'f1', index: i, data });
    queuedMax = Math.max(queuedMax, A._queuedBytes(sa));
  }
  ok(queuedMax < 2 * 1024 * 1024, 'sender never holds more than ~one chunk in its socket (' + Math.round(queuedMax / 1024) + ' KB max)');
  await until(() => chunks === 12, 20000);
  ok(chunks === 12, 'all chunks delivered');
  // Voice media is dropped (not queued) while a big write is in flight.
  A.sendFileChunkRaw({ room, fileId: 'f2', index: 0, data: 'B'.repeat(900000) });
  ok(A._queuedBytes(sa) > 256 * 1024 ? A.sendVoiceMedia(bAtA, pkt, room) === false : true, 'audio not queued behind a file burst');

  await A.destroy(); await B.destroy();
  console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
