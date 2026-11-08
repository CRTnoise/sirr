# Changelog

## 1.2.0 — security release

Fixes for four reports received through GitHub's private vulnerability reporting. Thanks to **KineticEnforcer** for a careful source review.

**Protocol change: 1.2.0 does not talk to 1.1.x.** A 1.1 peer is refused with "peer runs an older Sirr". Accepting old peers would let anyone in the path downgrade a link back to readable frames, so everyone in a room needs to update.

### High — bridges could read and forge most traffic (GHSA-mmqx-xg3q-gxpf)
With a WebSocket bridge in the path, the Noise transport ends at the bridge. 1.1.0 encrypted chat bodies, profiles, files, edits and room keys end to end, but sent voice audio and signaling, pins (with message previews), room and channel names, typing, admin and charter updates, sync summaries and membership updates as plain frames inside the transport — readable and injectable by a bridge operator. SECURITY.md said otherwise; that was wrong.
- Every frame after the handshake now travels in one sealed record type. Nothing but the handshake is accepted in the clear; there is no list of "encrypted types" left for a new message to fall out of.
- Frames written before the session exists are held and sent sealed once it does.
- SECURITY.md and PROTOCOL.md now state exactly what a bridge still sees: the handshake (identity public key, room tags), file-transfer frame headers, and record sizes and timing.

### Moderate — no per-message key evolution (GHSA-fwx8-fgvh-j8w5)
1.1.0 used one session key per connection for its whole life.
- Per-direction hash ratchet: a fresh key for every record, wiped after use. Keys copied from memory open nothing already sent.
- Record counters: replayed, reordered, rewritten or forged records are refused and end the session.
- In-session X25519 rekey every 10 minutes (or 5000 records): someone who copied the keys but isn't on the wire is locked out again.
- File transfers: each offer carries its own random salt inside the ratcheted session; transfer keys no longer derive from a per-connection key alone.

### Moderate — "sig ok" was shown without checking the signature (GHSA-jj3h-r5mp-jjc4)
Live messages displayed "sig ok" on the strength of the authenticated session, without verifying the room signature they carried.
- Live messages and edits are now verified against the author's room key on arrival. "sig ok" appears only for a signature that checked out (or your own messages); a failing or uncheckable signature shows nothing, and a bad one is logged.

### Low — hardening bundle (GHSA-g44g-rx4g-rpwr)
- Voice is only sent once the session exists, matching what the receiver accepts.
- Room permissions fail closed: a room whose code commits to no owner grants nobody rights, and the settings UI no longer offers owner controls that enforcement would refuse (SR- rooms before their charter arrived showed them to everyone).
- Temporary identity: when the saved identity can't be unlocked (OS keyring unavailable), Sirr now keeps the temporary identity in memory only and shows a permanent banner. 1.1.0 also **overwrote** the saved identity with the temporary one (keeping the old file as `identity.json.locked`); that no longer happens. If you were hit by this, see "Recovering" below.
- `sirr://` links ask before joining: the dialog shows the room code; nothing is announced until you click Join. Codes typed or pasted in the app still join at once.
- Edits are capped like new messages (8000 characters) on the network, in the event handler and in the store.

### Recovering an identity overwritten by 1.1.0
If 1.1.0 ever started with a locked keyring, your original identity is in `identity.json.locked` in Sirr's data folder (`~/.sirr`; on Windows `%USERPROFILE%\.sirr`). Quit Sirr, unlock your keyring, rename `identity.json` to `identity.json.temp` and `identity.json.locked` to `identity.json`, then start Sirr.

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
