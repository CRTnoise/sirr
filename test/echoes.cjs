/**
 * Echoes on a local HyperDHT testnet: a message written while the reader
 * is away is found later, after the writer has gone.   node test/echoes.cjs
 */
const createTestnet = require('hyperdht/testnet');
const crypto = require('crypto');
const { Echoes } = require('../lib/echoes.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  const tn = await createTestnet(8);
  const room = 'SR-TEST-ROOM';
  const secret = crypto.createHash('sha256').update('sirr/rv/1|' + room).digest();
  const W_FP = '8F3A 21C9 7E04 B6D2', R_FP = '1C77 E0A4 93BF 5D20';

  // Writer: online, writes, leaves.
  const wd = tn.createNode();
  await wd.fullyBootstrapped();
  const puts = [];
  const origPut = wd.mutablePut.bind(wd);
  wd.mutablePut = (kp, v, o) => { puts.push(v.length); return origPut(kp, v, o); };
  const W = new Echoes({ dht: () => wd, secretFor: () => secret, myFp: () => W_FP });
  const msgs = [
    { msgId: 'm1', timestamp: Date.now(), type: 'text', content: 'are you safe?', channel: 'default', nickname: 'ana', sig: 'x'.repeat(88) },
    { msgId: 'm2', timestamp: Date.now() + 1, type: 'text', content: 'meet at the usual place', channel: 'default', nickname: 'ana', sig: 'y'.repeat(88) },
    { msgId: 'm3', timestamp: Date.now() + 2, type: 'text', content: 'L'.repeat(2500), channel: 'default', nickname: 'ana', sig: 'z'.repeat(88) },
  ];
  for (const m of msgs) await W.write(room, m);
  ok(puts.length >= 9, 'writer put ' + puts.length + ' records (long message split)');
  ok(new Set(puts).size === 1, 'every record has the same size (' + puts[0] + ' B)');
  await wd.destroy();

  // Reader: comes online later, writer is gone.
  const rd = tn.createNode();
  await rd.fullyBootstrapped();
  const R = new Echoes({ dht: () => rd, secretFor: () => secret, myFp: () => R_FP });
  const got = [];
  R.on('echo', e => got.push(e.m));
  const n = await R.poll(room, [W_FP]);
  ok(n === 3 && got.map(m => m.msgId).join() === 'm1,m2,m3', 'reader finds all 3 messages with the writer offline');
  ok(got[2] && got[2].content.length === 2500, 'multi-part message reassembled');
  ok(got[0] && got[0].fingerprint === W_FP && got[0].sig === 'x'.repeat(88), 'author and signature preserved for verification');
  const again = await R.poll(room, [W_FP]);
  ok(again === 0, 'nothing is delivered twice');

  // Outsider without the room secret sees nothing.
  const od = tn.createNode(); await od.fullyBootstrapped();
  const O = new Echoes({ dht: () => od, secretFor: () => crypto.randomBytes(32), myFp: () => 'AAAA BBBB CCCC DDDD' });
  let leaked = 0; O.on('echo', () => leaked++);
  await O.poll(room, [W_FP]);
  ok(leaked === 0, 'someone without the room code finds nothing');

  // A later member echoes: the reader's refresh re-puts records — a second reader still finds them.
  const rd2 = tn.createNode(); await rd2.fullyBootstrapped();
  const R2 = new Echoes({ dht: () => rd2, secretFor: () => secret, myFp: () => 'EEEE FFFF 0000 1111' });
  const got2 = []; R2.on('echo', e => got2.push(e.m));
  await R2.poll(room, [W_FP]);
  ok(got2.length === 3, 'a second reader, later, still finds them');

  for (const d of [rd, od, rd2]) await d.destroy();
  await tn.destroy();
  console.log('\n' + (fail ? '❌' : '✅') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
