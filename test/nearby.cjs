/**
 * Nearby mesh over in-memory links: A — R1 — R2 — B, where only A and B
 * share a room. They must find each other through two relays that are not
 * members, and the relays must never see plaintext.   node test/nearby.cjs
 */
const crypto = require('crypto');
const { Duplex } = require('stream');
const DHT = require('hyperdht');
const { Nearby } = require('../lib/nearby.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

function pair(tap) {
  let a, b;
  a = new Duplex({ read() {}, write(c, e, cb) { tap && tap(c); b.push(c); cb(); } });
  b = new Duplex({ read() {}, write(c, e, cb) { tap && tap(c); a.push(c); cb(); } });
  return [a, b];
}
function fakeNet(rooms) {
  const n = { rooms: new Map(rooms.map(r => [r, {}])), peers: new Map(), conns: [] };
  n._rotatingTopic = (name, e) => crypto.createHash('sha256').update('t|' + name + '|' + e).digest();
  n._onConn = (ss, info) => { n.conns.push({ ss, info }); n.peers.set(String(n.conns.length), { remoteKeyHex: Buffer.from(info.publicKey).toString('hex') }); };
  return n;
}
const mk = (rooms) => { const kp = DHT.keyPair(); const net = fakeNet(rooms); return { net, kp, nb: new Nearby({ network: net, keyPair: kp }) }; };

(async () => {
  const A = mk(['SR-ROOM-1', 'SR-OTHER']), R1 = mk(['SR-ELSE']), R2 = mk([]), B = mk(['SR-ROOM-1']), C = mk(['SR-NOPE']);
  const wire = [];
  const tap = (c) => wire.push(Buffer.from(c).toString('utf8'));
  const link = (x, y) => { const [s1, s2] = pair(tap); x.nb.addLink(s1, 'mem'); y.nb.addLink(s2, 'mem'); };
  link(A, R1); link(R1, R2); link(R2, B); link(R2, C);
  for (const n of [A, R1, R2, B, C]) n.nb.start();

  const t0 = Date.now();
  while ((!A.net.conns.length || !B.net.conns.length) && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 100));
  ok(A.net.conns.length === 1 && B.net.conns.length === 1, 'two members three hops apart found each other (' + (Date.now() - t0) + ' ms)');
  ok(!C.net.conns.length && !R1.net.conns.length && !R2.net.conns.length, 'non-members open nothing');
  ok(R2.nb.stats().reach >= 3, 'every node hears the others: beacons flood (R2 reaches ' + R2.nb.stats().reach + ')');

  const a = A.net.conns[0], b = B.net.conns[0];
  ok(Buffer.from(a.info.publicKey).equals(B.kp.publicKey) && Buffer.from(b.info.publicKey).equals(A.kp.publicKey), 'each end authenticated the other key (Noise)');
  const got = new Promise(r => b.ss.once('data', d => r(String(d))));
  a.ss.write('secret-hello-through-the-mesh');
  ok(await got === 'secret-hello-through-the-mesh', 'data flows end to end');
  const big = crypto.randomBytes(200 * 1024);
  let acc = Buffer.alloc(0);
  const gotBig = new Promise(r => a.ss.on('data', d => { acc = Buffer.concat([acc, d]); if (acc.length >= big.length) r(acc); }));
  b.ss.write(big);
  ok((await gotBig).equals(big), '200 KB crosses the mesh intact (chunked)');
  ok(!wire.some(w => w.includes('secret-hello')) && !wire.some(w => w.includes(Buffer.from('secret-hello-through-the-mesh').toString('base64'))), 'relays never carry plaintext');
  ok(!wire.some(w => w.includes('SR-ROOM-1')), 'room names never on the wire');

  // Beacons are unlinkable: same node, two beacons, no tag in common.
  A.nb._beacon(); A.nb._beacon();
  const beacons = wire.filter(w => w.includes('"t":"b"') && w.includes(A.kp.publicKey.toString('hex'))).map(w => JSON.parse(w.slice(w.indexOf('{'))));
  const uniq = [...new Map(beacons.map(b => [b.n, b])).values()];
  const tagsets = uniq.map(b => new Set(b.g));
  const share = tagsets.length > 1 && [...tagsets[0]].some(t => tagsets[1].has(t));
  ok(tagsets.length > 1 && !share, 'consecutive beacons share no tag');
  ok(beacons.every(b => b.g.length % 4 === 0), 'tag count padded');

  for (const n of [A, R1, R2, B, C]) n.nb.stop();

  console.log('\n── real Sirr nodes over the mesh (no DHT at all)');
  {
    const os = require('os'), fs = require('fs'), path = require('path');
    const hsPath = require.resolve('hyperswarm');
    require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: class {
      constructor() { this.keyPair = DHT.keyPair(); }
      on() {} join() { return { flushed: async () => {}, destroy: async () => {} }; }
      async destroy() {}
    } };
    const Net = require('../lib/network.js'), Crypto = require('../lib/crypto-layer.js'), RC = require('../lib/roomcode.js');
    const mkNode = async (nick) => {
      const cr = new Crypto(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-' + nick))); await cr.init();
      const n = new Net(cr); await n.init(nick);
      const nb = new Nearby({ network: n, keyPair: n.swarm.keyPair });
      return { n, nb };
    };
    const X = await mkNode('xena'), Y = await mkNode('yusuf'), Z = await mkNode('relay');
    const code = RC.generate('');
    await X.n.joinRoom(code); await Y.n.joinRoom(code);
    const [p1, p2] = pair(), [p3, p4] = pair();
    X.nb.addLink(p1, 'mem'); Z.nb.addLink(p2, 'mem'); Z.nb.addLink(p3, 'mem'); Y.nb.addLink(p4, 'mem');
    const joined = new Promise(r => Y.n.on('peer-joined', p => r(p)));
    for (const k of [X, Y, Z]) k.nb.start();
    const pj = await Promise.race([joined, new Promise(r => setTimeout(() => r(null), 15000))]);
    ok(pj && pj.nickname === 'xena' && pj.rooms.includes(code), 'two Sirr nodes authenticate and share the room through a stranger');
    const got = new Promise(r => Y.n.on('message', m => r(m)));
    await new Promise(r => setTimeout(r, 300));
    X.n.sendMessage(code, 'hello with no internet', 'text');
    const m = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 5000))]);
    ok(m && m.content === 'hello with no internet', 'a message arrives end to end');
    ok(!Z.n.peers.size, 'the relay node never became a peer of either');
    for (const k of [X, Y, Z]) k.nb.stop();
  }

  console.log('\n── LAN carrier (UDP announce + TCP links, on loopback)');
  {
    const { LanCarrier } = require('../lib/nearby-lan.js');
    const P = mk(['SR-LAN']), Q = mk(['SR-LAN']);
    const lp = new LanCarrier(P.nb, { targets: [] }), lq = new LanCarrier(Q.nb, { targets: [] });
    await lp.start(); await lq.start();
    lp.targets.push({ host: '127.0.0.1', port: lq.udpPort() });
    lq.targets.push({ host: '127.0.0.1', port: lp.udpPort() });
    P.nb.start(); Q.nb.start();
    lp._announce(); lq._announce();
    const t1 = Date.now();
    while ((!P.net.conns.length || !Q.net.conns.length) && Date.now() - t1 < 15000) await new Promise(r => setTimeout(r, 100));
    ok(P.nb.linkCount() === 1 && Q.nb.linkCount() === 1, 'one TCP link between the two (lower key dials)');
    ok(P.net.conns.length === 1 && Q.net.conns.length === 1, 'members on the same LAN find each other with no DHT');
    lp.stop(); lq.stop(); P.nb.stop(); Q.nb.stop();
  }

  console.log('\n' + (fail ? '❌' : '✅') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
