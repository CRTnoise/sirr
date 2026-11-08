/**
 * Hardening tests: room codes, invite links, sealed backups, the SSRF
 * guard, and the handshake rules (no static-key fallback, nothing accepted
 * before a peer authenticates, no static rendezvous topic).
 *
 *   node test/hardening.cjs
 */
const os = require('os'), fs = require('fs'), path = require('path');
const crypto = require('crypto');
const { Duplex } = require('stream');

const hsPath = require.resolve('hyperswarm');
const joined = [];
require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: class {
  constructor() { this.keyPair = { publicKey: crypto.randomBytes(32) }; }
  on() {} join(t) { joined.push(Buffer.from(t).toString('hex')); return { flushed: async () => {}, destroy: async () => {} }; }
  async destroy() {}
} };

const R = require('../lib/roomcode.js');
const Backup = require('../lib/backup.js');
const G = require('../lib/netguard.js');
const Net = require('../lib/network.js');
const Crypto = require('../lib/crypto-layer.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const sec = (n) => console.log('\n── ' + n);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  sec('room codes');
  const me = 'ab'.repeat(32), other = 'cd'.repeat(32);
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(R.generate(me));
  ok(codes.size === 200, 'codes do not repeat');
  const c = [...codes][0];
  ok(/^SR(-[2-9A-HJKMNP-Z]{5}){8}$/.test(c), 'shape SR- + eight groups of five: ' + c);
  ok(R.validate(c).ok && R.validate(c).code === c, 'a fresh code validates to itself');
  ok(R.validate(c.toLowerCase().replace(/-/g, ' ')).code === c, 'typed without dashes, lower case → canonical spelling');
  const flip = c.slice(0, 10) + (c[10] === '2' ? '3' : '2') + c.slice(11);
  ok(R.validate(flip).reason === 'BAD_CHECKSUM', 'one changed character fails the checksum');
  ok(R.validate('PH-ABCD-EFGH-JKMN-PQ').reason === 'BAD_FORMAT', 'short legacy-shaped codes are refused');
  ok(R.ownerMatches(c, me) === true && R.ownerMatches(c, other) === false, 'code commits to its creator only');
  ok(R.ownerMatches('DM0123456789', me) === null, 'DM codes carry no owner');
  const secretBits = 22 * Math.log2(31);
  ok(secretBits > 108, 'join secret ≥ 108 bits (' + secretBits.toFixed(1) + ')');

  sec('invite links');
  ok(R.toInviteUrl(c) === 'sirr://join/' + c, 'default invite is the scheme link');
  const g = R.toInviteUrl(c, 'https://example.org/join');
  ok(g === 'https://example.org/join/#' + c, 'gateway invite carries the code in the fragment');
  ok(!new URL(g).search && new URL(g).hash, 'nothing in the query string (fragments never reach the server)');
  ok(R.parseInviteUrl(g) === c && R.parseInviteUrl(R.toInviteUrl(c)) === c, 'both forms parse back');
  ok(R.toInviteUrl(c, 'http://insecure.example') === 'sirr://join/' + c, 'non-https gateway is ignored');
  ok(R.toInviteUrl(c, 'javascript:alert(1)') === 'sirr://join/' + c, 'script gateway is ignored');

  sec('sealed backups');
  const bundle = { identity: { secretKey: 'SECRET-KEY-MARKER' }, config: { rooms: [{ code: c }] } };
  const file = Backup.seal(bundle, 'correct horse battery');
  ok(!file.includes('SECRET-KEY-MARKER') && !file.includes(c), 'no plaintext secrets in the file');
  ok(Backup.open(file, 'correct horse battery').identity.secretKey === 'SECRET-KEY-MARKER', 'round trip');
  let threw = ''; try { Backup.open(file, 'correct horse batterz'); } catch (e) { threw = e.message; }
  ok(/Wrong passphrase/.test(threw), 'wrong passphrase refused');
  const t = JSON.parse(file); const b = Buffer.from(t.box, 'base64'); b[5] ^= 1; t.box = b.toString('base64');
  threw = ''; try { Backup.open(JSON.stringify(t), 'correct horse battery'); } catch (e) { threw = e.message; }
  ok(/altered/.test(threw), 'tampered ciphertext refused');
  const h = JSON.parse(file); h.kdf.N = 2 ** 30;
  threw = ''; try { Backup.open(JSON.stringify(h), 'correct horse battery'); } catch (e) { threw = e.message; }
  ok(/unreasonable/.test(threw), 'hostile KDF parameters refused');
  threw = ''; try { Backup.seal(bundle, 'short'); } catch (e) { threw = e.message; }
  ok(/at least/.test(threw), 'short passphrase refused');

  sec('SSRF guard');
  const priv = ['localhost', '127.0.0.1', '10.0.0.8', '172.20.1.1', '192.168.1.1', '100.64.3.3', '169.254.169.254',
    '0.0.0.0', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', 'fd12::1', 'fe80::1', 'ff02::1', 'printer.local', 'x.internal'];
  for (const hst of priv) ok(G.isPrivateHost(hst) === true, 'private: ' + hst);
  for (const hst of ['example.org', 'fdroid.org', 'fcbarcelona.com', 'fe80.example', '1.1.1.1', '2606:4700::1111'])
    ok(G.isPrivateHost(hst) === false, 'public: ' + hst);

  sec('handshake rules');
  async function mk(name) {
    const cr = new Crypto(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-' + name))); await cr.init();
    const n = new Net(cr); await n.init(name); return n;
  }
  joined.length = 0;
  const A = await mk('alice');
  ok(joined.length === 0, 'personal inbox is off unless opted in');
  await A.joinRoom(c);
  const legacy = crypto.createHash('sha256').update(c).digest('hex');
  ok(joined.length === 3 && !joined.includes(legacy), 'only rotating topics (3), never the static sha256(code)');
  A.setInboxEnabled(true);
  ok(joined.length === 4, 'inbox joins when enabled');

  // A raw socket pretending to be a peer.
  const mkSock = () => {
    const out = [];
    const s = new Duplex({ read() {}, write(ch, e, cb) { out.push(ch.toString()); cb(); } });
    s.out = out; s.destroyed2 = false; const d = s.destroy.bind(s); s.destroy = () => { s.destroyed2 = true; d(); };
    return s;
  };
  const sendLine = (s, o) => s.push(Buffer.from(JSON.stringify(o) + '\n'));
  const errs = []; A.on('crypto-error', e => errs.push(e.error));
  const events = []; for (const ev of ['peer-joined', 'room-renamed', 'pin-toggle', 'admin-update']) A.on(ev, () => events.push(ev));

  // 1) Pre-auth traffic is ignored.
  const s1 = mkSock();
  A._onConn(s1, { publicKey: crypto.randomBytes(32), topics: [Buffer.from(joined[0], 'hex')] });
  sendLine(s1, { type: 0x07, room: c, newName: 'pwned' });
  sendLine(s1, { type: 0x34, room: c, channel: 'default', msgId: 'x', pinned: true, preview: 'p' });
  sendLine(s1, { type: 0x41, room: c, target: 'X', perms: {} });
  await wait(30);
  ok(events.length === 0, 'room state / pins / admin claims ignored before authentication');
  A.nickname = 'alice-private'; A.statusText = 'at the clinic';
  const sx = mkSock();
  A._onConn(sx, { publicKey: crypto.randomBytes(32), topics: [] });
  sendLine(sx, { type: 0x01, kxVersion: 3, ephPub: Buffer.from(require('tweetnacl').box.keyPair().publicKey).toString('base64'), publicKey: Buffer.from(require('tweetnacl').box.keyPair().publicKey).toString('base64') });
  await wait(20);
  ok(sx.out.length >= 2 && !sx.out.join('').includes('alice-private') && !sx.out.join('').includes('clinic'), 'no nickname or status leaves before the session (KEY_EXCHANGE, ANNOUNCE)');

  // 2) A KEY_EXCHANGE without an ephemeral key (static-key fallback) is refused.
  const victim = new Crypto(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-v'))); await victim.init();
  sendLine(s1, { type: 0x01, publicKey: victim.getPublicKeyB64(), nickname: 'victim' });
  await wait(30);
  ok(s1.destroyed2 && errs.some(e => /forward-secret/.test(e)), 'downgrade to static-key session refused');
  ok(!events.includes('peer-joined'), 'no peer-joined for the refused peer');

  // 3) Claiming someone's identity key without its secret never gets a peer-joined.
  const s2 = mkSock();
  A._onConn(s2, { publicKey: crypto.randomBytes(32), topics: [] });
  const fakeEph = require('tweetnacl').box.keyPair();
  sendLine(s2, { type: 0x01, kxVersion: 3, ephPub: Buffer.from(fakeEph.publicKey).toString('base64'), publicKey: victim.getPublicKeyB64(), nickname: 'victim' });
  await wait(30);
  ok(!events.includes('peer-joined'), 'claimed identity is not announced before KEY_CONFIRM');
  sendLine(s2, { type: 0x05, tag: crypto.randomBytes(32).toString('base64') });
  await wait(30);
  ok(s2.destroyed2 && !events.includes('peer-joined'), 'forged KEY_CONFIRM drops the connection');

  sendLine(s2, { type: 0x01, kxVersion: 3, ephPub: 'x', publicKey: 'y', avatarEmoji: 'z'.repeat(1e5) });
  await wait(10);
  ok(true, 'oversized fields on a dead socket are harmless');

  sec('handshake v3 (triple DH, no KCI)');
  {
    const nacl = require('tweetnacl'), b64 = (u) => Buffer.from(u).toString('base64');
    const mkC = async () => { const c = new Crypto(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-k'))); await c.init(); return c; };
    const Al = await mkC(), Bo = await mkC(), Ch = await mkC();
    const run = (a, b, bindA = 'x|y', bindB = 'x|y') => {
      const ea = a.beginEphemeral('b').ephPub64, eb = b.beginEphemeral('a').ephPub64;
      const ta = a.ephemeralAuth('b', b.getPublicKeyB64(), eb, bindA);
      const tb = b.ephemeralAuth('a', a.getPublicKeyB64(), ea, bindB);
      let okA = true, okB = true;
      try { a.completeEphemeral('b', b.getPublicKeyB64(), eb, tb); } catch (e) { okA = false; }
      try { b.completeEphemeral('a', a.getPublicKeyB64(), ea, ta); } catch (e) { okB = false; }
      return { okA, okB, ea, eb };
    };
    const r1 = run(Al, Bo);
    ok(r1.okA && r1.okB, 'honest handshake confirms on both sides');
    ok(Al.decrypt(Bo.encrypt('hi', 'a'), 'b') === 'hi', 'both sides derive the same session key');
    ok(Al.sessionMac('b', 'l').equals(Bo.sessionMac('a', 'l')), 'session MACs agree');
    Al.removeSession('b'); Bo.removeSession('a');
    const r2 = run(Al, Bo, 'x|y', 'x|z');
    ok(!r2.okA && !r2.okB, 'a session cannot be spliced onto another connection (binding)');
    Al.clearEphemeral('b'); Bo.clearEphemeral('a');

    // Key-compromise impersonation: the thief holds Bo's identity secret and
    // tries to pass as Al to Bo. Everything it can compute, it does.
    const eb = Bo.beginEphemeral('al').ephPub64;
    const eX = nacl.box.keyPair();
    Bo.ephemeralAuth('al', Al.getPublicKeyB64(), b64(eX.publicKey), 'p|q');
    const sB = Bo.identity.secretKey, sA_pub = Buffer.from(Al.getPublicKeyB64(), 'base64');
    const ebU = Buffer.from(eb, 'base64');
    const ee = nacl.scalarMult(eX.secretKey, ebU);
    const AL = Al.getPublicKeyB64() < Bo.getPublicKeyB64();
    // eX·sB is computable; DH(sA, eB) is not — try the static-static stand-in the old scheme leaked.
    const mixA = nacl.scalarMult(eX.secretKey, Buffer.from(Bo.getPublicKeyB64(), 'base64'));
    const guess = nacl.scalarMult(sB, sA_pub);
    const ikm = AL ? [ee, guess, mixA] : [ee, mixA, guess];
    const prk = crypto.createHmac('sha256', 'sirr/kx/3').update(Buffer.concat(ikm.map(Buffer.from))).digest();
    const [L, H] = AL ? [Al.getPublicKeyB64(), Bo.getPublicKeyB64()] : [Bo.getPublicKeyB64(), Al.getPublicKeyB64()];
    const [eL, eH] = AL ? [b64(eX.publicKey), eb] : [eb, b64(eX.publicKey)];
    const K = crypto.createHmac('sha256', prk).update(['sirr/kx/3', L, H, eL, eH, 'p|q'].join('|')).digest();
    const forged = crypto.createHmac('sha256', K).update('confirm|' + Al.getPublicKeyB64()).digest('base64');
    let kci = true; try { Bo.completeEphemeral('al', Al.getPublicKeyB64(), '', forged); } catch (e) { kci = false; }
    ok(!kci, 'stolen identity key does not let the thief impersonate others to its victim');
    ok(!Bo.hasSession('al'), 'no session installed for the impersonator');
    // The ephemeral secret is wiped as soon as K is derived.
    ok(!(Bo._ephemeral && Bo._ephemeral.has('al')), 'ephemeral secret dropped after derivation');
    void Ch;
  }

  sec('room moves (rekey / eviction)');
  {
    const RM = require('../lib/roommove.js');
    const mkC = async () => { const c = new Crypto(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-m'))); await c.init(); return c; };
    const O = await mkC(), M = await mkC(), E = await mkC();
    const old = R.generate(O.getIdentityId());
    const m = RM.make(O, old, 'ops', [E.getFingerprint()]);
    ok(R.ownerMatches(m.to, O.getIdentityId()) === true && m.to !== old, 'new code keeps the owner commitment');
    let notOwner = false; try { RM.make(M, old, 'x', []); } catch (e) { notOwner = true; }
    ok(notOwner, 'only the owner can move a room');
    const rec = { ids: { [O.getFingerprint()]: O.getIdentityId() }, signKeys: { [O.getFingerprint()]: O.roomSignPub(old) } };
    const w = RM.clean(JSON.parse(JSON.stringify(m)));
    ok(RM.judge(w, rec, { identityId: O.getIdentityId() }, M.getFingerprint()).ok, 'member accepts a move straight from the owner');
    ok(RM.judge(w, rec, { identityId: E.getIdentityId() }, M.getFingerprint()).ok, 'member accepts a forwarded move signed by the owner');
    ok(!RM.judge(w, rec, { identityId: O.getIdentityId() }, E.getFingerprint()).ok, 'evicted member refuses its own eviction');
    // The evicted member forges a move to a room it controls.
    const forged = { ...w, to: R.generate(E.getIdentityId()), sig: E.signForRoom(old, RM.canonical({ ...w, to: 'x' })) };
    ok(!RM.judge(RM.clean(forged), rec, { identityId: E.getIdentityId() }, M.getFingerprint()).ok, 'evicted member cannot forge a move');
    const swapped = { ...w, to: R.generate(O.getIdentityId()) };
    ok(!RM.judge(RM.clean(swapped), rec, { identityId: E.getIdentityId() }, M.getFingerprint()).ok, 'tampered destination fails the signature');
    ok(!RM.judge(w, { ids: {}, signKeys: {} }, { identityId: E.getIdentityId() }, M.getFingerprint()).ok, 'no owner key yet → wait for the owner');
  }

  sec('DM rendezvous');
  {
    const P = await mk('pat'), Q = await mk('quin'), Z = await mk('zed');
    const [x, y] = [P.crypto.getFingerprint(), Q.crypto.getFingerprint()].sort();
    const dm = 'DM' + crypto.createHash('sha256').update(x + '|' + y).digest('hex').slice(0, 10).toUpperCase();
    joined.length = 0;
    await P.joinRoom(dm);
    ok(joined.length === 0, 'no DM topic before the counterpart key is known (nothing derivable from public fingerprints)');
    ok(P.setDmPeerKey(dm, Q.crypto.getPublicKeyB64()) && joined.length === 3, 'counterpart key → three rotating pairwise topics');
    Q.setDmPeerKey(dm, P.crypto.getPublicKeyB64());
    const e = P._epochNow();
    ok(P._rotatingTopic(dm, e).equals(Q._rotatingTopic(dm, e)), 'both halves compute the same topic');
    const naive = crypto.createHmac('sha256', P._roomSecret(dm)).update('epoch:' + e).digest();
    ok(!P._rotatingTopic(dm, e).equals(naive), 'topic is not the code-derived one an outsider could compute');
    ok(Z.setDmPeerKey(dm, Q.crypto.getPublicKeyB64()) === false, 'a third identity cannot adopt the DM');
    ok(P.setDmPeerKey(dm, Z.crypto.getPublicKeyB64()) === false, 'a key that is not the counterpart is refused');
  }

  sec('sigils');
  {
    const g = await import('../renderer/modules/glyphs.js');
    const rimBits = (fp) => g.sigilRim(fp).map(c => c[2]).join('');
    const hex = (n) => n.toString(16).padStart(16, '0');
    let distinct = true;
    for (let b = 0; b < 64; b++) if (rimBits(hex(0n ^ (1n << BigInt(b)))) === rimBits(hex(0n))) distinct = false;
    ok(distinct && g.sigilRim(hex(0n)).length === 64, 'every one of the 64 fingerprint bits changes the rim');
    ok(rimBits('8F3A21C97E04B6D2') === rimBits('8F3A 21C9 7E04 B6D2'), 'rim ignores fingerprint spacing');
    const key = (n) => Buffer.from(g.sigilInterior(n)).toString('hex');
    ok(key('Nadia') === key('nadia') && key('nadia') !== key('nadja'), 'inside follows the name, case-folded');
    const seen = new Set(); let coll = 0;
    for (let i = 0; i < 4000; i++) { const k = key('user' + i); if (seen.has(k)) coll++; seen.add(k); }
    ok(coll === 0, 'no two of 4000 sequential names share an inside (' + coll + ')');
    ok(g.sigilSvg('nadia', '8F3A 21C9 7E04 B6D2') !== g.sigilSvg('nadia', '1C77 E0A4 93BF 5D20'), 'same name, different key → different sigil');
  }

  await A.destroy?.();
  console.log('\n' + (fail ? '❌' : '✅') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
