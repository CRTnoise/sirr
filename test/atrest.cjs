/**
 * At-rest encryption tests: a plaintext data dir from before the vault is
 * upgraded in place; afterwards no room code, message, nickname, license
 * key, image or file name is readable on disk; the app still reads it all;
 * a locked keystore fails closed; encrypted file records are tamper-proof.
 *
 *   node test-atrest.cjs
 */
const os=require('os'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const Storage=require('../lib/storage.js');
const Vault=require('../lib/vault.js');
const OldStorage=Storage;   // no vault = the plaintext on-disk format
let pass=0,fail=0; const ok=(c,m)=>{ if(c)pass++; else {fail++; console.log('  ✗ '+m);} };
function grepDir(dir, needles){ const hits=[]; const walk=d=>{ for(const f of fs.readdirSync(d)){ const p=path.join(d,f); for(const n of needles) if(f.includes(n)) hits.push('FILENAME '+path.relative(dir,p)); if(fs.statSync(p).isDirectory()) walk(p); else { const b=fs.readFileSync(p); for(const n of needles) if(b.includes(Buffer.from(n))) hits.push(path.relative(dir,p)+' ⊃ '+n); } } }; walk(dir); return hits; }
const fakeBox={ isAvailable:()=>true, encrypt:s=>Buffer.from('K:'+s).toString('base64'), decrypt:b=>Buffer.from(b,'base64').toString().slice(2) };
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vt-'));
  const SECRET_ROOM='SR-SECRETROOM-ABCD-EF', MSG='the launch code is 0451', NICK='GhostWriter';
  // 1) an install without a vault writes plaintext data
  const old=new OldStorage(dir);
  old.addRoom(SECRET_ROOM,'Top Secret');
  old.updateConfig({nickname:NICK, licenseKey:'SIRR-LIC.v1.SECRETLIC'});
  for(let i=0;i<50;i++) old.appendMessage(SECRET_ROOM,'default',{msgId:'m'+i,nickname:NICK,content:MSG+' #'+i,type:'text',timestamp:1000+i,fingerprint:'FP1'});
  old.appendMessage(SECRET_ROOM,'default',{msgId:'img',nickname:NICK,type:'image',timestamp:5000,content:'data:image/png;base64,'+Buffer.alloc(3000,7).toString('base64')+'SECRETIMG'});
  old.flushSync && old.flushSync(); old.messages.close();
  fs.mkdirSync(path.join(dir,'history'),{recursive:true}); fs.writeFileSync(path.join(dir,'history','x.ndjson.migrated'), MSG);
  ok(grepDir(dir,[MSG]).length>0, 'precondition: the vault-less format leaves plaintext on disk ('+grepDir(dir,[MSG,SECRET_ROOM]).length+' hits)');
  // 2) the next boot has a vault
  const v=new Vault(dir,fakeBox).init();
  const st=new Storage(dir,{vault:v});
  const r=st.sealAtRest(); st.flushSync && st.flushSync();
  ok(st.messages.migratedRows===51, 'migrated 51 rows to encrypted form ('+st.messages.migratedRows+')');
  ok(st.getHistory(SECRET_ROOM,'default').length===51, 'history still readable through the app');
  ok(st.getHistory(SECRET_ROOM,'default').some(m=>m.type==='image' && m.content.endsWith('SECRETIMG')), 'spilled image still loads');
  ok(st.getConfig().nickname===NICK && st.getRooms().some(x=>x.code===SECRET_ROOM), 'config round-trips');
  st.messages.close();
  const hits=grepDir(dir,[MSG, SECRET_ROOM, NICK, 'SECRETLIC', 'SECRETIMG']);
  ok(hits.length===0, 'no room code, message, nickname, license or image left in plaintext anywhere on disk' + (hits.length? ' — '+hits.join(', '):''));
  ok(!fs.existsSync(path.join(dir,'history','x.ndjson.migrated')), 'old .ndjson.migrated copy shredded');
  // 3) restart
  const v2=new Vault(dir,fakeBox).init(); const st2=new Storage(dir,{vault:v2});
  ok(st2.getHistory(SECRET_ROOM,'default').length===51, 'survives restart');
  st2.messages.deleteMessage(SECRET_ROOM,'default','m3'); st2.messages.scrub();
  ok(!st2.messages.hasMessage(SECRET_ROOM,'default','m3'), 'delete works');
  const s=st2.messages.sweepExpired(Date.now()); ok(Array.isArray(s),'sweep ok');
  st2.messages.appendMessage(SECRET_ROOM,'default',{msgId:'e1',content:'edit me',type:'text',timestamp:9,fingerprint:'FP'});
  st2.messages.updateMessageContent(SECRET_ROOM,'default','e1','edited!'); st2.messages.mergeMeta(SECRET_ROOM,'default','e1',{editSig:'ES',editedAt:77});
  const e=st2.messages.getMessage(SECRET_ROOM,'default','e1'); ok(e.content==='edited!' && e.editSig==='ES' && e.editedAt===77,'edit + meta inside sealed body');
  const ids=st2.messages.getRoomMessageIds(SECRET_ROOM,10); ok(ids.length===10 && ids.every(x=>x.channel==='default'),'sync summary returns real channels');
  const ex=st2.messages.exportMessages(); ok(ex.length>0 && ex.every(x=>x.room===SECRET_ROOM),'export returns real room codes');
  st2.messages.close();
  // 4) locked keystore must fail closed
  let threw=false; try{ new Vault(dir,{isAvailable:()=>false}).init(); }catch(err){ threw=true; }
  ok(threw,'sealed data key + unavailable keystore → refuses (no silent reset)');
  // 5) encrypted file records
  const fp=path.join(dir,'f.bin'); const fh=await fs.promises.open(fp,'w'); const w=v2.fileWriter(fh);
  const parts=[crypto.randomBytes(61440),Buffer.from('PLAINTEXT-MARKER'),crypto.randomBytes(100)]; for(const p of parts) await w.append(p); await fh.close();
  ok(!fs.readFileSync(fp).includes(Buffer.from('PLAINTEXT-MARKER')),'file records are ciphertext on disk');
  ok(Buffer.compare(await v2.readFile(fp),Buffer.concat(parts))===0,'file decrypts exactly');
  const raw=fs.readFileSync(fp); raw[raw.length-20]^=1; fs.writeFileSync(fp,raw);
  let bad=false; try{ await v2.readFile(fp);}catch(err){bad=true;} ok(bad,'tampered file rejected');
  global.__vaultDone={pass,fail};
})().catch(e=>{console.error(e);process.exit(1)});
;(async()=>{ await new Promise(r=>setTimeout(r,200));
  const os=require('os'),fs=require('fs'),path=require('path');
  const Storage=require('../lib/storage.js'), Vault=require('../lib/vault.js');
  const box={isAvailable:()=>true,encrypt:s=>Buffer.from('K:'+s).toString('base64'),decrypt:b=>Buffer.from(b,'base64').toString().slice(2)};
  for (const withVault of [true,false]) {
    const d=fs.mkdtempSync(path.join(os.tmpdir(),'vc-'));
    const st=new Storage(d, withVault?{vault:new Vault(d,box).init()}:{});
    st.addRoom('SR-R1'); st.addRoom('SR-R2');
    const img='data:image/png;base64,'+Buffer.alloc(3000,1).toString('base64');
    st.appendMessage('SR-R1','a',{msgId:'1',type:'image',content:img,timestamp:1});
    st.appendMessage('SR-R1','b',{msgId:'2',type:'image',content:img,timestamp:2});
    st.appendMessage('SR-R2','a',{msgId:'3',type:'image',content:img,timestamp:3});
    const n=()=>fs.readdirSync(path.join(d,'files')).length;
    const a=n(); st._removeFilesForChannel('SR-R1','a'); const b=n(); st._removeFilesForRoom('SR-R1'); const c=n();
    const ok2=(a===3&&b===2&&c===1); if(!ok2){ global.__vaultDone.fail++; console.log('  ✗ '+(withVault?'vault':'plain')+' file cleanup', a,b,c);} else global.__vaultDone.pass++;
    st.messages.close();
  }
  const {pass,fail}=global.__vaultDone;
  console.log(`\nat-rest: ${fail?'❌':'✅'}  ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode=1;
})();

// ── owner-committed room codes — appended suite ─────────────────
;(async()=>{ await new Promise(r=>setTimeout(r,400));
  const os=require('os'),fs=require('fs'),path=require('path'),crypto=require('crypto');
  const S=require('../lib/storage.js'), R=require('../lib/roomcode.js');
  let p=0,f=0; const ok=(c,m)=>{ if(c)p++; else {f++; console.log('  ✗ '+m);} };
  const st=new S(fs.mkdtempSync(path.join(os.tmpdir(),'po-')));
  const own=crypto.randomBytes(32).toString('hex'), att=crypto.randomBytes(32).toString('hex');
  const code=R.generateOwned(own); st.addRoom(code);
  ok(R.validate(code).ok && R.ownerMatches(code,own) && !R.ownerMatches(code,att), 'owner-committed code validates and commits to its creator');
  ok(!st.hasPerm(code,'ATT','deleteChannel',att) && st.hasPerm(code,'OWN','deleteChannel',own), 'before any charter: only the committed owner has perms');
  ok(st.acceptRoomCharter(code,'ATT',1,'ME',att)==='conflict', 'attacker speaking first is refused');
  ok(st.acceptRoomCharter(code,'OWN',9,'ME',own)===true && st.getRoomOwner(code).fingerprint==='OWN', 'real owner recognised when they arrive');
  ok(!st.canModerate(code,'ATT',att), 'attacker cannot moderate');
  // local (on-device) checks pass no identity — they must use our own
  st.setSelfIdentity('OWN', own);
  ok(st.hasPerm(code,'OWN','createChannel') && st.canModerate(code,'OWN'), 'owner acting locally keeps perms in an owner-committed room');
  const st2=new S(fs.mkdtempSync(path.join(os.tmpdir(),'po2-'))); const c2=R.generateOwned(own); st2.addRoom(c2); st2.setSelfIdentity('ME', att);
  ok(!st2.hasPerm(c2,'ME','createChannel'), 'non-owner acting locally has no perms before the charter arrives'); st2.messages.close();
  st.messages.close();
  console.log(`ownership: ${f?'❌':'✅'}  ${p} passed, ${f} failed`);
  if (f) process.exitCode=1;
})();
