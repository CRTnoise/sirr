import asyncio, json, sys, random
from playwright.async_api import async_playwright

import os
# Any Chromium ≥ 120 works. Unset → Playwright's bundled Chromium.
CHROME = os.environ.get('SIRR_CHROME') or None
BASE = os.environ.get('SIRR_HARNESS_URL', 'http://localhost:8123/test/voice-harness/harness.html')
ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required', '--no-sandbox',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows']

async def open_peer(ctx, v_default, pid, **opts):
    v = opts.pop('v', v_default)
    pg = await ctx.new_page()
    q = '&'.join(f'{k}={v2}' for k, v2 in opts.items())
    await pg.goto(f'{BASE}?v={v}&id={pid}&{q}')
    await pg.wait_for_function('window.ready === true', timeout=15000)
    return pg

async def report(pages, label, ms=2500, mute_ok=()):
    res = await asyncio.gather(*[pg.evaluate(f'window.measure({ms})') for pg in pages.values()])
    ok = True
    lines = []
    for (pid, pg), r in zip(pages.items(), res):
        for other in pages:
            if other == pid: continue
            x = r.get(other)
            if not x:
                lines.append(f'  {pid} <- {other}: NO PC'); ok = False; continue
            h = x['hears']
            if other in mute_ok:
                lines.append(f"  {pid} <- {other}: (sender has no mic) pc={x['pc']} elMuted={x['elMuted']} mesh={x['meshOn']}"); continue
            ok = ok and h
            lines.append(f"  {pid} <- {other}: {'HEARS ' if h else 'SILENT'} link={x.get('link')} pc={x['pc']} ss={x['ss']} rtcE={x['rtcEnergyDelta']} elMuted={x['elMuted']} mesh={x['meshOn']}/{x['meshFlow']} played={x['meshPlayed']} txWebRTC={x['webrtcSending']}")
    print(f'[{label}] {"PASS" if ok else "FAIL"}')
    for l in lines: print(l)
    return ok

async def dump_logs(pages, filt=None, n=30):
    for pid, pg in pages.items():
        logs = await pg.evaluate('window.__log')
        if filt: logs = [l for l in logs if any(f in l for f in filt)]
        print(f'--- {pid} log ({len(logs)}) ---')
        for l in logs[-n:]: print('   ', l[:220])

async def scenario(name, v, peers, join_delays, settle=6, opts=None, logs=False, extra=None):
    opts = opts or {}
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=ARGS)
        ctx = await b.new_context()
        pages = {}
        for pid in peers:
            pages[pid] = await open_peer(ctx, v, pid, **dict(opts.get(pid, {})))
        async def j(pid, d):
            await asyncio.sleep(d)
            await pages[pid].evaluate('window.join()')
        await asyncio.gather(*[j(pid, d) for pid, d in zip(peers, join_delays)])
        await asyncio.sleep(settle)
        ok = await report(pages, f'{name} [{v}]', mute_ok=[p for p in peers if opts.get(p, {}).get('nomic') == '1'])
        if extra:
            ok = (await extra(pages, lambda lbl: report(pages, lbl, mute_ok=[p for p in peers if opts.get(p, {}).get('nomic') == '1']))) and ok
        if logs or not ok:
            await dump_logs(pages, filt=['[voice]', '[mesh]', 'W '], n=25)
        await b.close()
        return ok

