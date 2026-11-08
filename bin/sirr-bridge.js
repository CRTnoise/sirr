#!/usr/bin/env node
'use strict';
/**
 * sirr-bridge — run a Sirr bridge: HyperDHT carried over WebSocket.
 *
 *   node bin/sirr-bridge.js [--port 49443] [--host 0.0.0.0]
 *
 * Put it behind a TLS reverse proxy (Caddy, nginx) on :443 with a real
 * domain, so to a network filter it is an ordinary HTTPS site that
 * happens to use a WebSocket. Then hand people the wss:// address — in
 * person, or with "Entry points in invites → DHT nodes + my bridge".
 *
 * A bridge needs no account and stores nothing. It sees client IPs and
 * when they're online, and carries end-to-end-encrypted traffic it can't
 * read. A free-tier VM or a home server with a forwarded port is enough.
 */
const DHT = require('hyperdht');
const { serveBridge } = require('../lib/pathways');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const port = Number(arg('port', 49443));
const host = arg('host', '0.0.0.0');

(async () => {
  const dht = new DHT();
  await dht.ready();
  const wss = serveBridge(dht, { port, host });
  let clients = 0;
  wss.on('connection', (s) => { clients++; s.on('close', () => clients--); });
  wss.on('listening', () => console.log('sirr-bridge on ws://' + host + ':' + port + ' (put TLS in front of it)'));
  setInterval(() => console.log(new Date().toISOString(), 'clients:', clients), 600000).unref();
  const stop = async () => { wss.close(); await dht.destroy(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})();
