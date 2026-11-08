/**
 * Room codes
 * ==========
 *   SR-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX
 *
 * 40 characters from a 31-letter alphabet with no 0/O/1/I lookalikes,
 * grouped in fives for reading aloud:
 *
 *   chars  0..21  the join secret — 22 random chars, ≈109 bits
 *   chars 22..37  a commitment to the creator's full identity:
 *                 base31(first 80 bits of SHA-256("sirr/owner/1|" id))
 *   chars 38..39  checksum over everything before it (catches typos)
 *
 * The code IS the room: it derives the DHT rendezvous topics and the
 * membership tags. Anyone who can guess it can walk in, and anyone who
 * can watch the DHT sees topics derived from it, so it must survive an
 * offline brute-force against those topics. 109 bits does; the earlier
 * 60-bit format would fall to a GPU cluster in days.
 *
 * Whoever holds the code also knows who owns the room — no first-come
 * trust. Forging ownership needs a ~2^79 preimage against the commitment.
 *
 * DM codes (`DM` + 10 hex) are local names derived from a fingerprint pair
 * and bypass this format.
 */

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 31 chars, unambiguous
const PREFIX = 'SR';
const SECRET_LEN = 22;
const COMMIT_LEN = 16;
const SUM_LEN = 2;
const BODY_LEN = SECRET_LEN + COMMIT_LEN;            // 38
const CODE_LEN = BODY_LEN + SUM_LEN;                 // 40
const GROUP = 5;

// Rejection sampling: bytes ≥ 248 (= 31 × 8) are discarded so every
// alphabet character is equally likely.
const REJECT_CUTOFF = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
const ALPHA_RE = new RegExp('^[' + ALPHABET + ']+$');

const sha256Hex = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

function randomChars(n) {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < REJECT_CUTOFF) out += ALPHABET[b % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

// Two alphabet chars from the first 16 bits of SHA-256(prefix + body).
function checksum(body) {
  const n = parseInt(sha256Hex(PREFIX + '-' + body).slice(0, 4), 16);
  return ALPHABET[n % ALPHABET.length] + ALPHABET[Math.floor(n / ALPHABET.length) % ALPHABET.length];
}

function ownerCommit(identityId) {
  let n = BigInt('0x' + sha256Hex('sirr/owner/1|' + String(identityId || '')).slice(0, 20));
  let out = '';
  for (let i = 0; i < COMMIT_LEN; i++) { out = ALPHABET[Number(n % 31n)] + out; n /= 31n; }
  return out;
}

function format(chars) {
  const groups = [];
  for (let i = 0; i < chars.length; i += GROUP) groups.push(chars.slice(i, i + GROUP));
  return PREFIX + '-' + groups.join('-');
}

/** A fresh code owned by `identityId` (full 256-bit identity, hex). */
function generate(identityId) {
  // Without an identity the commitment is random: nobody can prove ownership.
  const commit = identityId ? ownerCommit(identityId) : randomChars(COMMIT_LEN);
  const body = randomChars(SECRET_LEN) + commit;
  return format(body + checksum(body));
}
const generateOwned = generate;

function normalize(input) {
  return String(input || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isDmCode(code) { return /^DM[0-9A-F]{10}$/.test(code); }

/** Strip prefix and dashes; null unless it has the shape of a code. */
function _chars(code) {
  const m = /^SR-?([A-Z0-9-]+)$/.exec(normalize(code));
  if (!m) return null;
  const chars = m[1].replace(/-/g, '');
  return chars.length === CODE_LEN ? chars : null;
}

function isOwnedCode(code) { return _chars(code) !== null; }

/** Does this full identity own the room? null when the code isn't an SY code. */
function ownerMatches(code, identityId) {
  const chars = _chars(code);
  if (!chars) return null;
  if (!identityId) return false;
  return ownerCommit(identityId) === chars.slice(SECRET_LEN, BODY_LEN);
}

// Returns { ok: true, code, owned } or { ok: false, reason } where reason is
// a short upper-case tag for display.
function validate(input) {
  const code = normalize(input);
  if (!code) return { ok: false, reason: 'EMPTY' };
  if (isDmCode(code)) return { ok: true, code };
  const chars = _chars(code);
  if (!chars) return { ok: false, reason: 'BAD_FORMAT' };
  if (!ALPHA_RE.test(chars)) return { ok: false, reason: 'BAD_CHARS' };
  if (checksum(chars.slice(0, BODY_LEN)) !== chars.slice(BODY_LEN)) return { ok: false, reason: 'BAD_CHECKSUM' };
  return { ok: true, code: format(chars), owned: true };
}

// Invite links. With no gateway configured an invite is the bare scheme
// link `sirr://join/<code>`. A project or community may host a small
// static gateway page and set `inviteBase` in config; the code then rides in
// the URL *fragment* (`https://gateway/#<code>`). Fragments are never sent
// to the web server, so the join secret stays out of the host's logs.
const SCHEME = 'sirr:';
// `hints` are entry points (DHT nodes "host:port", or a bridge URL) that
// help the invitee get onto the network when the default ones are blocked.
function toInviteUrl(code, base, hints) {
  const c = encodeURIComponent(normalize(code));
  const b = String(base || '').trim();
  const h = (hints || []).filter(Boolean).slice(0, 4);
  const via = h.length ? 'via=' + encodeURIComponent(h.join(',')) : '';
  if (/^https:\/\/[^\s#?]+$/i.test(b)) return b.replace(/\/?$/, '/') + '#' + c + (via ? '&' + via : '');
  return SCHEME + '//join/' + c + (via ? '?' + via : '');
}
function parseInviteHints(url) {
  try {
    const m = /[?&#]via=([^&#\s]+)/.exec(String(url || ''));
    if (!m) return [];
    return decodeURIComponent(m[1]).split(',').map(x => x.trim()).filter(x => x && x.length < 200).slice(0, 4);
  } catch (e) { return []; }
}

// Parse an invite (scheme link or gateway URL) — returns the code or null.
function parseInviteUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      const frag = decodeURIComponent((u.hash || '').replace(/^#/, '').split('&')[0]);
      const c = normalize(frag);
      return c || null;
    }
    if (u.protocol !== SCHEME || u.hostname !== 'join') return null;
    const raw = (u.pathname || '').replace(/^\//, '') || u.searchParams.get('code') || '';
    const code = normalize(decodeURIComponent(raw));
    return code || null;
  } catch (e) { return null; }
}

module.exports = {
  ALPHABET,
  CODE_LEN,
  generate,
  generateOwned,
  ownerCommit,
  ownerMatches,
  isOwnedCode,
  validate,
  normalize,
  isDmCode,
  toInviteUrl,
  parseInviteUrl,
  parseInviteHints,
  sha256Hex,
};