if __name__ == '__main__':
    v = sys.argv[1] if len(sys.argv) > 1 else '.'
    which = sys.argv[2] if len(sys.argv) > 2 else 'all'
    async def main():
        results = {}
        if which in ('all', 'glare'):
            # simultaneous join — classic glare
            results['glare2'] = await scenario('2 peers simultaneous', v, ['aaa', 'bbb'], [0, 0.05])
        if which in ('all', 'three'):
            results['three'] = await scenario('3 peers near-simultaneous', v, ['aaa', 'bbb', 'ccc'], [0, 0.1, 0.2], settle=8)
        if which in ('all', 'seq'):
            results['seq'] = await scenario('2 peers sequential', v, ['aaa', 'bbb'], [0, 2])
        if which in ('all', 'mesh'):
            results['mesh'] = await scenario('mesh both on', v, ['aaa', 'bbb'], [0, 1.5], settle=7,
                                             opts={'aaa': {'mesh': 'on'}, 'bbb': {'mesh': 'on'}})
        if which in ('all', 'meshfail'):
            results['meshfail'] = await scenario('mesh on, one encoder broken', v, ['aaa', 'bbb'], [0, 1.5], settle=7,
                                                 opts={'aaa': {'mesh': 'on', 'failenc': '1'}, 'bbb': {'mesh': 'on'}})
        if which in ('all', 'nomic'):
            results['nomic'] = await scenario('listen-only initiator', v, ['aaa', 'bbb'], [0, 1.5], settle=7,
                                              opts={'aaa': {'nomic': '1'}})
        if which in ('all', 'meshnomic'):
            results['meshnomic'] = await scenario('mesh on, one listen-only', v, ['aaa', 'bbb'], [0, 1.5], settle=7,
                                              opts={'aaa': {'nomic': '1', 'mesh': 'on'}, 'bbb': {'mesh': 'on'}})
        if which in ('all', 'gate'):
            results['gate'] = await scenario('noise gate low', v, ['aaa', 'bbb'], [0, 1.5], settle=10,
                                             opts={'aaa': {'gate': 'low', 'noaec': '1'}})
        L = {'lat': '120', 'jit': '80'}
        if which in ('all', 'glarelat'):
            results['glarelat'] = await scenario('glare w/ latency', v, ['aaa', 'bbb'], [0, 0], settle=9, opts={'aaa': dict(L), 'bbb': dict(L)})
        if which in ('all', 'four'):
            results['four'] = await scenario('4 peers simultaneous w/ latency', v, ['aaa','bbb','ccc','ddd'], [0,0,0,0], settle=12, opts={p: dict(L) for p in ['aaa','bbb','ccc','ddd']})
        if which in ('all', 'swarmfb'):
            results['swarmfb'] = await scenario('ICE impossible → swarm fallback', v, ['aaa', 'bbb'], [0, 1], settle=12,
                                                opts={'aaa': {'blockrtc': '1'}, 'bbb': {'blockrtc': '1'}})
        if which in ('all', 'swarmroute'):
            results['swarmroute'] = await scenario('swarm-only route both', v, ['aaa', 'bbb', 'ccc'], [0, 0.5, 1], settle=8,
                                                opts={p: {'route': 'swarm'} for p in ['aaa','bbb','ccc']})
        if which in ('all', 'swarmmixed'):
            results['swarmmixed'] = await scenario('one swarm-only, one auto', v, ['aaa', 'bbb'], [0, 1], settle=8,
                                                opts={'aaa': {'route': 'swarm'}})
        if which in ('all', 'swarmlat'):
            results['swarmlat'] = await scenario('swarm route + 120ms latency/jitter', v, ['aaa', 'bbb'], [0, 1], settle=9,
                                                opts={'aaa': {'route': 'swarm', **L}, 'bbb': {'route': 'swarm', **L}})
        if which in ('all', 'meshloss'):
            results['meshloss'] = await scenario('mesh + 20% datagram loss', v, ['aaa', 'bbb'], [0, 1], settle=8,
                                                opts={'aaa': {'mesh': 'on', 'drop': '0.2'}, 'bbb': {'mesh': 'on', 'drop': '0.2'}})
        if which in ('all', 'blip'):
            async def blip(pages, rep):
                ok1 = await rep('blip: before')
                # simultaneous network drop + reconnect on both sides
                await asyncio.gather(*[pg.evaluate("(() => { const o = '%s'; window.__voice.handlePeerLeft(o); })()" % ('bbb' if pid == 'aaa' else 'aaa')) for pid, pg in pages.items()])
                await asyncio.sleep(0.3)
                await asyncio.gather(*[pg.evaluate("(() => { const o = '%s'; window.__voice.handleNewPeer({peerId:o}, ['R']); })()" % ('bbb' if pid == 'aaa' else 'aaa')) for pid, pg in pages.items()])
                await asyncio.sleep(9)
                return (await rep('blip: after simultaneous reconnect')) and ok1
            results['blip'] = await scenario('network blip', v, ['aaa', 'bbb'], [0, 1], settle=6, opts={'aaa': dict(L), 'bbb': dict(L)}, extra=blip)
        if which in ('all', 'rejoin'):
            async def rejoin(pages, rep):
                await pages['bbb'].evaluate('window.leave()')
                await asyncio.sleep(0.5)
                await pages['bbb'].evaluate('window.join()')
                await asyncio.sleep(8)
                return await rep('after bbb leave+rejoin')
            results['rejoin'] = await scenario('leave & rejoin', v, ['aaa', 'bbb', 'ccc'], [0, 0.5, 1], settle=7, opts={p: dict(L) for p in ['aaa','bbb','ccc']}, extra=rejoin)
        if which in ('all', 'devswitch'):
            async def devswitch(pages, rep):
                r = await pages['aaa'].evaluate("window.__voice.switchInputDevice('default').then(r => JSON.stringify(r))")
                print('   switch result', r)
                await asyncio.sleep(3)
                return await rep('after mic switch mid-call (mesh on)')
            results['devswitch'] = await scenario('device switch with mesh', v, ['aaa', 'bbb'], [0, 1], settle=7,
                                                  opts={'aaa': {'mesh': 'on'}, 'bbb': {'mesh': 'on'}}, extra=devswitch)
        print('\nSUMMARY', v, json.dumps(results))
    asyncio.run(main())
