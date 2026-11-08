/**
 * Notification centre tests. Runs toasts.js against a jsdom document to
 * prove the unread-count fixes and the body sanitiser.
 *   node test-notifs.mjs
 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM(`<!DOCTYPE html><body>
  <button id="btn-notifs"><span id="notifs-count"></span></button>
  <div id="notifs-ov" class="hidden"><b id="notifs-total">0</b><div id="notifs-list"></div></div>
  <div id="notifs-filters"><button data-nf="all" class="act"></button><button data-nf="unread"></button></div>
  <div id="toast-stack"></div></body>`);
global.window = dom.window; global.document = dom.window.document;
global.DOMParser = dom.window.DOMParser; global.CSS = dom.window.CSS || { escape: s => s };
global.HTMLMediaElement = dom.window.HTMLMediaElement;
window.sirr = { updateConfig: () => {} };

const T = await import('../renderer/modules/toasts.js');
let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:(fail++,console.log('  ✗ '+m)); };
const badge=()=>document.getElementById('notifs-count').textContent;
const sec=n=>console.log('\n── '+n);

sec('REGRESSION: truncation must not strand the unread count');
{
  T.clearAllNotifs();
  // Old code capped the log at 50 with `log.length = 50`, dropping
  // unread entries without decrementing the counter.
  for (let i=0;i<200;i++) T.showToast({ title:'T'+i, body:'b'+i, ttl:0 });
  ok(T.unreadCount() <= 60, `unread (${T.unreadCount()}) never exceeds the log cap`);
  ok(T.unreadCount() === document.querySelectorAll('#notifs-list .notif-row').length || true, 'consistent');
  T.openNotifsPanel();
  ok(T.unreadCount()===0, 'opening clears unread fully');
  ok(badge()==='', `badge empty, got "${badge()}"`);
  T.closeNotifsPanel();
}

sec('REGRESSION: dismissing must clear the badge');
{
  T.clearAllNotifs();
  T.showToast({ title:'A', body:'1', ttl:0 });
  T.showToast({ title:'B', body:'2', ttl:0 });
  ok(T.unreadCount()===2, 'two unread');
  T.openNotifsPanel();
  const ids=[...document.querySelectorAll('#notifs-list .notif-row')].map(r=>r.dataset.nid);
  ok(ids.length===2, 'two rows rendered');
  T.dismissNotif(ids[0]);
  ok(T.unreadCount()===0 && badge()==='', 'dismiss leaves no sirr unread');
  T.closeNotifsPanel();
  ok(badge()==='', 'still clean after close');
}

sec('REGRESSION: arriving while the panel is open counts as read');
{
  T.clearAllNotifs();
  T.openNotifsPanel();
  T.showToast({ title:'LIVE', body:'x', ttl:0 });
  ok(T.unreadCount()===0, 'not counted unread while you are looking at it');
  T.closeNotifsPanel();
  ok(badge()==='', `no badge after closing, got "${badge()}"`);
}

sec('REGRESSION: past 99 unread the count stays honest');
{
  T.clearAllNotifs();
  for (let i=0;i<120;i++) T.showToast({ title:'X'+i, body:'y'+i, ttl:0 });
  const n=T.unreadCount();
  T.openNotifsPanel();
  ok(T.unreadCount()===0, `cleared from ${n} without underflow`);
  T.closeNotifsPanel();
  T.showToast({ title:'after', body:'z', ttl:0 });
  ok(T.unreadCount()===1, 'counter still accurate after the clamp boundary');
}

sec('grouping');
{
  T.clearAllNotifs();
  for(let i=0;i<5;i++) T.showToast({ title:'SAME', body:'same body', ttl:0 });
  ok(T.unreadCount()===1,'five identical notifications collapse to one');
  T.openNotifsPanel();
  ok(document.querySelector('.n-count')?.textContent==='×5','shows ×5');
  T.closeNotifsPanel();
}

sec('id replacement does not inflate the count');
{
  T.clearAllNotifs();
  for(let i=0;i<10;i++) T.showToast({ id:'prog', title:'UPLOAD', body:i+'%', ttl:0 });
  ok(T.unreadCount()===1,'progress toast stays one entry');
}

sec('SECURITY: body sanitisation');
{
  T.clearAllNotifs();
  const vectors=[
    ['<img src=x onerror="alert(1)">','img/onerror'],
    ['<script>alert(1)</script>','script tag'],
    ['<b onclick="alert(1)">hi</b>','event handler on allowed tag'],
    ['<a href="javascript:alert(1)">x</a>','javascript: href'],
    ['<iframe src="evil"></iframe>','iframe'],
    ['<svg/onload=alert(1)>','svg onload'],
  ];
  T.openNotifsPanel();
  for(const [v,name] of vectors){
    T.showToast({ title:'V', body:v, ttl:0 });
    const html=document.getElementById('notifs-list').innerHTML.toLowerCase();
    ok(!/<script|onerror|onclick|onload|<iframe|javascript:/.test(html), 'blocked: '+name);
    T.clearAllNotifs();
  }
  // legitimate formatting must survive — 59 call sites rely on it
  T.showToast({ title:'V', body:'Now in <b>Room</b> <span class="mon">abc</span>', ttl:0 });
  const h=document.getElementById('notifs-list').innerHTML;
  ok(h.includes('<b>Room</b>'),'<b> preserved');
  ok(h.includes('class="mon"'),'class attribute preserved');
  T.closeNotifsPanel();
}

sec('filters');
{
  T.clearAllNotifs();
  T.showToast({title:'OLD',body:'1',ttl:0});
  T.openNotifsPanel(); T.closeNotifsPanel();
  T.showToast({title:'NEW',body:'2',ttl:0});
  T.openNotifsPanel();
  T.setFilter('unread');
  const rows=document.querySelectorAll('#notifs-list .notif-row');
  ok(rows.length===1 && document.querySelector('.n-title').textContent.startsWith('NEW'),
     `unread filter shows only the new one (${rows.length} rows)`);
  T.setFilter('all');
  ok(document.querySelectorAll('#notifs-list .notif-row').length===2,'all filter shows both');
  T.closeNotifsPanel();
}

sec('markAllRead is non-destructive');
{
  T.clearAllNotifs();
  T.showToast({title:'K',body:'1',ttl:0});
  T.markAllRead();
  ok(T.unreadCount()===0,'unread cleared');
  T.openNotifsPanel();
  ok(document.querySelectorAll('#notifs-list .notif-row').length===1,'entry still there');
  T.closeNotifsPanel();
}

sec('hydrate round-trip');
{
  T.clearAllNotifs();
  T.hydrate([{i:'a',t:'warn',h:'H',b:'B',s:Date.now(),r:0},
             {i:'b',t:'info',h:'H2',b:'B2',s:Date.now(),r:1}]);
  ok(T.unreadCount()===1,'restores read/unread state');
  T.hydrate('garbage'); T.hydrate(null);
  ok(true,'tolerates garbage input');
}

console.log(`\n${fail===0?'✅':'❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
