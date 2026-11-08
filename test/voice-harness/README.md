# Voice harness

Runs the real `renderer/modules/voice.js` in 2–4 headless Chromium tabs.
Signaling and swarm media go over a `BroadcastChannel` stub of
`window.sirr`, with optional latency/jitter, so real glare, ICE, mesh
and swarm-link behaviour can be reproduced deterministically.

```bash
pip install playwright && python -m playwright install chromium
# from the repo root:
python3 -m http.server 8123 &
python3 test/voice-harness/drive.py . all          # or one scenario:
python3 test/voice-harness/drive.py . four         # glare, three, seq, mesh, meshfail,
                                                     # nomic, meshnomic, gate, glarelat, four,
                                                     # swarmfb, swarmroute, swarmmixed, swarmlat,
                                                     # meshloss, blip, rejoin, devswitch
```

Each report line is what one tab actually **hears** from another:
WebRTC energy rising on an unmuted element, or mesh audio being decoded
and played. `link=dc|swarm` shows which mesh link carried it.

URL parameters understood by `harness.html`: `id`, `mesh=on`,
`route=swarm`, `blockrtc=1` (strip all ICE — WebRTC can never connect),
`lat`/`jit` (signaling delay ms), `drop` (mesh packet loss 0–1),
`failenc=1`, `nomic=1`, `gate=low`, `noaec=1`, `red=off`.
