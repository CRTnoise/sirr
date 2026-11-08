/**
 * Message-store parity: the pure-JS lite store (Sirr Mobile)
 * must behave exactly like the SQLite store (desktop) and keep the same
 * at-rest guarantees. Under Bare only the lite store runs.
 *
 *   node test-storeparity.cjs
 */
const os = require('os'), fs = require('fs'), path = require('path');
const Vault = require('../lib/vault.js');
const Lite = require('../lib/message-store-lite.js');
let Sql = null; try { if (!global.__BARE__) Sql = require('../lib/message-store.js'); } catch (e) {}
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

function run(Store, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const v = new Vault(dir).init();
  const st = new Store(path.join(dir, 'messages.db'), v);
  const R = 'SR-PARITY-SECRET-ROOM', out = {};
  for (let i = 0; i < 30; i++) st.appendMessage(R, i % 3 ? 'default' : 'dev', { msgId: 'm' + i, nickname: 'NyxPlaintextMarker', content: 'secret words ' + i, type: 'text', timestamp: 1000 + i, fingerprint: 'FP', expiresAt: i === 5 ? 1 : 0, sig: 'S' + i });
  out.dup = st.appendMessage(R, 'default', { msgId: 'm1', content: 'dup', timestamp: 5 });
  out.hist = st.getHistory(R, 'default', 5).map(m => m.msgId + ':' + m.content);
  out.has = [st.hasMessage(R, 'default', 'm1'), st.hasMessage(R, 'dev', 'm1'), st.hasMessage(R, 'default', 'zz')];
  st.updateMessageContent(R, 'default', 'm1', 'edited'); st.mergeMeta(R, 'default', 'm1', { editSig: 'E', editedAt: 9 });
  const e = st.getMessage(R, 'default', 'm1'); out.edit = [e.content, e.editSig, e.editedAt, e.sig];
  out.del = (st.deleteMessage(R, 'default', 'm2') || {}).msgId;
  out.ids = st.getRoomMessageIds(R, 6).map(x => x.msgId + '@' + x.channel);
  out.byIds = st.getMessagesByIds(R, ['m3', 'm4', 'nope']).map(m => m.msgId).sort();
  out.swept = st.sweepExpired(100).map(x => x.msgId + '@' + x.channel + '@' + x.room);
  st.clearChannel(R, 'dev');
  out.count = st.count();
  out.exp = st.exportMessages().length;
  st.close();
  // reopen: persistence
  const st2 = new Store(path.join(dir, 'messages.db'), new Vault(dir).init());
  out.reopen = st2.getHistory(R, 'default', 3).map(m => m.msgId);
  st2.close();
  const leaks = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else { const b = fs.readFileSync(p); for (const n of ['SR-PARITY-SECRET-ROOM', 'secret words', 'NyxPlaintextMarker']) if (b.includes(Buffer.from(n)) || f.includes(n)) leaks.push(f + '⊃' + n); } } };
  walk(dir);
  ok(leaks.length === 0, label + ': nothing readable on disk' + (leaks.length ? ' — ' + leaks.join(', ') : ''));
  return out;
}

const lite = run(Lite, 'lite');
ok(lite.dup === false && lite.has.join() === 'true,false,false', 'lite: dedupe + channel scoping');
ok(lite.edit.join() === 'edited,E,9,S1', 'lite: edit + meta preserved');
ok(lite.swept.join() === 'm5@default@SR-PARITY-SECRET-ROOM', 'lite: expiry sweep reports real room/channel');
ok(lite.reopen.length === 3, 'lite: persists across reopen');
if (Sql) {
  const sql = run(Sql, 'sqlite');
  for (const k of Object.keys(sql)) ok(JSON.stringify(sql[k]) === JSON.stringify(lite[k]), 'parity: ' + k + ' — sqlite ' + JSON.stringify(sql[k]) + ' vs lite ' + JSON.stringify(lite[k]));
}
console.log(`\n${fail ? '❌' : '✅'}  ${pass} passed, ${fail} failed${Sql ? '' : '  (lite store only)'}`);
if (fail) process.exitCode = 1;
