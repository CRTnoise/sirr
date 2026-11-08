# Sirr protocol

This is a description of what goes over the wire and onto disk, for reviewers. The code is the authority; file names are given for each part.

## 1. Identities — `lib/crypto-layer.js`

- An identity is an X25519 key pair (`nacl.box.keyPair`), generated locally on first launch.
- **Identity id**: SHA-256 of the public key (256 bits). Authorization decisions (room ownership, admin grants, DM counterparts) are pinned to this.
- **Fingerprint**: the first 64 bits of the identity id, shown as `XXXX XXXX XXXX XXXX`, for people to compare.
- The secret key is sealed at rest with the OS keystore (Electron `safeStorage`: DPAPI, Keychain, libsecret). Without a keystore it falls back to a `0600` file and the app warns.

## 2. Rooms and rendezvous — `lib/roomcode.js`, `lib/network.js`

A room code is `SR-` and 40 characters from a 31-letter alphabet, grouped in fives:

| chars | meaning |
| --- | --- |
| 0–21 | the join secret, ≈109 bits from a CSPRNG |
| 22–37 | `base31(SHA-256("sirr/owner/1|" ‖ creator identity id)[0..80 bits])` |
| 38–39 | checksum |

Whoever holds the code is a member. The commitment lets every member check who created the room without trusting anyone's say-so.

**Rendezvous.** For epoch `e = floor(unix_ms / 3 600 000)`, a room is announced and looked up on

```
topic(e) = HMAC-SHA256(SHA-256("sirr/rv/1|" ‖ code), "epoch:" ‖ e)
```

for `e-1`, `e`, `e+1`. There is no static topic. A DHT observer without the code sees unlinkable 32-byte values that change every hour; recovering the code from a topic means a 2^109 search.

