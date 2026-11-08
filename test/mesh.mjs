/**
 * Mesh voice logic tests. Pure logic only — no browser APIs — so the
 * packet format, redundancy scheduler, and jitter buffer can be proven
 * on a machine with no audio hardware.
 *
 *   node test-mesh.mjs
 */
import { encodePacket, decodePacket, RedundancyScheduler, FRAME_MS, MAX_PAYLOAD, PACKET_BUDGET } from '../renderer/modules/mesh-packet.js';
import { JitterBuffer } from '../renderer/modules/mesh-jitter.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?(pass++):(fail++,console.log('  ✗ '+m)); };
const sec=n=>console.log('\n── '+n);

// ─────────────────────────────────────────── packet round-trip
sec('packet format');
{
  const a=new Uint8Array([1,2,3,4,5]), b=new Uint8Array([9,9,9]);
  const p=encodePacket(1000, 20000, [{seqDelta:0,data:a},{seqDelta:3,data:b}]);
  const d=decodePacket(p);
  ok(d!==null,'decodes');
  ok(d.seq===1000,'seq');
  ok(d.tsMs===20000,'ts');
  ok(d.frames.length===2,'frame count');
  ok(d.frames[0].seq===1000 && d.frames[1].seq===997,'absolute seqs from delta');
  ok(d.frames[1].tsMs===20000-3*FRAME_MS,'redundant ts back-dated');
  ok([...d.frames[0].data].join()==='1,2,3,4,5','primary payload intact');
  ok([...d.frames[1].data].join()==='9,9,9','redundant payload intact');
  ok(p.length===12+3+5+3+3,'exact wire size');
}
sec('packet robustness');
{
  ok(decodePacket(new Uint8Array(0))===null,'empty');
  ok(decodePacket(new Uint8Array([0,0,0]))===null,'garbage');
  const good=encodePacket(5,100,[{seqDelta:0,data:new Uint8Array([7])}]);
  ok(decodePacket(good.subarray(0,10))===null,'truncated header');
  const t=good.slice(); t[0]=0xFF;
  ok(decodePacket(t)===null,'bad magic');
  const v=good.slice(); v[1]=99;
  ok(decodePacket(v)===null,'bad version');
  const n=good.slice(); n[3]=200;
  ok(decodePacket(n)===null,'absurd frame count');
  // primary must be delta 0
  const bad=encodePacket(5,100,[{seqDelta:0,data:new Uint8Array([1])}]).slice();
  bad[12]=4;
  ok(decodePacket(bad)===null,'primary with nonzero delta rejected');
  // seq wraparound
  const w=decodePacket(encodePacket(1, 50, [{seqDelta:0,data:new Uint8Array([1])},{seqDelta:3,data:new Uint8Array([2])}]));
  ok(w.frames[1].seq===((1-3)>>>0),'wraparound seq is unsigned');
  let threw=false;
  try{ encodePacket(1,1,[{seqDelta:0,data:new Uint8Array(MAX_PAYLOAD+1)}]); }catch(e){threw=true;}
  ok(threw,'oversize payload rejected');
}

// ─────────────────────────────────────────── redundancy scheduler
sec('redundancy scheduler');
{
  const s=new RedundancyScheduler(2,3);
  let last;
  for(let i=0;i<10;i++) last=s.push(i,new Uint8Array([i]));
  ok(last.length===2,'carries a redundant copy once warm');
  ok(last[0].seqDelta===0 && last[0].data[0]===9,'primary is newest');
  ok(last[1].seqDelta===3 && last[1].data[0]===6,'copy is offset frames back');

  const cold=new RedundancyScheduler(2,3);
  ok(cold.push(0,new Uint8Array([0])).length===1,'no copy before history exists');

  const off=new RedundancyScheduler(1,3);
  for(let i=0;i<10;i++) last=off.push(i,new Uint8Array([i]));
  ok(last.length===1,'count=1 disables redundancy');

  const triple=new RedundancyScheduler(3,2);
  for(let i=0;i<10;i++) last=triple.push(i,new Uint8Array([i]));
  ok(last.length===3 && last[2].seqDelta===4,'three copies at 2-frame spacing');

  // must not exceed MTU
  const big=new RedundancyScheduler(4,2);
  for(let i=0;i<20;i++) last=big.push(i,new Uint8Array(MAX_PAYLOAD));
  ok(last.length===1,'1400-byte frames: no copy fits the budget, primary only');
  const mid=new RedundancyScheduler(4,2);
  for(let i=0;i<20;i++) last=mid.push(i,new Uint8Array(300));
  const wire=encodePacket(19,0,last).length;
  ok(wire<=PACKET_BUDGET,`packet stays under the fragmentation budget (${wire} ≤ ${PACKET_BUDGET})`);
  ok(last.length===3,'fits as many copies as the budget allows (3 × 300 B)');
  let enc=null; try{ enc=encodePacket(19,0,last); }catch(e){}
  ok(enc!==null,'scheduler output always encodable');
}

