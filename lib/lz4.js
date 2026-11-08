'use strict';
/**
 * LZ4 block format — compress / decompress, pure JS, no dependencies.
 * ═══════════════════════════════════════════════════════════════════
 * BOLT's compression layer. LZ4 trades ratio for speed: hundreds of MB/s
 * in V8, so it never becomes the bottleneck on a network link, and it
 * still halves text, logs, source trees, raw images, save games…
 *
 * Standard LZ4 *block* format (no frame header — BOLT frames carry the
 * lengths). Output is byte-compatible with liblz4's LZ4_compress_default
 * / LZ4_decompress_safe.
 *
 * Safety: decompress() is bounds-checked against both the input and a
 * caller-supplied exact output size, so a hostile peer can't make it
 * read or write out of range or inflate beyond the expected chunk.
 */

const MIN_MATCH    = 4;
const LAST_LITERALS = 5;     // spec: last 5 bytes are always literals
const MF_LIMIT     = 12;     // spec: no match may start within the last 12 bytes
const HASH_LOG     = 16;
const HASH_SIZE    = 1 << HASH_LOG;
const MAX_OFFSET   = 65535;
const SKIP_TRIGGER = 6;      // acceleration on incompressible data

/** Worst-case compressed size for `n` input bytes. */
function compressBound(n) { return n + ((n / 255) | 0) + 16; }

// Positions are stored +base so the table never needs clearing: entries
// from a previous call are < base and fail the `ref >= 0` test.
const hashTable = new Int32Array(HASH_SIZE);
let tableBase = 0;

function read32(b, i) { return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24); }
function hash32(v) { return (Math.imul(v, 2654435761) >>> (32 - HASH_LOG)); }

/**
 * @param {Uint8Array} src
 * @param {Uint8Array} [dst] optional output buffer (>= compressBound(src.length))
 * @returns {Uint8Array} compressed block (a view into dst if given)
 */
function compress(src, dst) {
  const n = src.length;
  if (!dst) dst = new Uint8Array(compressBound(n));
  let op = 0;
  let anchor = 0;

  if (n >= MF_LIMIT + 1) {
    if (tableBase > 0x3fffffff - n) { hashTable.fill(0); tableBase = 0; }
    const base = tableBase + 1;
    tableBase += n + 1;
    const mflimit = n - MF_LIMIT;
    const matchLimit = n - LAST_LITERALS;
    let ip = 0;
    let searchMatchNb = 1 << SKIP_TRIGGER;

    while (ip < mflimit) {
      const seq = read32(src, ip);
      const h = hash32(seq);
      const ref = hashTable[h] - base;   // < 0 → empty or stale
      hashTable[h] = ip + base;

      if (ref < 0 || ip - ref > MAX_OFFSET || read32(src, ref) !== seq) {
        ip += searchMatchNb++ >> SKIP_TRIGGER;
        continue;
      }
      searchMatchNb = 1 << SKIP_TRIGGER;

      // extend backwards
      let mIp = ip, mRef = ref;
      while (mIp > anchor && mRef > 0 && src[mIp - 1] === src[mRef - 1]) { mIp--; mRef--; }

      // extend forwards — 4 bytes at a time, then byte-wise
      let len = MIN_MATCH;
      while (mIp + len + 4 <= matchLimit && read32(src, mIp + len) === read32(src, mRef + len)) len += 4;
      while (mIp + len < matchLimit && src[mIp + len] === src[mRef + len]) len++;

      // emit sequence: token, literals, offset, match length
      const litLen = mIp - anchor;
      const tokenPos = op++;
      let token;
      if (litLen >= 15) {
        token = 15 << 4;
        let l = litLen - 15;
        while (l >= 255) { dst[op++] = 255; l -= 255; }
        dst[op++] = l;
      } else {
        token = litLen << 4;
      }
      if (litLen < 32) { for (let i = 0; i < litLen; i++) dst[op + i] = src[anchor + i]; }
      else dst.set(src.subarray(anchor, mIp), op);
      op += litLen;

      const off = mIp - mRef;
      dst[op++] = off & 255; dst[op++] = off >>> 8;

      const ml = len - MIN_MATCH;
      if (ml >= 15) {
        token |= 15;
        let l = ml - 15;
        while (l >= 255) { dst[op++] = 255; l -= 255; }
        dst[op++] = l;
      } else {
        token |= ml;
      }
      dst[tokenPos] = token;

      ip = mIp + len;
      anchor = ip;
      if (ip >= mflimit) break;
      // prime the table with the position just before the new anchor
      hashTable[hash32(read32(src, ip - 2))] = ip - 2 + base;
    }
  }

  // last literals
  const litLen = n - anchor;
  if (litLen >= 15) {
    dst[op++] = 15 << 4;
    let l = litLen - 15;
    while (l >= 255) { dst[op++] = 255; l -= 255; }
    dst[op++] = l;
  } else {
    dst[op++] = litLen << 4;
  }
  dst.set(src.subarray(anchor, n), op); op += litLen;
  return dst.subarray(0, op);
}

/**
 * @param {Uint8Array} src     compressed block
 * @param {number} outLen      EXACT expected output size
 * @returns {Uint8Array}
 * @throws on any malformed / out-of-bounds / wrong-size input
 */
function decompress(src, outLen) {
  const dst = new Uint8Array(outLen);
  const n = src.length;
  let ip = 0, op = 0;
  while (ip < n) {
    const token = src[ip++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b;
      do {
        if (ip >= n) throw new Error('lz4: truncated literal length');
        b = src[ip++]; lit += b;
      } while (b === 255);
    }
    if (ip + lit > n || op + lit > outLen) throw new Error('lz4: literal overrun');
    if (lit < 32) { for (let i = 0; i < lit; i++) dst[op + i] = src[ip + i]; }
    else dst.set(src.subarray(ip, ip + lit), op);
    ip += lit; op += lit;
    if (ip >= n) break;                       // last sequence has no match

    if (ip + 2 > n) throw new Error('lz4: truncated offset');
    const off = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (off === 0 || off > op) throw new Error('lz4: bad offset');

    let ml = token & 15;
    if (ml === 15) {
      let b;
      do {
        if (ip >= n) throw new Error('lz4: truncated match length');
        b = src[ip++]; ml += b;
      } while (b === 255);
    }
    ml += MIN_MATCH;
    if (op + ml > outLen) throw new Error('lz4: match overrun');
    let ref = op - off;
    if (off >= ml && ml > 32) {
      dst.copyWithin(op, ref, ref + ml);
      op += ml;
    } else {
      for (let i = 0; i < ml; i++) dst[op++] = dst[ref++];   // overlapping copy
    }
  }
  if (op !== outLen) throw new Error('lz4: size mismatch (' + op + ' != ' + outLen + ')');
  return dst;
}

module.exports = { compress, decompress, compressBound };
