# Security

## Reporting a vulnerability

Please report privately through GitHub's **"Report a vulnerability"** button on this repository (Security → Advisories). Don't open a public issue for anything that could put users at risk.

Include what you found, how to reproduce it, and what an attacker could do with it. Expect an acknowledgement within a week. Fixes for issues that endanger users ship as soon as they are ready, and are credited unless you ask otherwise.

## Threat model

Sirr is built for people whose conversations someone powerful would like to read or stop. It assumes the **network is hostile** (it may be watched, filtered or recorded in full) and that **no third party can be trusted** with message content, metadata about who talks to whom, or the power to switch the service off.

### In scope

| Adversary | Protection |
| --- | --- |
| Network observer (ISP, state) | Noise-encrypted links + end-to-end encryption of every frame after the handshake, under ratcheted, forward-secret session keys. |
| DHT observer / crawler | Rotating, keyed rendezvous topics; 109-bit room secrets make offline guessing infeasible. |
| Malicious room member | Learns nothing about your other rooms; can't forge messages from other members or claim ownership; can't rename rooms, manage channels or grant rights without permission; bounded in every buffer, rate and size. |
| A peer claiming someone's identity | Can't complete the handshake without that identity's secret key. |
| Lost or seized device, powered off | Data encrypted at rest under a key sealed by the OS keychain. |
| Seized device, logged in or with a shared OS account | Optional app lock: the data key and identity are also sealed under a passphrase (scrypt); nothing opens, and no window, IPC or network exists, before it is typed. |
| Coercion to unlock | Optional duress passphrase on the lock screen silently crypto-shreds everything and opens a fresh install. Panic wipe from Settings or a global shortcut. |
| Future theft of your identity key | Past sessions stay private (forward secrecy), and the thief can't impersonate other people to you (the handshake has no key-compromise impersonation). |
| Keys copied out of a running app | Message keys come from a hash ratchet and are wiped after use, so copied keys open nothing already sent. An in-session DH rekey every 10 minutes locks a passive copier out again. |
| Traffic analysis on your connection | Every session payload padded to a size bucket; opt-in cover traffic and send jitter. |
| A bridge, or anyone holding the transport key | Every frame after the handshake (chat, voice, pins, room and channel names, typing, admin, membership) is sealed end to end; frames in the clear are dropped, and replayed, reordered or altered records end the session. |
| Someone probing your inbox | Nickname, avatar and status are sent only inside the authenticated session. |
| A member who must be removed | The owner moves the room to a new code (`/evict`, `/rekey`); the evicted member never receives it and can't forge a move. |
| Blocked bootstrap nodes, DPI on peer-to-peer UDP, NAT | Remembered and user-supplied entry points, entry points in invites, volunteer blind relays, WebSocket bridges. |
| Internet shutdown | Nearby: LAN (and, experimentally, Bluetooth LE) mesh with relayed, unlinkable beacons. |
| Malicious link in a message | Opened in a sandboxed window with its own session and no bridge; link previews never fetch links posted by others. |

### Out of scope / known limitations

- **IP addresses.** Connections are direct; members see each other's IPs. There is no onion routing. Relays are for reachability, not anonymity: HyperDHT still exchanges addresses while it tries to upgrade a relayed link to a direct one. A bridge sees your IP and when you're online. Use a VPN or a trusted network if your IP itself is sensitive. With the opt-in personal inbox, anyone who knows your fingerprint can find your IP while you are online.
- **Echoes (opt-in) are not forward-secret.** They are sealed under a key derived from the room code (or a DM's pairwise secret). Someone who records DHT traffic and later obtains the room code can read the echoes of that window — up to 48 h after the last member read them.
- **Bridges hold the throwaway transport key.** The relay protocol needs the per-launch swarm key on the bridge, so the Noise transport ends there. Since 1.2.0 every frame after the handshake is sealed end to end inside it, so a bridge can drop or delay traffic, not read or forge it. It does see the handshake — your identity public key (so it can tell the same person is back), connection-bound room tags — plus file-transfer frame headers and the size and timing of records. *1.1.0 and earlier sent voice, pins, room and channel names, typing, admin and membership updates in the clear inside the transport; through a bridge those were readable and forgeable (GHSA-mmqx-xg3q-gxpf).*
- **Nearby is visible on the local network.** Someone on the same Wi-Fi can tell a Sirr device is present (not who, nor which rooms). The Bluetooth carrier is experimental and needs native modules that aren't bundled.
- **First contact in DMs.** A DM gets its own rendezvous only once the two identities have met (in a shared room, or through the opt-in inbox); before that it travels over connections you already have.
- **Membership is the code.** Anyone holding a room code can join. Removal works by moving everyone else (`/evict`); the old code stays usable by whoever holds it, as an empty room. Moderation (deleting messages, admin rights) only binds well-behaved clients. A move is only accepted from the owner or signed with the owner's room key, so until a member has met the owner once, a forwarded move waits for the owner.
- **Endpoints.** A member can screenshot or copy anything they receive, including disappearing messages. Malware on your device sees what you see.
- **Fingerprint length.** The fingerprint people compare is 64 bits. Authorization uses the full 256-bit identity, but a human comparison can be defeated by an adversary able to grind ~2^64 keys. A longer safety number is on the roadmap.
- **Metadata to members.** Nickname, status, avatar, online/away and typing state are visible to people you share a room with.
- **The app lock has no recovery.** Forget the passphrase and the data is gone. The lock protects data at rest; while Sirr is unlocked, keys are in memory (locking restarts the app to drop them). Flash storage may keep old copies of the key files after a wipe; with the lock on, those copies are still sealed under the passphrase.
- **No fallback identity on disk.** If the saved identity can't be unlocked (OS keyring locked or missing), Sirr runs on a temporary identity held in memory only and shows a permanent banner: contacts will see a different fingerprint. The saved identity is never overwritten.
- **Unsigned builds.** Release binaries are not yet code-signed; verify checksums, or build from source.
- **Electron.** The UI runs in Chromium. Keep Sirr updated: browser-engine fixes arrive through Electron releases.

## Hardening in the code

- Renderer: `sandbox`, `contextIsolation`, no Node, strict CSP (no remote scripts, styles, fonts or images), every IPC call checked to come from the app window's top frame, the app window can't navigate, no `<webview>`.
- Electron fuses: no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no inspector flags, ASAR integrity, app loaded only from the ASAR.
- Permissions: only capture and notifications, only for the app window. Notifications never show sender, room or text.
- No outbound requests besides the swarm, STUN during calls, and opt-in link previews (SSRF-guarded against private, loopback, link-local, CGNAT and metadata addresses, with DNS pinned per hop).