// ─────────────────────────────────────────── jitter buffer
// Realistic playout: packets arrive on their own schedule (1 ms
// resolution), and the playback clock pops exactly one slot every 20 ms,
// the way the worklet drives it in the app.
function simulate({ n=300, preset='balanced', copies=1, offset=3, lose=()=>false, delay=()=>0, dup=false }) {
  const jb=new JitterBuffer(preset);
  const sch=new RedundancyScheduler(copies,offset);
  const arrivals=[];
  for(let i=0;i<n;i++){
    const frames=sch.push(i,new Uint8Array([i&255,(i>>8)&255]));
    if(lose(i)) continue;
    const at=i*FRAME_MS+Math.max(0,delay(i));
    const pkt=decodePacket(encodePacket(i,i*FRAME_MS,frames));
    arrivals.push({at,pkt});
    if(dup) arrivals.push({at:at+1,pkt});
  }
  arrivals.sort((a,b)=>a.at-b.at);
  const played=[]; let gaps=0, stretch=0, k=0;
  const end=n*FRAME_MS+1500;
  for(let t=0;t<=end;t++){
    while(k<arrivals.length && arrivals[k].at<=t){ arrivals[k].pkt.frames.forEach((f,i)=>jb.push(f,i>0,t)); k++; }
    if(t%FRAME_MS===0){
      const r=jb.pop(t);
      if(r){ if(r.stretch) stretch++; else if(r.gap) gaps++; else played.push(r.frame.data[0]|(r.frame.data[1]<<8)); }
    }
  }
  return { jb, played, gaps, stretch, s:jb.snapshot() };
}
const inOrder=(a)=>a.every((v,i)=>i===0||v>a[i-1]);

sec('jitter buffer — clean stream');
{
  const r=simulate({});
  ok(r.played.length===300,`plays every frame (${r.played.length}/300)`);
  ok(r.gaps===0,'no concealment on a clean stream');
  ok(inOrder(r.played),'in order');
}

sec('jitter buffer — reordering within target');
{
  // every 4th packet is 35 ms late → arrives after its successor
  const r=simulate({ delay:i=>i%4===2?35:0 });
  ok(inOrder(r.played),'played strictly in sequence');
  ok(r.s.concealed<=2,`at most a couple of gaps while the target adapts (${r.s.concealed})`);
  ok(r.played.length>=298,`late-but-in-time frames still played (${r.played.length}/300)`);
}

sec('jitter buffer — redundancy actually rescues frames');
{
  const r=simulate({ copies:2, offset:3, lose:i=>i%5===0 });
  ok(r.s.recovered>40,`redundant copies rescued ${r.s.recovered} frames`);
  ok(r.s.lossPct<2,`20% packet loss → ${r.s.lossPct.toFixed(2)}% audible gaps`);
}

sec('jitter buffer — RANDOM 20% loss, 2 copies @ 3 frames');
{
  let seed=11; const rnd=()=>((seed=(seed*16807)%2147483647)/2147483647);
  const r=simulate({ n:1500, copies:2, offset:3, lose:()=>rnd()<0.2 });
  // Theoretical floor: primary AND its copy both lost = 0.2 × 0.2 = 4%.
  ok(r.s.lossPct<5,`random 20% loss → ${r.s.lossPct.toFixed(2)}% gaps (theory ≈ 4%)`);
  ok(r.s.targetMs>=80,`buffer held deep enough for the spare copies (${r.s.targetMs} ms)`);
}

