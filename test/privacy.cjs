/**
 * Privacy & authorship tests.
 *   • room codes are never disclosed to peers who don't already know them
 *   • membership proofs can't be replayed to a third party
 *   • older clients still discover shared rooms (and only those)
 *   • per-room signing: relayed messages verify, forgeries are caught,
 *     keys are unlinkable across rooms and to the identity key
 *
 *   node test-privacy.cjs
 */
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Duplex } = require('stream');
const hsPath = require.resolve('hyperswarm');
require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: class {
  constructor() { this.keyPair = { publicKey: crypto.randomBytes(32) }; }
  on() {} join() { return { flushed: async () => {}, destroy: async () => {} }; } async destroy() {}
} };
const SirrNetwork = require('../lib/network.js');
const SirrCrypto = require('../lib/crypto-layer.js');
const msgsig = require('../lib/msgsig.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const sec = (n) => console.log('\n── ' + n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
function pair() { const mk = () => new Duplex({ read() {}, write(c, e, cb) { this._p.push(c); cb(); } }); const a = mk(), b = mk(); a._p = b; b._p = a; return [a, b]; }
async function node(name, rooms, Net = SirrNetwork) {
  const c = new SirrCrypto(fs.mkdtempSync(path.join(os.tmpdir(), 'pv-' + name))); await c.init();
  const n = new Net(c); await n.init(name);
  for (const r of rooms) await n.joinRoom(r);
  const keys = [];
  n.on('room-keys', k => keys.push(k));
  return { n, c, keys };
}
function link(A, B) {
  const [a, b] = pair();
  A.n._onConn(a, { publicKey: B.n.swarm.keyPair.publicKey, topics: [] });
  B.n._onConn(b, { publicKey: A.n.swarm.keyPair.publicKey, topics: [] });
  return { aSeesB: A.n.peers.get(b4hex(B)), bSeesA: B.n.peers.get(b4hex(A)) };
}
const b4hex = (X) => Buffer.from(X.n.swarm.keyPair.publicKey).toString('hex').slice(0, 12);
const peerOf = (X, Y) => X.n.peers.get(b4hex(Y));

(async () => {
  const SHARED = 'SR-SHARED-ROOM-0001', PRIV = 'SR-PRIVATE-ONLY-7777', DM = 'DM-VICTIM-AND-SECRETFRIEND';

  sec('room codes are not disclosed');
  const V = await node('victim', [SHARED, PRIV, DM]);
  const S = await node('snoop', [SHARED]);
  link(V, S); await wait(300);
  const sv = peerOf(S, V);
  const everything = JSON.stringify([...(sv.declaredRooms || []), ...(sv.declaredTags || [])]);
  ok(!everything.includes(PRIV) && !everything.includes(DM), 'snoop never receives the other room codes (' + (sv.declaredRooms?.size || 0) + ' raw codes)');
  ok([...sv.rooms].join() === SHARED && [...peerOf(V, S).rooms].join() === SHARED, 'shared room still found on both sides');

  sec('membership tags cannot be replayed');
  const F = await node('friend', [SHARED, PRIV]);          // friend of victim, also in PRIV
  // snoop connects to friend and replays the victim's tags as its own
  const [a, b] = pair();
  const stolen = [...sv.declaredTags];
  const origPayload = S.n._roomsPayloadFor.bind(S.n);
  S.n._roomsPayloadFor = (peer) => { const p = origPayload(peer); p.roomTags = [...new Set([...p.roomTags, ...stolen])]; return p; };
  S.n._onConn(a, { publicKey: F.n.swarm.keyPair.publicKey, topics: [] });
  F.n._onConn(b, { publicKey: S.n.swarm.keyPair.publicKey, topics: [] });
  await wait(300);
  ok(!peerOf(F, S).rooms.has(PRIV), 'friend does NOT treat snoop as a member of the private room');
  ok(peerOf(F, S).rooms.has(SHARED), 'snoop is still seen in the room it really knows');

  sec('DMs go only to the counterpart');
  {
    const A = await node('alice', []), B = await node('bob', []), E = await node('eve', []);
    const [x, y] = [A.c.getFingerprint(), B.c.getFingerprint()].sort();
    const code = 'DM' + crypto.createHash('sha256').update(x + '|' + y).digest('hex').slice(0, 10).toUpperCase();
    for (const X of [A, B, E]) await X.n.joinRoom(code);        // Eve computed the code from public fingerprints
    link(A, B); link(A, E); await wait(400);
    let eve = null, bob = null;
    const orig = E.n._deliverChat.bind(E.n);
    E.n._deliverChat = (pid, pt) => { if (pt && pt.room === code) eve = pt; return orig(pid, pt); };   // malicious client
    B.n.on('message', m => { bob = m; });
    A.n.sendMessage(code, 'for Bob only', 'text', {});
    await wait(300);
    ok(!!bob, 'Bob receives the DM');
    ok(!eve, 'Eve (joined the computed DM code, runs a modified client) receives nothing');
    ok(A.n.peersInRoom(code).length === 1, 'file transfers / voice target only the counterpart');
    for (const X of [A, B, E]) await X.n.destroy();
  }

  sec('64-bit fingerprint collision is refused (v6.8 identity pinning)');
  {
    const A = await node('alice2', []), B = await node('bob2', []), M = await node('mallory', []);
    const [x, y] = [A.c.getFingerprint(), B.c.getFingerprint()].sort();
    const code = 'DM' + crypto.createHash('sha256').update(x + '|' + y).digest('hex').slice(0, 10).toUpperCase();
    const pins = new Map();
    A.n.pinCheck = (room, fp, id) => { const k = room + '|' + fp; if (!pins.has(k)) { pins.set(k, id); return true; } return pins.get(k) === id; };
    for (const X of [A, B, M]) await X.n.joinRoom(code);
    link(A, B); await wait(300);
    ok(A.n.peersInRoom(code).length === 1, 'Bob pinned as the DM counterpart');
    // Mallory has somehow produced a key whose 64-bit fingerprint equals Bob's.
    M.c.getFingerprint = () => B.c.getFingerprint();
    const origFor = A.c.getFingerprintFor.bind(A.c);
    A.c.getFingerprintFor = (pub) => pub === M.c.getPublicKeyB64() ? B.c.getFingerprint() : origFor(pub);
    link(A, M); await wait(300);
    const mal = peerOf(A, M);
    ok(mal && mal.fingerprint === B.c.getFingerprint(), 'precondition: Mallory presents Bob\'s fingerprint');
    ok(!A.n._peerSharesRoom(mal, code), 'Mallory is NOT treated as the DM counterpart (full identity differs)');
    ok(A.n.peersInRoom(code).length === 1 && A.n.peersInRoom(code)[0] === b4hex(B), 'DMs still go only to the real Bob');
    for (const X of [A, B, M]) await X.n.destroy();
  }

  sec('per-room signing keys');
  const kShared = V.c.roomSignPub(SHARED), kPriv = V.c.roomSignPub(PRIV);
  ok(kShared !== kPriv, 'different key per room (rooms unlinkable)');
  ok(kShared !== V.c.getPublicKeyB64(), 'room key is not the identity key');
  ok(V.c.roomSignPub(SHARED) === kShared, 'deterministic (same identity → same room key)');
  ok(S.keys.some(k => k.keys.some(x => x.room === SHARED && x.pub === kShared)), 'snoop learned victim\'s key for the SHARED room only…');
  ok(!S.keys.some(k => k.keys.some(x => x.room !== SHARED)), '…and no key for any room it isn\'t in');

  sec('relayed-message verdicts');
  const m = { channel: 'default', msgId: 'abc123', timestamp: 1700000000000, type: 'text', content: 'meet at 9', replyTo: null, fileName: '', fileSize: 0, fingerprint: V.c.getFingerprint() };
  m.sig = V.c.signForRoom(SHARED, msgsig.canonicalMessage(SHARED, m));
  const keyOf = (fp) => fp === V.c.getFingerprint() ? kShared : '';
  const judge = (mm, relayer = S.c.getFingerprint(), gk = keyOf) => msgsig.judgeRelayed({ room: SHARED, m: mm, relayerFp: relayer, getKey: gk });
  ok(judge(m) === 'authentic', 'genuine message relayed by someone else → authentic');
  ok(judge({ ...m, content: 'meet at 10' }) === 'forged', 'content altered by the relay → forged');
  ok(judge({ ...m, sig: undefined }) === 'forged', 'signature stripped → forged');
  ok(judge({ ...m, msgId: 'zzz' }) === 'forged', 'signature moved to another message → forged');
  ok(msgsig.judgeRelayed({ room: PRIV, m, relayerFp: S.c.getFingerprint(), getKey: () => kPriv }) === 'forged', 'signature replayed into another room → forged');
  ok(judge(m, S.c.getFingerprint(), () => '') === 'unverified', 'author never met → unverified (kept, flagged)');
  ok(judge({ ...m, fingerprint: S.c.getFingerprint(), sig: 'x' }, S.c.getFingerprint()) === 'authentic', 'relayed by its own author → authentic');
  const at = 1700000500000;
  const edited = { ...m, content: 'meet at 9:30', editedAt: at, editSig: V.c.signForRoom(SHARED, msgsig.canonicalEdit(SHARED, 'default', m.msgId, 'meet at 9:30', at)) };
  ok(judge(edited) === 'authentic', 'edited message verifies via the edit signature');
  ok(judge({ ...edited, content: 'meet at 11' }) === 'forged', 'edit content altered → forged');

  sec('deniability');
  // A third party given (message, sig, room key) learns nothing linking the key to an identity.
  const leaked = JSON.stringify({ m, pub: kShared });
  ok(!leaked.includes(V.c.getPublicKeyB64()), 'leaked message + key contain no identity key');
  ok(!leaked.includes(PRIV) && !leaked.includes(DM), 'nor any other room of the author');

  for (const X of [V, S, F]) await X.n.destroy();
  console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
