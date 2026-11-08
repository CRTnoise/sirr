'use strict';
/**
 * Message authorship — silent, per-room, deniable
 * ═══════════════════════════════════════════════════════════════════
 * Problem: when a peer relays history you missed (offline sync), you only
 * have their word for who wrote each message.
 *
 * Constraint: proving authorship must not LEAK identity — a signed message
 * copied out of the room shouldn't prove to the world who you are, and
 * your rooms shouldn't be linkable to each other.
 *
 * Design:
 *   • Every room gets its own Ed25519 key, derived from your identity
 *     secret:  seed = HMAC-SHA256(identity secret, "sirr/room-sign/1|" room)
 *     Different room → unrelated key. Nothing links them.
 *   • Messages are signed with the room key. The signature says only
 *     "the holder of room key K wrote this".
 *   • "K belongs to fingerprint F" is told ONLY directly, peer to peer,
 *     inside the encrypted identity-authenticated session (ROOM_KEYS), and
 *     is never itself signed. Members who have met you can check relayed
 *     messages; a leaked transcript proves nothing about who K is.
 *     (Same deniability idea as Signal's MAC-based authentication.)
 */
const crypto = require('crypto');
const nacl = require('tweetnacl');

const sha256hex = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s)).digest('hex');

/** Canonical bytes of a chat message for signing. Order and types fixed. */
function canonicalMessage(room, m) {
  return Buffer.from(JSON.stringify([
    'sirr-msg/1', String(room), String(m.channel || 'default'), String(m.msgId || ''),
    Number(m.timestamp) || 0, String(m.type || 'text'), sha256hex(m.content),
    String(m.fileName || ''), Number(m.fileSize) || 0,
    String((m.replyTo && m.replyTo.msgId) || ''),
  ]), 'utf8');
}

/** Canonical bytes of an edit (content replaced at editedAt). */
function canonicalEdit(room, channel, msgId, content, editedAt) {
  return Buffer.from(JSON.stringify([
    'sirr-edit/1', String(room), String(channel || 'default'), String(msgId || ''),
    sha256hex(content), Number(editedAt) || 0,
  ]), 'utf8');
}

function verify(pubB64, bytes, sigB64) {
  try {
    const pub = Buffer.from(String(pubB64), 'base64');
    const sig = Buffer.from(String(sigB64), 'base64');
    if (pub.length !== 32 || sig.length !== 64) return false;
    return nacl.sign.detached.verify(new Uint8Array(bytes), new Uint8Array(sig), new Uint8Array(pub));
  } catch (e) { return false; }
}

/**
 * Decide what to make of a message someone relayed to us.
 * @returns {'authentic'|'forged'|'unverified'}
 *   authentic   handed over by its own author, or signature checks against
 *               the author's room key we learned directly from them
 *   forged      we know the author's key and the signature does NOT check
 *   unverified  we've never met the author directly (no key yet)
 */
function judgeRelayed({ room, m, relayerFp, getKey }) {
  const claimed = typeof m.fingerprint === 'string' ? m.fingerprint : '';
  if (claimed && claimed === relayerFp) return 'authentic';
  if (!claimed) return 'unverified';
  const pub = getKey(claimed);
  if (!pub) return 'unverified';
  const ok = (m.editedAt && m.editSig)
    ? verify(pub, canonicalEdit(room, m.channel || 'default', m.msgId, m.content, m.editedAt), m.editSig)
    : (typeof m.sig === 'string' && verify(pub, canonicalMessage(room, m), m.sig));
  return ok ? 'authentic' : 'forged';
}

module.exports = { canonicalMessage, canonicalEdit, verify, sha256hex, judgeRelayed };
