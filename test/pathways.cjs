/**
 * Pathways on a local HyperDHT testnet: entry points, a WebSocket bridge,
 * and volunteer blind relays.   node test/pathways.cjs
 */
const createTestnet = require('hyperdht/testnet');
const Hyperswarm = require('hyperswarm');
const crypto = require('crypto');
const { Pathways, serveBridge, parseNode, RELAY_TOPIC } = require('../lib/pathways.js');
const DHT = require('hyperdht');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout: ' + what)), ms))]);

function talk(a, b, topic) {
  return new Promise((resolve) => {
    let got = 0;
    const done = () => { if (++got === 2) resolve(true); };
    a.on('connection', (s) => { s.on('error', () => {}); s.write('hi-a'); s.once('data', d => { if (String(d) === 'hi-b') done(); }); });
    b.on('connection', (s) => { s.on('error', () => {}); s.write('hi-b'); s.once('data', d => { if (String(d) === 'hi-a') done(); }); });
    (async () => {
      await a.join(topic, { server: true, client: false }).flushed();
      b.join(topic, { server: false, client: true });
      await b.flush();
    })().catch(() => {});
  });
}

(async () => {
  console.log('\n── entry points');
  ok(JSON.stringify(parseNode('1.2.3.4:49737')) === '{"host":"1.2.3.4","port":49737}', 'host:port parses');
  ok(parseNode('ab'.repeat(32) + '@node.example:49737').host === 'node.example', 'key@host:port parses');
  ok(parseNode('1.2.3.4:99999') === null && parseNode('nope') === null, 'junk refused');
  const pw0 = new Pathways({ entry: ['9.9.9.9:1000'], remembered: ['8.8.8.8:2000'] });
  const bl = pw0.bootstrapList();
  ok(bl[0].host === '9.9.9.9' && bl.some(n => n.host === '8.8.8.8') && bl.length >= 5, 'user entry first, then remembered, then defaults');
  pw0.addHints(['7.7.7.7:3000', 'wss://bridge.example/x']);
  ok(pw0.remembered[0].host === '7.7.7.7', 'invite hints become remembered entry points');

  const tn = await createTestnet(6);
  const entry = tn.bootstrap.map(n => n.host + ':' + n.port);
  const L = { defaults: false, dhtOpts: { host: '127.0.0.1' } };

  console.log('\n── UDP with remembered entry points');
  {
    const pa = new Pathways({ ...L, entry, relays: 'off' }), pb = new Pathways({ ...L, entry, relays: 'off' });
    await pa.makeDht(); await pb.makeDht();
    const a = new Hyperswarm(pa.swarmOptions()), b = new Hyperswarm(pb.swarmOptions());
    ok(await withTimeout(talk(a, b, crypto.randomBytes(32)), 20000, 'udp').catch(() => false), 'two peers meet through user entry points');
    pa.rememberNow(a.dht);
    ok(pa.remembered.length > 0, 'live DHT nodes are remembered (' + pa.remembered.length + ')');
    await a.destroy(); await b.destroy();
  }

  console.log('\n── bridge (DHT over WebSocket)');
  {
    const host = tn.createNode();
    await host.fullyBootstrapped();
    const wss = serveBridge(host, { port: 0, host: '127.0.0.1' });
    await new Promise(r => wss.once('listening', r));
    const url = 'ws://127.0.0.1:' + wss.address().port;
    const pa = new Pathways({ ...L, bridge: url, relays: 'off' }), pb = new Pathways({ ...L, entry, relays: 'off' });
    await pa.makeDht(); await pb.makeDht();
    ok(pa.usingBridge, 'client is on the bridge');
    const a = new Hyperswarm(pa.swarmOptions()), b = new Hyperswarm(pb.swarmOptions());
    const res = await withTimeout(talk(a, b, crypto.randomBytes(32)), 30000, 'bridge').catch((e) => { console.log('   ', e.message); return false; });
    ok(res, 'a bridged peer and a UDP peer talk end to end');
    await a.destroy().catch(() => {}); await b.destroy();
    wss.close(); await host.destroy();
    const pc = new Pathways({ ...L, bridge: 'ws://127.0.0.1:1', entry });
    await pc.makeDht();
    ok(!pc.usingBridge, 'unreachable bridge falls back to UDP');
    await pc.dht.destroy();
  }

  console.log('\n── volunteer blind relays');
  {
    const pv = new Pathways({ ...L, entry, volunteer: true, relays: 'off' });
    await pv.makeDht();
    const v = new Hyperswarm(pv.swarmOptions());
    await pv.startRelay(v.dht);
    ok(!!pv._relay, 'volunteer relay is up');
    const pa = new Pathways({ ...L, entry, relays: 'always' }), pb = new Pathways({ ...L, entry, relays: 'always' });
    await pa.makeDht(); await pb.makeDht();
    const a = new Hyperswarm(pa.swarmOptions()), b = new Hyperswarm(pb.swarmOptions());
    let n = 0;
    for (let i = 0; i < 10 && !n; i++) { n = await pa.refreshPool(a.dht); if (!n) await new Promise(r => setTimeout(r, 500)); }
    await pb.refreshPool(b.dht);
    ok(n >= 1, 'relay found on the rotating relay topic (' + n + ')');
    const res = await withTimeout(talk(a, b, crypto.randomBytes(32)), 30000, 'relay').catch(e => { console.log('   ', e.message); return false; });
    ok(res, 'peers connect with relaying forced');
    // On one machine every peer is reachable, so HyperDHT connects directly
    // and never needs the relay; what we can check is the hand-off.
    const pick = pa._pick(true, a);
    ok(pick && pick.toString('hex') === pv._myRelayHex, 'a failing connection is handed to the volunteer relay');
    const pAuto = new Pathways({ relays: 'auto' }); pAuto.pool.set('ab'.repeat(32), 1);
    ok(pAuto._pick(false, { dht: { randomized: false } }) === null && pAuto._pick(true, { dht: {} }) !== null, "'auto' relays only when a direct link fails");
    await a.destroy(); await b.destroy(); await pv.destroy(); await v.destroy();
  }

  await tn.destroy();
  console.log('\n' + (fail ? '❌' : '✅') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
