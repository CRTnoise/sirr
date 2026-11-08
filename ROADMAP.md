# Roadmap

What stands between Sirr and people who depend on it, in order. Items marked **[gate]** should be done before announcing it to at-risk users.

## 1. Before the first public push

- [ ] **[gate] Fresh repository, no history.** Push from a new repo: the old history carries the previous name and author. Commit with a pseudonymous `user.name` and a GitHub noreply `user.email`.
- [ ] **[gate] Signed releases.** Sign `SHA256SUMS.txt` with a release key (minisign or Sigstore) and publish the public key in the README. Then code-sign: Authenticode on Windows, notarization on macOS. Unsigned binaries teach users to click through warnings.
- [ ] **[gate] Real-network test.** Two to four machines on different networks — home NAT, mobile hotspot (CGNAT), a university or corporate network. Rooms, DMs, voice, files and reconnection. CI can't reach the DHT.
- [ ] **[gate] Independent review** of `docs/PROTOCOL.md` and `lib/crypto-layer.js` + `lib/network.js` by someone who didn't write them.
- [ ] Mirrors on Codeberg and Radicle from day one, so one takedown doesn't remove the source.
- [ ] Reproducible builds: pinned toolchain, documented build, a CI job that rebuilds and compares hashes.

## 2. Privacy features

| Status | Feature | Why |
| --- | --- | --- |
| **Next** | **Safety numbers** — 128-bit, shown as words and a QR to scan in person; warn when a contact's key changes | The 64-bit fingerprint is the only human check today |
| Done | App lock (passphrase-wrapped data key and identity, lock on sleep / idle) | A seized, logged-in laptop opens to a lock screen |
| Done | Duress passphrase and panic wipe (crypto-shredding, global shortcut) | Border crossings, raids |
| Done | Handshake without key-compromise impersonation (kx v3, triple DH, transcript- and channel-bound) | A stolen identity key no longer lets the thief pose as others to you |
| Done | Room rekey and eviction (`/rekey`, `/evict`) | Membership is the code; now it can change |
| Done | Padding of every session payload; opt-in cover traffic and send jitter | Sizes and timing reveal who talks to whom |
| Done | Profile only inside the session | Inbox probers and bridges learned names and statuses |
| Done | "No history on this device" rooms; per-room disappearing timer | Less to seize |
| Done | Clock-skew warning | Hourly rendezvous fails silently with a wrong clock |
| Done | Hide window from screen capture (opt-in) | Screenshot malware, accidental screen shares |
| Later | Sealed sender inside rooms; onion-routed rendezvous | IPs are still visible to members |

## 3. Staying alive — the "ethereal" list

A server-based messenger dies of known causes. Sirr avoids most of them by design; peer-to-peer has its own.

**Failures Sirr already avoids**

| Server-side failure | Why it doesn't apply |
| --- | --- |
| Subpoena or seizure of the server | There is no server holding messages, contacts or room lists |
| Database breach | There is no database; each device holds its own, encrypted |
| Company shutdown, acquisition, change of terms | Nothing to shut down; AGPL keeps every fork open |
| Account bans, phone-number requirement | No accounts; identity is a key on your device |
| Metadata logs (who, when, from where) | No central point sees the graph |

**Failures that still apply to peer-to-peer — and the fix**

| Risk | What happens | Mitigation | Status |
| --- | --- | --- | --- |
| **Bootstrap nodes blocked** | Hyperswarm's DHT is entered through three bootstrap nodes; a censor who blocks those IPs stops new sessions | Remembered DHT nodes tried first; user entry points; entry points inside invites | Done |
| **Protocol fingerprinting (DPI)** | Hyperswarm's UDP traffic can be recognised and throttled | Bridges: the whole DHT over one WebSocket, behind TLS on :443 | Done (bridges are run by volunteers) |
| **Symmetric NAT / CGNAT** | Two peers can't hole-punch | Volunteer blind relays found on a rotating topic | Done |
| **Internet shutdown** | No DHT at all | Nearby: LAN mesh with relayed, unlinkable beacons; Bluetooth LE carrier | LAN done; Bluetooth experimental (desktop needs native modules; mobile app next) |
| **Both sides offline** | Messages only move while someone is online | Members sync missed history; Echoes keep messages in DHT records refreshed by readers | Done (opt-in) |
| **DHT eclipse / Sybil** | An attacker surrounds a topic with its own nodes | Rotating topics limit the window; connect through several paths; detect unreachable known peers | Partly done |
| **Clock skew** | Rotating topics depend on the hour | ±1 epoch window; warn when peers say the clock is ≥ 30 min off | Done |
| **Distribution takedown** | GitHub, app stores, download sites removed | Mirrors; signed builds anyone can rehost; later, signed update notices gossiped peer to peer, so a new version is announced without anyone checking a server | To do |
| **Updates without a server** | Electron fixes must reach users, but an update check reveals the IP | A release note signed by the release key, passed between peers; the app shows "a signed update exists" and where to get it | To do |
| **Abuse with no moderator** | Spam, floods | Per-peer rate limits and caps exist; block lists are local; room owners can moderate for well-behaved clients | Done, extend |

## 4. Product

- Mobile: the renderer has a mobile bridge; the Android app (bare-kit) should be published from its own repository with the same protocol.
- Accessibility pass with a screen reader on the IRC layout.
- Translations (French, Arabic first — the right-to-left layout needs testing).
