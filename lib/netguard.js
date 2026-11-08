'use strict';
/**
 * SSRF guard for the opt-in link preview.
 *
 * The preview is fetched by the main process, so a hostile URL must not be
 * able to make it reach loopback, the LAN, cloud metadata endpoints or any
 * other non-public address. Checked twice: on the hostname before the
 * request, and on every address the socket will actually connect to
 * (pinnedLookup), which closes the DNS-rebinding gap between the two.
 */
const dns = require('dns');
const net = require('net');
// Called in two places: once on the raw hostname (syntactic), once on each
// DNS-resolved address. Both must reject before we fire the HTTP request.
function _isPrivateHost(host) {
  if (!host) return true;
  const h = String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')
      || h.endsWith('.home.arpa') || h.endsWith('.onion')) return true;
  // A bare hostname is resolved later and every address checked; only
  // literal IPs are judged here (a name like "fdroid.org" is not an IPv6).
  return net.isIP(h) ? _isPrivateIp(h) : false;
}
// Anything that isn't plainly a public unicast address is refused.
function _isPrivateIp(addr) {
  if (!addr) return true;
  const a = String(addr).toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  const kind = net.isIP(a);
  if (kind === 4) return _isPrivateV4(a);
  if (kind !== 6) return true;
  // IPv4 embedded in IPv6: mapped (::ffff:a.b.c.d or ::ffff:7f00:1),
  // compatible (::a.b.c.d), NAT64 (64:ff9b::/96).
  const v4 = _embeddedV4(a);
  if (v4) return _isPrivateV4(v4);
  const first = parseInt(a.split(':')[0] || '0', 16);
  if (a === '::' || a === '::1') return true;
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true;   // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  if (first === 0x2001 && parseInt(a.split(':')[1] || '0', 16) === 0x0db8) return true; // documentation
  if (first === 0x0100) return true;               // 100::/64 discard
  return false;
}
function _isPrivateV4(a) {
  const o = a.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !(n >= 0 && n <= 255))) return true;
  const [o1, o2, o3] = o;
  if (o1 === 0 || o1 === 10 || o1 === 127) return true;
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;     // CGNAT 100.64/10
  if (o1 === 169 && o2 === 254) return true;                // link-local / cloud metadata
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return true;  // IETF / TEST-NET-1
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return true;  // benchmarking
  if (o1 === 198 && o2 === 51 && o3 === 100) return true;   // TEST-NET-2
  if (o1 === 203 && o2 === 0 && o3 === 113) return true;    // TEST-NET-3
  if (o1 >= 224) return true;                               // multicast / reserved / broadcast
  return false;
}
function _embeddedV4(a) {
  let m = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (m) return m[1];
  m = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return null;
}

function _lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return reject(err);
      resolve(addrs || []);
    });
  });
}

async function _resolveSafePreviewUrl(rawUrl, baseUrl) {
  let parsed;
  try { parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl); }
  catch (e) { return null; }
  if (!/^https?:$/i.test(parsed.protocol)) return null;
  if (_isPrivateHost(parsed.hostname)) return null;
  try {
    const addrs = await _lookupAll(parsed.hostname);
    if (!addrs.length) return null;
    if (addrs.some(a => _isPrivateIp(a.address))) return null;
  } catch (e) { return null; }
  return parsed;
}

// DNS-pinned lookup for the preview fetch. _resolveSafePreviewUrl already
// vets the hostname's addresses, but http.request re-resolves at connect
// time — a hostile DNS server could answer differently the second time
// (classic rebinding TOCTOU) and point us at 169.254.169.254 or the LAN.
// This lookup wrapper re-applies the private-range filter on the addresses
// the socket will ACTUALLY use, closing the gap.
function _pinnedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const safe = (addrs || []).filter(a => !_isPrivateIp(a.address));
    if (!safe.length) return callback(new Error('preview-private-address'));
    if (options && options.all) return callback(null, safe);
    callback(null, safe[0].address, safe[0].family);
  });
}

module.exports = {
  isPrivateHost: _isPrivateHost,
  isPrivateIp: _isPrivateIp,
  resolveSafeUrl: _resolveSafePreviewUrl,
  pinnedLookup: _pinnedLookup,
};
