/**
 * Sealed records — what someone holding the transport key sees and can do.
 *
 * A custodial bridge terminates the Noise transport, so for this test the
 * "bridge" is simply a tap on the byte stream between two real
 * SirrNetwork instances. Everything a bridge could read is what the tap
 * records; everything it could forge is what we inject.
 *
 *   node test/sealed.cjs
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

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const sec = (n) => console.log('\n── ' + n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(10); } return false; };

// Socket pair with a tap: every byte written either way is recorded.
function tappedPair(tap) {
  const mk = (dir) => new Duplex({ read() {}, write(chunk, enc, cb) {
    tap.push({ dir, buf: Buffer.from(chunk) });
    this._peer.push(chunk); cb();
  } });
  const a = mk('A>B'), b = mk('B>A'); a._peer = b; b._peer = a;
  return [a, b];
}
const linesOf = (tap, dir) => Buffer.concat(tap.filter(t => !dir || t.dir === dir).map(t => t.buf)).toString('utf8').split('\n').filter(Boolean);

(async () => {
  async function mk(name) {
    const c = new SirrCrypto(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-' + name))); await c.init();
    const n = new SirrNetwork(c); await n.init(name); return n;
  }
  const A = await mk('alice'), B = await mk('bob');
  const room = 'TESTROOM';
  await A.joinRoom(room); await B.joinRoom(room);
  A.nickname = 'alice-secret-nick'; A.statusText = 'status-secret';
  const tap = [];
  const [sa, sb] = tappedPair(tap);
  const pkA = A.swarm.keyPair.publicKey, pkB = B.swarm.keyPair.publicKey;
  A._onConn(sa, { publicKey: pkB, topics: [] });
  B._onConn(sb, { publicKey: pkA, topics: [] });
  const bAtA = pkB.toString('hex').slice(0, 12), aAtB = pkA.toString('hex').slice(0, 12);
  const errsB = []; B.on('crypto-error', e => errsB.push(e.error));

  sec('session');
  ok(await until(() => A.crypto.hasSession(bAtA) && B.crypto.hasSession(aAtB)), 'session both ways');
  ok(await until(() => B.peers.get(aAtB)?.nickname === 'alice-secret-nick'), 'profile arrives (sealed)');
  ok(await until(() => B.peers.get(aAtB)?.rooms.has(room)), 'room membership reconciled (sealed ANNOUNCE)');

  sec('everything a bridge could carry');
  const got = { chat: null, voice: null, pin: null, rename: null, typing: null };
  B.on('message', m => { got.chat = m; });
  B.on('voice-media', m => { got.voice = m; });
  B.on('pin-toggle', m => { got.pin = m; });
  B.on('room-renamed', m => { got.rename = m; });
  B.on('peer-typing', m => { got.typing = m; });
  const voiceBytes = Buffer.alloc(160, 0); voiceBytes.write('VOICEPATTERN-1234567890', 0);
  A.sendMessage(room, 'chat-body-secret', 'text', {});
  A.sendVoiceMedia(bAtA, voiceBytes, room);
  A.broadcastPinToggle(room, 'default', 'm1', true, { preview: 'pin-preview-secret', nick: 'alice-secret-nick' });
  A.broadcastRoomRename(room, 'room-name-secret');
  A.sendTyping(room, 'default');
  await until(() => got.chat && got.voice && got.typing && got.pin && got.rename);
  ok(got.pin && got.rename, 'pin and rename delivered');
  ok(got.chat && got.chat.content === 'chat-body-secret', 'chat delivered');
  ok(got.voice && Buffer.from(got.voice.bytes || got.voice.data || []).includes(Buffer.from('VOICEPATTERN')), 'voice delivered');
  ok(got.typing, 'typing delivered');

  const all = linesOf(tap).join('\n');
  const secrets = ['alice-secret-nick', 'status-secret', 'chat-body-secret', 'pin-preview-secret', 'room-name-secret',
                   room, voiceBytes.toString('base64').slice(0, 24), 'VOICEPATTERN'];
  for (const sct of secrets) ok(!all.includes(sct), 'bridge cannot read: ' + sct.slice(0, 24));
  const types = new Set(linesOf(tap).map(l => { try { return JSON.parse(l).type; } catch (e) { return 'binary'; } }));
  ok([...types].every(t => t === 0x01 || t === 0x05 || t === 0x70 || t === 0x08 || t === 0x09), 'only handshake, keepalive and sealed records on the wire: ' + [...types].map(t => typeof t === 'number' ? '0x' + t.toString(16) : t).join(','));
  // sizes: records are padded to buckets
  const sizes = linesOf(tap).map(l => { try { const o = JSON.parse(l); return o.type === 0x70 ? Buffer.from(o.d, 'base64').length - 8 - 16 : -1; } catch (e) { return -1; } }).filter(n => n > 0);
  ok(sizes.length && sizes.every(n => [256, 1024, 4096, 16384].includes(n) || n % 16384 === 0), 'every record is bucket-padded');

  sec('what a bridge can forge');
  const before = { rename: got.rename, pin: got.pin };
  got.rename = null; got.pin = null; got.typing = null;
  sb.push(Buffer.from(JSON.stringify({ type: 0x07, room, newName: 'pwned' }) + '\n'));
  sb.push(Buffer.from(JSON.stringify({ type: 0x34, room, channel: 'default', msgId: 'x', pinned: true, preview: 'p', nick: 'n' }) + '\n'));
  sb.push(Buffer.from(JSON.stringify({ type: 0x06, room, channel: 'default' }) + '\n'));
  sb.push(Buffer.from(JSON.stringify({ type: 0x16, room, d: Buffer.from('injected').toString('base64') }) + '\n'));
  sb.push(Buffer.from(JSON.stringify({ type: 0x04 }) + '\n'));
  await wait(60);
  ok(!got.rename && !got.pin && !got.typing, 'clear frames after the session are ignored (rename, pin, typing)');
  ok(B.peers.has(aAtB), 'a clear LEAVE cannot end an established session');
  void before;

  // Replay: re-inject a record A already sent.
  const recA = linesOf(tap, 'A>B').map(l => JSON.parse(l)).filter(o => o.type === 0x70);
  const replay = recA[recA.length - 1];
  sb.push(Buffer.from(JSON.stringify(replay) + '\n'));
  await wait(40);
  ok(errsB.some(e => /replayed|reordered/.test(e)), 'replayed record rejected');
  ok(!B.peers.has(aAtB), 'tampering ends the session (fresh handshake follows)');

  sec('records: crypto layer');
  {
    const nacl = require('tweetnacl');
    const mkC = async () => { const c = new SirrCrypto(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-k'))); await c.init(); return c; };
    const P = await mkC(), Q = await mkC();
    const ep = P.beginEphemeral('q').ephPub64, eq = Q.beginEphemeral('p').ephPub64;
    const tp = P.ephemeralAuth('q', Q.getPublicKeyB64(), eq, 'b'), tq = Q.ephemeralAuth('p', P.getPublicKeyB64(), ep, 'b');
    P.completeEphemeral('q', Q.getPublicKeyB64(), eq, tq); Q.completeEphemeral('p', P.getPublicKeyB64(), ep, tp);
    const r1 = P.seal('one', 'q'), r2 = P.seal('two', 'q'), r3 = P.seal('three', 'q');
    ok(r1 !== P.seal('one', 'q'), 'same plaintext, different record');
    ok(Q.unseal(r1, 'p') === 'one', 'in order: one');
    let rep = false; try { Q.unseal(r1, 'p'); } catch (e) { rep = true; }
    ok(rep, 'replay of record 0 refused');
    const bad = Buffer.from(r3, 'base64'); bad[bad.length - 1] ^= 1;
    let tam = false; try { Q.unseal(bad.toString('base64'), 'p'); } catch (e) { tam = true; }
    ok(tam, 'tampered record refused');
    const hdr = Buffer.from(r2, 'base64'); hdr.writeUInt32BE(7, 4);
    let hd = false; try { Q.unseal(hdr.toString('base64'), 'p'); } catch (e) { hd = true; }
    ok(hd, 'rewritten counter refused');
    ok(Q.unseal(r3, 'p') === 'three', 'a lost record is skipped; the chain still opens what follows');
    let old = false; try { Q.unseal(r2, 'p'); } catch (e) { old = true; }
    ok(old, 'a late record behind the chain is refused');
    ok(P.unseal(Q.seal('back', 'p'), 'q') === 'back', 'other direction');
    let far = false; try { const x = Buffer.from(P.seal('x', 'q'), 'base64'); x.writeUInt32BE(1e6, 4); Q.unseal(x.toString('base64'), 'p'); } catch (e) { far = /gap/.test(e.message); }
    ok(far, 'absurd forward jump refused without walking the chain');

    // Forward secrecy inside the session: the current state can't open old records.
    const sent = P.seal('past', 'q');
    ok(Q.unseal(sent, 'p') === 'past', 'past record delivered');
    const thief = { ...Q.sessionKeys.get('p') };
    const st = { recv: { ...thief.recv, ck: Buffer.from(thief.recv.ck) }, send: { ...thief.send, ck: Buffer.from(thief.send.ck) } };
    const Z = await mkC(); Z.sessionKeys.set('p', { ...thief, recv: st.recv, send: st.send, boltBase: Buffer.alloc(32) });
    let past = false; try { Z.unseal(sent, 'p'); } catch (e) { past = true; }
    ok(past, 'keys copied now do not open records already received');

    // …but they would open the next one — until a DH rekey.
    const next = P.seal('next', 'q');
    ok(Z.unseal(next, 'p') === 'next', '(sanity) a copied chain follows the session until the rekey');
    ok(Q.unseal(next, 'p') === 'next', 'Q stays in step');
    const init = P.sessionKeys.get('q').initiator ? [P, 'q', Q, 'p'] : [Q, 'p', P, 'q'];
    const [I, iId, R, rId] = init;
    const e1 = I.rekeyStart(iId);
    ok(typeof e1 === 'string' && !R.rekeyStart(rId), 'only one side initiates rekeys');
    const rr = R.rekeyRespond(rId, e1);
    const ackRec = R.seal(JSON.stringify({ ack: rr.pub }), rId); rr.commit();
    I.unseal(ackRec, iId); I.rekeyFinish(iId, rr.pub);
    const afterP = P.seal('after-rekey', 'q');
    ok(Q.unseal(afterP, 'p') === 'after-rekey', 'P→Q continues across the rekey');
    ok(P.unseal(Q.seal('after-too', 'p'), 'q') === 'after-too', 'Q→P continues across the rekey');
    ok(P.getSessionInfo('q').epoch >= 1 && Q.getSessionInfo('p').epoch >= 1, 'both sides moved to epoch 1');
    let locked = false;
    try { const x = Z.unseal(afterP, 'p'); locked = x !== 'after-rekey'; } catch (e) { locked = true; }
    ok(locked, 'after the rekey the copied keys open nothing (post-compromise recovery)');
    let early = false; try { R.rekeyFinish(rId, e1); } catch (e) { early = true; }
    ok(early, 'an unsolicited rekey answer is refused');
    void nacl;
  }

  sec('rekey over the network');
  {
    const C = await mk('carol'), D = await mk('dave');
    await C.joinRoom(room); await D.joinRoom(room);
    const tap2 = [];
    const [sc, sd] = tappedPair(tap2);
    const pkC = C.swarm.keyPair.publicKey, pkD = D.swarm.keyPair.publicKey;
    C._onConn(sc, { publicKey: pkD, topics: [] }); D._onConn(sd, { publicKey: pkC, topics: [] });
    const dAtC = pkD.toString('hex').slice(0, 12), cAtD = pkC.toString('hex').slice(0, 12);
    await until(() => C.crypto.hasSession(dAtC) && D.crypto.hasSession(cAtD) && D.peers.get(cAtD)?.rooms.has(room) && C.peers.get(dAtC)?.rooms.has(room));
    const [I, iPid] = C.crypto.sessionKeys.get(dAtC).initiator ? [C, dAtC] : [D, cAtD];
    I.crypto.sessionKeys.get(iPid).lastRekey = 0;
    ok(I._maybeRekey(iPid, I.peers.get(iPid)), 'initiator starts a rekey when due');
    ok(await until(() => C.crypto.getSessionInfo(dAtC)?.epoch >= 1 && D.crypto.getSessionInfo(cAtD)?.epoch >= 1), 'both ends roll to epoch 1');
    const seen = [];
    D.on('message', m => seen.push('D:' + m.content)); C.on('message', m => seen.push('C:' + m.content));
    for (let i = 0; i < 20; i++) { C.sendMessage(room, 'c' + i, 'text', {}); D.sendMessage(room, 'd' + i, 'text', {}); }
    ok(await until(() => seen.length === 40), 'traffic flows both ways after the rekey (' + seen.length + '/40)');
    ok(C.peers.has(dAtC) && D.peers.has(cAtD), 'link intact');
  }

  sec('"sig ok" means a checked signature');
  {
    const { EventEmitter } = require('events');
    const msgsig = require('../lib/msgsig.js');
    const S = require('../lib/storage.js');
    const st = new S(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-st')));
    const net = new EventEmitter(); net.identityIdOf = () => ''; net.joinRoom = () => {};
    const tr = new EventEmitter(); tr.saveTo = () => {};
    const out = []; const sendUi = (ch, d) => out.push([ch, d]);
    require('../lib/core-events.js').wireCore({ storage: st, network: net, crypto: null, transfers: tr, send: sendUi, attention: () => {}, downloadsDir: os.tmpdir() });
    const author = await (async () => { const c = new SirrCrypto(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-au'))); await c.init(); return c; })();
    const R = 'SR-TEST'; st.addRoom(R);
    const fp = author.getFingerprint();
    st.setRoomSignKey(R, fp, author.roomSignPub(R), '');
    const mkMsg = (id, content) => { const m = { room: R, channel: 'default', msgId: id, content, timestamp: 5, type: 'text', fingerprint: fp, nickname: 'au' };
      m.sig = author.signForRoom(R, msgsig.canonicalMessage(R, m)); return m; };
    const good = mkMsg('g1', 'hello');
    net.emit('message', { ...good });
    const bad = mkMsg('b1', 'original'); bad.content = 'swapped';
    net.emit('message', { ...bad });
    const unknown = { ...mkMsg('u1', 'x'), fingerprint: 'AAAA BBBB CCCC DDDD' };
    net.emit('message', unknown);
    const ui = (id) => out.filter(([ch, d]) => ch === 'network:message' && d.msgId === id).map(([, d]) => d)[0];
    ok(ui('g1') && ui('g1').sigOk === true, 'valid signature → sigOk');
    ok(ui('b1') && ui('b1').sigOk === false, 'signature over different content → not ok');
    ok(ui('u1') && ui('u1').sigOk === undefined, 'no room key for the author → no claim either way');
    ok(st.messages.getMessage(R, 'default', 'g1').sigOk === true && !st.messages.getMessage(R, 'default', 'b1').sigOk, 'stored flag matches');
    const chatSrc = fs.readFileSync(path.join(__dirname, '../renderer/modules/chat.js'), 'utf8');
    ok(/msg\.self \|\| msg\.sigOk === true \|\| msg\.verified === true/.test(chatSrc), 'renderer shows "sig ok" only for self, sigOk or verified');

    // Edits: bounded, and re-checked.
    const at = 99;
    const eSig = author.signForRoom(R, msgsig.canonicalEdit(R, 'default', 'g1', 'edited', at));
    net.emit('msg-edit', { room: R, channel: 'default', msgId: 'g1', content: 'edited', editedAt: at, editSig: eSig, fingerprint: fp });
    const ed = out.filter(([ch]) => ch === 'network:msg-edit').map(([, d]) => d);
    ok(ed.length === 1 && ed[0].sigOk === true && st.messages.getMessage(R, 'default', 'g1').content === 'edited', 'signed edit applied, still sig ok');
    net.emit('msg-edit', { room: R, channel: 'default', msgId: 'g1', content: 'forged edit', editedAt: at, editSig: eSig, fingerprint: fp });
    ok(st.messages.getMessage(R, 'default', 'g1').sigOk === undefined, 'edit whose signature fails drops the badge');
    const n0 = out.length;
    net.emit('msg-edit', { room: R, channel: 'default', msgId: 'g1', content: 'z'.repeat(8001), editedAt: at, editSig: '', fingerprint: fp });
    ok(out.length === n0 && st.messages.getMessage(R, 'default', 'g1').content.length < 8001, 'oversized edit refused');
    st.messages.close();
  }

  console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
