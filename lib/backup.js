'use strict';
/**
 * Sealed backups
 * ══════════════
 * A backup holds the identity secret key, every room code (each one a join
 * secret) and the whole message history. It is never written in the clear:
 *
 *   key = scrypt(passphrase, salt, N=2^17, r=8, p=1) → 32 bytes
 *   box = XSalsa20-Poly1305(key, nonce, JSON bundle)
 *
 * File: { format: "sirr-backup", v: 1, kdf: {...}, salt, nonce, box }
 * (all binary fields base64). A wrong passphrase and a tampered file are
 * indistinguishable: both fail authentication.
 */
const crypto = require('crypto');
const nacl = require('tweetnacl');

const FORMAT = 'sirr-backup';
const KDF = { name: 'scrypt', N: 1 << 17, r: 8, p: 1 };
const MIN_PASSPHRASE = 10;

function _key(passphrase, salt, kdf) {
  if (!kdf || kdf.name !== 'scrypt') throw new Error('unsupported key derivation');
  const N = Number(kdf.N), r = Number(kdf.r), p = Number(kdf.p);
  // Bounds keep a hostile file from asking for gigabytes of memory.
  if (!(N >= 1 << 14 && N <= 1 << 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) {
    throw new Error('backup asks for unreasonable key-derivation settings');
  }
  return crypto.scryptSync(String(passphrase).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 160 * N * r });
}

function checkPassphrase(passphrase) {
  const p = String(passphrase || '');
  if ([...p].length < MIN_PASSPHRASE) throw new Error('Use a passphrase of at least ' + MIN_PASSPHRASE + ' characters.');
  return p;
}

/** @returns {string} the file contents */
function seal(bundle, passphrase) {
  const pass = checkPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(24);
  const key = _key(pass, salt, KDF);
  const pt = Buffer.from(JSON.stringify(bundle), 'utf8');
  const box = nacl.secretbox(new Uint8Array(pt), new Uint8Array(nonce), new Uint8Array(key));
  key.fill(0);
  return JSON.stringify({
    format: FORMAT, v: 1, kdf: KDF,
    salt: salt.toString('base64'), nonce: nonce.toString('base64'),
    box: Buffer.from(box).toString('base64'),
  });
}

/** @returns {object} the bundle */
function open(text, passphrase) {
  let f;
  try { f = JSON.parse(String(text)); } catch (e) { throw new Error('Not a Sirr backup.'); }
  if (!f || f.format !== FORMAT || f.v !== 1) throw new Error('Not a Sirr backup.');
  const salt = Buffer.from(String(f.salt || ''), 'base64');
  const nonce = Buffer.from(String(f.nonce || ''), 'base64');
  const box = Buffer.from(String(f.box || ''), 'base64');
  if (salt.length !== 16 || nonce.length !== 24 || box.length < 16) throw new Error('Backup file is damaged.');
  const key = _key(String(passphrase || ''), salt, f.kdf);
  const pt = nacl.secretbox.open(new Uint8Array(box), new Uint8Array(nonce), new Uint8Array(key));
  key.fill(0);
  if (!pt) throw new Error('Wrong passphrase, or the file was altered.');
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}

module.exports = { seal, open, checkPassphrase, FORMAT, MIN_PASSPHRASE };
