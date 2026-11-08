/**
 * App lock, duress passphrase and panic wipe.
 *   node test/applock.cjs
 */
const os = require('os'), fs = require('fs'), path = require('path');
const AppLock = require('../lib/applock.js');
const Vault = require('../lib/vault.js');
const Crypto = require('../lib/crypto-layer.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

// A stand-in OS keystore (reversible, tagged) so we can see the layering.
const keystore = (on = true) => ({
  isAvailable: () => on,
  encrypt: (s) => Buffer.from('KS|' + s).toString('base64'),
  decrypt: (b) => { const v = Buffer.from(b, 'base64').toString(); if (!v.startsWith('KS|')) throw new Error('ks'); return v.slice(3); },
});

(async () => {
  for (const ks of [true, false]) {
    console.log('\n── keystore ' + (ks ? 'available' : 'missing'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-'));
    let L = new AppLock(dir, keystore(ks));
    let V = new Vault(dir, L.box()).init();
    let C = new Crypto(dir, L.box()); await C.init();
    const fp = C.getFingerprint(), sealed = V.seal('room code SR-XXXX');
    ok(!L.isEnabled(), 'lock is off by default');

    L.enable('correct horse battery', 'duress words here');
    V.reseal(); C.reseal();
    ok(L.isEnabled(), 'lock on');
    const dk = fs.readFileSync(path.join(dir, 'datakey.json'), 'utf8');
    const id = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8');
    ok(!dk.includes(V.key.toString('base64')) && !id.includes(Buffer.from(C.identity.secretKey).toString('base64')), 'no key material readable in the files');

    // Relaunch: locked → nothing opens.
    L = new AppLock(dir, keystore(ks));
    let threw = false; try { new Vault(dir, L.box()).init(); } catch (e) { threw = true; }
    ok(threw, 'data key does not open before unlock');
    ok(L.unlock('wrong passphrase!') === 'bad', 'wrong passphrase refused');
    ok(L.unlock('duress words here') === 'duress', 'duress passphrase recognised');
    ok(L.unlock('correct horse battery') === 'ok', 'right passphrase unlocks');
    V = new Vault(dir, L.box()).init();
    C = new Crypto(dir, L.box()); await C.init();
    ok(V.open(sealed) === 'room code SR-XXXX', 'data opens after unlock');
    ok(C.getFingerprint() === fp, 'same identity after unlock');

    // Change passphrase, then turn the lock off.
    L.enable('a new passphrase', ''); V.reseal(); C.reseal();
    L = new AppLock(dir, keystore(ks));
    ok(L.unlock('correct horse battery') === 'bad' && L.unlock('a new passphrase') === 'ok', 'passphrase change takes effect');
    V = new Vault(dir, L.box()).init(); C = new Crypto(dir, L.box()); await C.init();
    L.disableBegin(); V.reseal(); C.reseal(); L.disableCommit();
    L = new AppLock(dir, keystore(ks));
    ok(!L.isEnabled(), 'lock off');
    V = new Vault(dir, L.box()).init(); C = new Crypto(dir, L.box()); await C.init();
    ok(V.open(sealed) === 'room code SR-XXXX' && C.getFingerprint() === fp, 'data and identity open without a passphrase again');

    // Panic wipe.
    L.wipe();
    ok(!fs.existsSync(path.join(dir, 'datakey.json')) && !fs.existsSync(path.join(dir, 'identity.json')), 'keys shredded');
    ok(!fs.existsSync(dir), 'data directory removed');
  }
  let short = false; try { new AppLock(os.tmpdir(), null).enable('short'); } catch (e) { short = true; }
  ok(short, 'short passphrases refused');
  console.log('\n' + (fail ? '❌' : '✅') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
