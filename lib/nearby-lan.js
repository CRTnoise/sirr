'use strict';
/**
 * Nearby over the local network (same Wi-Fi, hotspot, Ethernet) — works
 * with no internet at all. A UDP multicast/broadcast datagram says "a Sirr
 * node is here, reach it on TCP port P"; nothing about rooms or people.
 * Nodes link up over TCP and the mesh (lib/nearby.js) does the rest.
 *
 *   datagram = magic(8) ‖ node key(32) ‖ tcp port(2)
 *   magic    = SHA-256("sirr/lan/1|" ‖ day)[0..8]   (changes daily)
 *
 * Someone watching the LAN can tell that a Sirr node is at an address —
 * that is the price of being findable without any server — but not who it
 * is (the key is new every launch) or which rooms it is in.
 */
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

const PORT = 47999;
const GROUP = '239.255.42.99';
const EVERY_MS = 4000;
const magic = (day) => crypto.createHash('sha256').update('sirr/lan/1|' + day).digest().subarray(0, 8);

class LanCarrier {
  constructor(nearby, opts = {}) {
    this.nb = nearby;
    this.port = opts.port || PORT;
    this.group = opts.group || GROUP;
    this.targets = opts.targets || null;      // tests: [{host, port}] instead of multicast/broadcast
    this.dialing = new Set();
    this.udp = null; this.tcp = null; this.timer = null;
    this.tcpPort = 0;
  }

  async start() {
    this.tcp = net.createServer((sock) => this._link(sock));
    await new Promise((res, rej) => { this.tcp.once('error', rej); this.tcp.listen(0, this.targets ? '127.0.0.1' : '0.0.0.0', res); });
    this.tcpPort = this.tcp.address().port;
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('error', () => {});
    this.udp.on('message', (m, r) => this._onDatagram(m, r));
    await new Promise((res) => this.udp.bind(this.targets ? 0 : this.port, res));
    if (!this.targets) {
      try { this.udp.addMembership(this.group); } catch (e) {}
      try { this.udp.setMulticastTTL(1); this.udp.setBroadcast(true); } catch (e) {}
    }
    this.timer = setInterval(() => this._announce(), EVERY_MS);
    if (this.timer.unref) this.timer.unref();
    this._announce();
    return this;
  }
  udpPort() { return this.udp ? this.udp.address().port : 0; }

  _announce() {
    const p = Buffer.alloc(2); p.writeUInt16BE(this.tcpPort, 0);
    const msg = Buffer.concat([magic(Math.floor(Date.now() / 864e5)), this.nb.keyPair.publicKey, p]);
    const to = this.targets || [{ host: this.group, port: this.port }, { host: '255.255.255.255', port: this.port }];
    for (const t of to) this.udp.send(msg, t.port, t.host, () => {});
  }

  _onDatagram(m, r) {
    if (m.length !== 42) return;
    const d = Math.floor(Date.now() / 864e5);
    const mg = m.subarray(0, 8);
    if (!mg.equals(magic(d)) && !mg.equals(magic(d - 1))) return;
    const id = m.subarray(8, 40).toString('hex');
    const port = m.readUInt16BE(40);
    if (id === this.nb.id || this.nb.hasNeighbour(id) || this.dialing.has(id)) return;
    if (!(this.nb.id < id)) return;              // the lower key dials
    this.dialing.add(id);
    const sock = net.connect({ host: r.address, port });
    sock.once('connect', () => { this.dialing.delete(id); this._link(sock); });
    sock.once('error', () => this.dialing.delete(id));
    setTimeout(() => this.dialing.delete(id), 10000).unref?.();
  }

  _link(sock) {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.on('error', () => {});
    this.nb.addLink(sock, 'lan');
  }

  stop() {
    clearInterval(this.timer);
    try { this.udp && this.udp.close(); } catch (e) {}
    try { this.tcp && this.tcp.close(); } catch (e) {}
  }
}

module.exports = { LanCarrier, PORT, GROUP };