**DMs.** A DM is named `DM` + 10 hex of `SHA-256(sorted fingerprints)` — a local name only. Its rendezvous is pairwise:
`HMAC-SHA256(HMAC-SHA256(DH(identity_mine, identity_theirs), "sirr/dm-rv/1"), "epoch:" ‖ e)`. Only the two parties can compute it; until they have met (and stored each other's key) a DM has no topic and uses existing connections.

**Personal inbox (opt-in, off by default).** With it on, the client also listens on `SHA-256("sirr/inbox/1|" ‖ fingerprint)` so people who share no room can send a message request. Anyone who knows the fingerprint can find the IP while the client is online — hence opt-in.

## 3. Links and the handshake — `lib/network.js`, `lib/crypto-layer.js`

Hyperswarm gives each pair of peers a Noise-encrypted stream (with a random per-launch swarm key, unlinkable across launches). On top of it, handshake **kx v3**:

1. Each side sends `KEY_EXCHANGE`: its identity public key `s`, a fresh **ephemeral** X25519 key `e` for this connection, capabilities, room-membership tags (§4) and the current minute (clock check, §10). No nickname, avatar or status.
2. With `L`/`H` the two parties ordered by identity key, each computes

   ```
   ikm = DH(eL,eH) ‖ DH(eL,sH) ‖ DH(sL,eH)
   K   = HMAC-SHA256(HMAC-SHA256("sirr/kx/3", ikm),
                     "sirr/kx/3|" sL "|" sH "|" eL "|" eH "|" binding)
   ```

   where `binding` is the sorted pair of swarm keys of this socket. It burns its ephemeral secret and sends `KEY_CONFIRM` with `HMAC(K, "confirm|" own identity)`.
3. On a valid confirm the session key is `HMAC(K, "session")`.

Properties: `DH(eL,eH)` gives **forward secrecy**; the two mixed terms authenticate both identities; no term combines the two static keys, so a stolen identity key does **not** let the thief impersonate others to its owner (no key-compromise impersonation); the binding stops a session being spliced onto another connection.

Rules enforced by the receiver:

- A `KEY_EXCHANGE` below v3 or without an ephemeral key is refused and the connection dropped — there is nothing to downgrade to.
- Until `KEY_CONFIRM` succeeds, only `KEY_EXCHANGE`, `KEY_CONFIRM`, `PING`, `PONG` and `LEAVE` are processed.
- The profile (nickname, avatar, drawn sigil, status) travels only in `PROFILE`, encrypted under the session. The peer reaches the UI and rosters once its `PROFILE` is in (or 2 s after confirmation).
- Blocked fingerprints are dropped at `KEY_EXCHANGE`.

Content messages (chat, profile, sync bundles, edits, file control, room keys, moves) are encrypted with the session key: XSalsa20-Poly1305, 24-byte random nonce per message. Every plaintext is padded (ISO/IEC 7816-4) to 256 B, 1 KiB, 4 KiB, 16 KiB, then 16 KiB steps.

## 4. Membership without disclosure

A peer must not learn the rooms you don't share with it. Membership is declared as tags bound to the connection:

```
tag(code) = HMAC-SHA256(key = code, "sirr/room-tag/1|" ‖ sort(swarmKeyA, swarmKeyB))[0..128 bits]
```

Only someone who already knows the code can produce or recognise the tag, and it means nothing on any other connection.

## 5. Authorship of relayed messages — `lib/msgsig.js`

Members who were offline get missed history from whoever is online (offline sync). To know a relayed message is genuine without making messages non-repudiable:

- each identity derives a separate Ed25519 key **per room** (`seed = HMAC-SHA256(identity secret, "sirr/room-sign/1|" ‖ room)`), so keys in different rooms are unlinkable;
- messages and edits are signed with that room key;
- the binding "room key K belongs to fingerprint F" is only ever sent peer to peer inside an authenticated session (`ROOM_KEYS`), never signed — a leaked transcript proves nothing about who K is.

A relayed message is shown as verified, forged or unverified accordingly.

## 5b. Room moves: rekey and eviction — `lib/roommove.js`

The owner generates a new code with the same owner commitment and signs `"sirr/move/1|" from "|" to "|" ts "|" evict… "|" name` with its per-room key for the old room. The move goes, encrypted, to every connected member not listed in `evict`. Everyone who moved keeps listening on the old code for 14 days and hands the move to any non-evicted member who comes back.

A member accepts a move if both codes commit to the same owner and either the move came straight from the owner's session, or its signature checks against the owner's room key that the owner gave this member directly. The old room becomes a read-only archive.

## 6. Files — `lib/bolt.js`, `lib/transfers.js`

Binary frames on the same stream: 14-byte header, LZ4 when it helps, then AES-256-GCM with the header as AAD. Per-transfer key `HMAC-SHA256(session key, "sirr/bolt/1|" ‖ sender fp ‖ id ‖ epoch)`; nonce = sequence ‖ session id. SHA-256 of the whole file is verified on completion. Received files are written to disk encrypted (§7) and decrypted only when the user saves them.

## 7. At rest — `lib/vault.js`, `lib/storage.js`

One random 256-bit data key, sealed by the OS keystore. Sub-keys by HMAC:

- `seal` — XSalsa20-Poly1305 for config (room codes, contacts) and message content;
- `mac` — keyed hashes for SQLite index columns (room / channel), so no plaintext names reach the database;
- `file` — AES-256-GCM records for received files, one key per file.

SQLite runs with `secure_delete = ON`. Disappearing messages carry an absolute `expiresAt` set by the sender and are swept every 20 s.

A room can be set to keep **no history on this device**: its messages are never written, and what was stored is erased.

**App lock** — `lib/applock.js`. Optional. `K = scrypt(passphrase, salt, N=2^17, r=8, p=1)`, `KEK = HMAC(K, "sirr/lock/kek")`. Whatever the keystore adapter seals (the data key, the identity key) is first sealed under the KEK (`"lk1:" ‖ nonce ‖ secretbox`). `lock.json` holds `salt`, `check = HMAC(K, "sirr/lock/check")` and `duress = HMAC(K', "sirr/lock/duress")` for an optional duress passphrase (random bytes when none is set). Until the passphrase is right, only a lock window with a two-call bridge exists; wrong guesses back off exponentially to 30 s.

**Panic wipe / duress.** Overwrite and delete `datakey.json`, `identity.json`, `lock.json` (crypto-shredding: all other data becomes ciphertext under a key that no longer exists), close the database, delete the data directory, clear Chromium storage.

## 8. Backups — `lib/backup.js`

`scrypt(passphrase, salt, N=2^17, r=8, p=1)` → XSalsa20-Poly1305 over the bundle (identity key, config, history). There is no unencrypted export.

## 9. Echoes: offline delivery inside the DHT — `lib/echoes.js`

Opt-in. For room secret `R` (DMs: the pairwise secret), `E = HMAC(R, "sirr/echo/1")`. For writer `W` (fingerprint) and UTC day `d`, every member can derive Ed25519 key pairs

```
head(W,d)   = seed HMAC(E, "head|" W "|" d)
slot(W,d,i) = seed HMAC(E, "slot|" W "|" d "|" i)      i < 32
```

When a member is offline, message `k` of the day (split into ≤ 8 parts of 480 B) is put as a HyperDHT mutable record under `slot(W,d,k mod 32)` with `seq = k`; the head holds the count. Values: `nonce ‖ secretbox(HMAC(E, "seal|" pubkey), pad(json, 720))` — 760 B each, all identical in size. Readers poll heads for every roster member, today and yesterday, and read the slots they haven't seen, with `refresh`: each read re-puts the same signed record, renewing its 48 h lifetime on the nodes it asked. Messages carry their author's room signature and are judged like relayed messages (`msgsig.judgeRelayed`). With cover traffic on, polls run on a random 1.5–4 min schedule so a real write looks like a refresh.

## 10. Getting through — `lib/pathways.js`, `lib/nearby*.js`

- **Entry points**: user-supplied DHT nodes first, then up to 64 remembered from earlier sessions (sealed in the config; a random 24 tried), then the three defaults. Invite links may carry `via=` entry points (`?via=` on `sirr://`, `&via=` in the fragment of gateway links).
- **Volunteer relays**: a volunteer runs a `blind-relay` server under a new key each launch, announced on `SHA-256("sirr/relays/1|" ‖ day)`. Clients relay through a random volunteer when a direct connection fails (`auto`) or always. At most 24 sessions per volunteer.
- **Bridges**: the whole DHT over one WebSocket (`@hyperswarm/dht-relay`), served by `bin/sirr-bridge.js` or the app. The bridge holds the per-launch swarm key; everything inside is §3–§4.
- **Clock check**: peers tell each other the minute in `KEY_EXCHANGE`; a median skew ≥ 30 min raises a warning (rendezvous topics change hourly).
- **Nearby**: carriers (LAN: UDP announce `magic(day) ‖ node key ‖ tcp port` to 239.255.42.99:47999 and broadcast, then TCP; Bluetooth LE: GATT RX/TX, experimental) provide links. Over links, a mesh floods beacons `{origin, nonce, tags, hops ≤ 4}` with `tag = HMAC(rendezvous topic(room, hour), "sirr/near/1|" ‖ nonce)[0..128 bits]`, padded to a multiple of 4. A member who recognises a tag (lower node key dials) opens a circuit along the reverse path; relays forward frames blindly; the circuit carries a Noise secret-stream between the endpoints, and §3 runs inside it.

## 11. What leaves the machine

- Hyperswarm DHT traffic (UDP) and direct peer connections — or, with a bridge set, one WebSocket to the bridge.
- With relaying on: connections to volunteer relays. Volunteering: relayed streams for others.
- With Nearby on: UDP announcements and TCP links on the local network; BLE advertising if the Bluetooth carrier is installed.
- With Echoes on: mutable record puts and gets on the DHT.
- During calls, STUN requests to the configured servers (none if the voice route is "swarm").
- With link previews on: a request to sites *you* linked.
- Nothing else. No telemetry, no update checks, no spell-check dictionaries, no fonts or images from the web.
