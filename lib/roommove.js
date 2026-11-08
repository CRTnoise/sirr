'use strict';
/**
 * Room moves: rekey and eviction
 * ═══════════════════════════════════════════════════════════════════
 * Membership is the code, so the only way to remove someone is to move
 * everyone else to a new code they never see. The owner:
 *
 *   1. generates a new code (same owner commitment, fresh secret);
 *   2. signs  "sirr/move/1|" from "|" to "|" ts "|" evict…  with its
 *      per-room key for the old room (lib/msgsig.js);
 *   3. hands the move, encrypted, to every connected member that is not
 *      evicted — never to an evicted one;
 *   4. keeps listening on the old room for FORWARD_DAYS, and so does
 *      every member who moved: whoever comes back to the old room and
 *      isn't evicted gets the move from whoever is online.
 *
 * A member accepts a move only if both codes commit to the same owner and
 * either it came straight from that owner's authenticated session, or the
 * signature checks against the owner's room key that the owner itself
 * gave this member earlier (TOFU, storage.setRoomSignKey). An evicted
 * member holds the old code but not the owner's room secret, so it can't
 * forge a move to a room of its own.
 */
const RoomCode = require('./roomcode');
const msgsig = require('./msgsig');

const FORWARD_DAYS = 14;
const MAX_EVICT = 64;

const canonical = (m) => Buffer.from(['sirr/move/1', m.from, m.to, String(m.ts), (m.evict || []).join(','), String(m.name || '')].join('|'), 'utf8');

/** Owner side: build and sign a move. `crypto` is SirrCrypto. */
function make(crypto, from, name, evictFps) {
  const id = crypto.getIdentityId();
  if (RoomCode.ownerMatches(from, id) !== true) throw new Error('only the room owner can move it');
  const evict = [...new Set((evictFps || []).map(String))].slice(0, MAX_EVICT).sort();
  const m = { from, to: RoomCode.generate(id), ts: Date.now(), evict, name: String(name || '').slice(0, 64), owner: crypto.getFingerprint() };
  m.sig = crypto.signForRoom(from, canonical(m));
  return m;
}

/** Shape check for a move off the wire. */
function clean(o) {
  if (!o || typeof o !== 'object') return null;
  const { from, to, ts, evict, name, owner, sig } = o;
  if (!RoomCode.validate(from).ok || !RoomCode.validate(to).ok || from === to) return null;
  if (!Number.isFinite(ts) || !Array.isArray(evict) || evict.length > MAX_EVICT) return null;
  if (typeof sig !== 'string' || typeof owner !== 'string') return null;
  if (!evict.every(f => typeof f === 'string' && f.length <= 24)) return null;
  return { from, to, ts, evict: evict.slice(), name: typeof name === 'string' ? name.slice(0, 64) : '', owner, sig };
}

/**
 * Receiver side. `room` is our stored room record for m.from;
 * `sender` = { fingerprint, identityId } of the peer that handed it over.
 * @returns {{ok:boolean, why?:string}}
 */
function judge(m, room, sender, myFingerprint) {
  if (!room) return { ok: false, why: 'not a member' };
  if (m.evict.includes(myFingerprint)) return { ok: false, why: 'evicted' };
  if (Date.now() - m.ts > FORWARD_DAYS * 864e5 || m.ts - Date.now() > 3600e3) return { ok: false, why: 'stale' };
  const direct = sender && sender.identityId && RoomCode.ownerMatches(m.from, sender.identityId) === true;
  if (direct) {
    if (RoomCode.ownerMatches(m.to, sender.identityId) !== true) return { ok: false, why: 'new code has another owner' };
    return { ok: true };
  }
  const ownerId = room.ids && room.ids[m.owner];
  const key = room.signKeys && room.signKeys[m.owner];
  if (!ownerId || !key) return { ok: false, why: 'owner unknown here — wait for the owner' };
  if (RoomCode.ownerMatches(m.from, ownerId) !== true || RoomCode.ownerMatches(m.to, ownerId) !== true) return { ok: false, why: 'not the owner' };
  if (!msgsig.verify(key, canonical(m), m.sig)) return { ok: false, why: 'bad signature' };
  return { ok: true };
}

module.exports = { make, clean, judge, canonical, FORWARD_DAYS };
