# Changelog

## 1.1.0

### Real time
- Name, status, avatar and drawn sigil changes reach everyone as you type (after a short pause), and every line already on screen follows: `-!- ana is now known as nadia`.

### Identity
- Draw your own sigil: a pixel grid of 8, 12, 16, 24 or 32 cells, mirror and eraser tools, start from your name, change the size any time (the drawing is resampled). The rim stays your fingerprint, so a copied drawing still shows a different seal.

### Privacy
- Handshake kx v3: triple DH bound to the transcript and the socket. Forward secrecy as before, and no more key-compromise impersonation.
- Nickname, avatar and status only travel inside the authenticated session.
- Every encrypted payload padded to a size bucket. Opt-in cover traffic and send jitter.
- App lock: passphrase over the OS keychain, lock on sleep or after idle, back-off on wrong guesses. Nothing — no window, IPC or network — exists before it's typed.
- Duress passphrase and panic wipe (Settings → Security, or a global shortcut): keys shredded first, then everything else.
- Room moves: `/rekey` and `/evict <nick>` move everyone else to a fresh code, owner-signed; members who come back later get the move from whoever's online.
- "No history on this device" per room.
- Clock-skew warning.

### Getting through
- Entry points: remembered DHT nodes, your own list, and entry points carried in invite links — the three default bootstrap nodes are no longer a single point of failure.
- Volunteer blind relays, found on a daily topic, for people behind strict NAT. Opt in to relay for others.
- Bridges: the whole DHT over one WebSocket that looks like HTTPS. `bin/sirr-bridge.js` to run one; "Run a bridge" in the app.
- Nearby: find room members on the same LAN with no internet, through a mesh whose beacons every Sirr device relays a few hops further. Experimental Bluetooth LE carrier.

### Offline delivery
- Echoes (opt-in): messages for someone offline wait in sealed, same-size DHT records under keys only room members can derive, renewed each time a member reads them.

## 1.0.0

First public release.

### Security and privacy
- Room codes carry ≈109 bits of secret (`SR-` + 40 characters) plus a commitment to their creator.
- Rendezvous only on rotating, keyed DHT topics; the static per-room topic is gone.
- Forward-secret handshake is mandatory; no static-key fallback can be negotiated.
- Nothing but the handshake is processed before a peer authenticates; peers reach the UI and rosters only after `KEY_CONFIRM`.
- DMs rendezvous on a pairwise secret only the two parties can compute, not on a value derived from their public fingerprints.
- Personal inbox (reachable by fingerprint) is opt-in and off by default.
- Backups are always sealed with a passphrase (scrypt + XSalsa20-Poly1305).
- Invite links keep the code in the URL fragment; a gateway host never sees it.
- Link previews only for links you send, with a generic User-Agent and a stricter SSRF guard.
- No spell-check dictionary downloads; zero outbound HTTP at launch.
- OS notifications never show sender, room or text.
- Pinned-message previews come from the stored message when it exists.
- Electron 44 with fuses, global sandbox, no navigation of the app window, permissions limited to the app window.

### Interface
- IRC layout by default: one line per message, time and `<nick>` in columns, `-!-` system lines. Cards layout one setting away.
- Discord-scale density (the whole UI at 87.5 %), a dimmer palette for long sessions, quiet add-channel rows.
- IRC commands: `/nick`, `/join`, `/who`, `/whois`, `/away`, `/back`, `/topic`, plus `/me`, `/shrug`, `/clear`, `/help`.
- Voice meters measure RMS in dBFS with meter ballistics; the old spectrum average barely moved for speech, so the bar looked dead. A suspended audio context is resumed on join.
- Mic check in Settings → Voice: test your microphone without joining a call.
- Hairline figures: a console of faders when you're alone in a call, a mesh of devices when nobody else is online, the token in empty channels.
- The mark's halves close while at least one peer holds a session with you.
- Sigils replace identicons: a 17×17 seal whose inside is drawn by your name and whose rim is the 64 bits of your fingerprint — unique per identity by construction; a copied nickname shows a different rim.
- Rooms in the rail are rows with their sigil, separated by rules, instead of lettered tiles.
- No more chat notices for your own actions (joined voice, camera on, sharing, copied, input changed).
- Tray icon: a dedicated glyph with real 16–64 px bitmaps, a multi-size .ico on Windows and a template image on macOS.
- One instrument: cool graphite, phosphor signal, strokes instead of filled blocks.
- New mark and icon: a token broken in two — a secret held by two.
- Empty channels show a hairline figure of the sirr.
- Timestamps on one line; long room codes wrap in readable groups.

### Project
- AGPL-3.0-or-later. No license keys or paid tiers.
- Pinned dependencies, CI on Node 22 with checksums for release builds.
- `docs/PROTOCOL.md`, `SECURITY.md`, renderer preview harness in `dev/`.