sec('jitter buffer — clean stream keeps low latency');
{
  const r=simulate({ n:600, copies:2, offset:3 });
  ok(r.s.targetMs<=60,`no loss → target stays low even with redundancy on (${r.s.targetMs} ms)`);
}

sec('jitter buffer — same loss WITHOUT redundancy');
{
  const r=simulate({ lose:i=>i%5===0 });
  ok(r.s.lossPct>15,`no redundancy → ${r.s.lossPct.toFixed(1)}% audible gaps (expected ~20%)`);
}

sec('jitter buffer — burst loss beats naive RED');
{
  const lose=i=>(i%40)<3;   // 3 consecutive lost every 40
  const red=simulate({ copies:2, offset:1, lose, n:600 }).s.lossPct;
  const spaced=simulate({ copies:2, offset:4, lose, n:600 }).s.lossPct;
  ok(spaced<red/2, `offset 4 beats offset 1 on bursts (${spaced.toFixed(2)}% vs ${red.toFixed(2)}%)`);
  console.log(`     RED-equivalent (offset 1): ${red.toFixed(2)}% gaps`);
  console.log(`     spaced        (offset 4): ${spaced.toFixed(2)}% gaps`);
}

sec('jitter buffer — adapts to jitter and does not run away');
{
  let seed=7; const rnd=()=>((seed=(seed*16807)%2147483647)/2147483647);
  const r=simulate({ n:600, delay:i=>(i>100&&i<350)?rnd()*80:0 });
  ok(r.s.targetMs<=260 && r.s.targetMs>=40,`target stays in preset bounds (${r.s.targetMs} ms)`);
  ok(r.s.lossPct<5,`80 ms of random jitter → ${r.s.lossPct.toFixed(2)}% gaps`);
  ok(r.s.stretched>0,'grew the real buffer by stretching');
}

sec('jitter buffer — latency does not creep after a stall');
{
  // 300 ms network stall at frame 100, then everything arrives at once.
  const r=simulate({ n:400, delay:i=>(i>=100&&i<115)?(115-i)*FRAME_MS:0 });
  ok(r.s.trimmed>0,`burst trimmed back toward target (${r.s.trimmed} frames shed)`);
  ok(r.jb.depthMs<=r.s.targetMs+60,'depth back near target at the end');
}

sec('jitter buffer — never stalls forever on a permanent hole');
{
  const r=simulate({ n:60, lose:i=>i===30 });
  ok(r.gaps===1,'reports the hole as exactly one gap');
  ok(r.played.length===59,`still plays everything else (${r.played.length})`);
}

sec('jitter buffer — underflow re-primes and skips the hole');
{
  // 20 frames lost outright (e.g. mesh link dropped for 400 ms)
  const r=simulate({ n:200, lose:i=>i>=80&&i<100 });
  ok(r.s.underflows>=1,'underflow detected');
  ok(r.gaps<=3,`hole skipped, not concealed slot by slot (${r.gaps} gap slots)`);
  ok(r.played.length===180,'plays everything that arrived');
}

sec('jitter buffer — duplicates are free');
{
  const r=simulate({ n:50, dup:true });
  ok(r.s.duplicates===50,'every duplicate deduped');
  ok(r.played.length===50,'nothing played twice');
}

sec('jitter buffer — sender restart resyncs');
{
  const jb=new JitterBuffer('balanced');
  let t=0;
  for(let i=0;i<20;i++){ jb.push({seq:5000+i,tsMs:0,data:new Uint8Array([1])},false,t); t+=20; jb.pop(t); }
  const res=jb.push({seq:3,tsMs:0,data:new Uint8Array([1])},false,t);
  ok(res==='late','a single far-behind packet is treated as stale, not a restart');
  let last;
  for(let i=4;i<14;i++) last=jb.push({seq:i,tsMs:0,data:new Uint8Array([1])},false,t);
  ok(jb.snapshot().preset==='balanced' && jb.stats.resyncs===1,'a consistent run of them resyncs');
}

console.log(`\n${fail===0?'✅':'❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
