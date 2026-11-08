'use strict';
/**
 * Nearby over Bluetooth LE — experimental.
 * ═══════════════════════════════════════════════════════════════════
 * Each device is both a peripheral (advertises the Sirr service, accepts
 * links on a GATT RX/TX pair) and a central (scans for the service and
 * connects). Every BLE connection becomes one mesh link (lib/nearby.js);
 * the mesh floods beacons hop by hop, so a crowd of phones and laptops
 * running Sirr forms a network that reaches far beyond one radio's range.
 *
 * Desktop BLE needs native modules that are not bundled (they differ per
 * OS and need system permissions): `@abandonware/noble` (central) and
 * `@abandonware/bleno` (peripheral). Install them next to Sirr to enable
 * this carrier; without them it reports itself unavailable and nothing
 * else changes. The advertisement carries only the service UUID and 8
 * bytes of this launch's random node key (to decide who dials).
 * Throughput is low (tens of kB/s): enough for text, not for voice.
 */
const { Duplex } = require('stream');

const SERVICE = '5a1f0001a0b14c4e9e6b53495252ff01';
const RX = '5a1f0002a0b14c4e9e6b53495252ff01';    // central → peripheral (write)
const TX = '5a1f0003a0b14c4e9e6b53495252ff01';    // peripheral → central (notify)
const CHUNK = 180;

function tryRequire(n) { try { return require(n); } catch (e) { return null; } }

class BleLink extends Duplex {
  constructor(write) { super(); this._w = write; }
  _write(chunk, enc, cb) {
    (async () => {
      for (let i = 0; i < chunk.length; i += CHUNK) await this._w(chunk.subarray(i, i + CHUNK));
    })().then(() => cb(), (e) => cb(e));
  }
  _read() {}
}

class BleCarrier {
  static available() { return !!(tryRequire('@abandonware/noble') || tryRequire('@abandonware/bleno')); }

  constructor(nearby) {
    this.nb = nearby;
    this.noble = tryRequire('@abandonware/noble');
    this.bleno = tryRequire('@abandonware/bleno');
    this.links = new Map();          // peripheral uuid / central address -> stream
    this.state = 'off';
  }

  start() {
    if (!this.noble && !this.bleno) { this.state = 'unavailable'; return this; }
    const tag = this.nb.keyPair.publicKey.subarray(0, 8);
    if (this.bleno) this._peripheral(tag);
    if (this.noble) this._central(tag);
    this.state = 'starting';
    return this;
  }

  _peripheral(tag) {
    const b = this.bleno;
    const self = this;
    let central = null;     // bleno serves one central at a time per adapter
    const rx = new b.Characteristic({
      uuid: RX, properties: ['write', 'writeWithoutResponse'],
      onWriteRequest(data, offset, withoutResponse, cb) { if (central) central.push(Buffer.from(data)); cb(this.RESULT_SUCCESS); },
    });
    const tx = new b.Characteristic({
      uuid: TX, properties: ['notify'],
      onSubscribe(maxSize, notify) {
        central = new BleLink(async (c) => notify(c));
        self.nb.addLink(central, 'ble');
      },
      onUnsubscribe() { if (central) { central.destroy(); central = null; } },
    });
    b.on('stateChange', (s) => {
      if (s === 'poweredOn') {
        b.startAdvertising('', [SERVICE]);
        try { b.startAdvertisingWithEIRData?.(Buffer.concat([Buffer.from([0x0b, 0x16, 0x01, 0xff]), tag])); } catch (e) {}
        this.state = 'on';
      } else b.stopAdvertising();
    });
    b.on('advertisingStart', (err) => { if (!err) b.setServices([new b.PrimaryService({ uuid: SERVICE, characteristics: [rx, tx] })]); });
    b.on('disconnect', () => { if (central) { central.destroy(); central = null; } });
  }

  _central() {
    const n = this.noble;
    n.on('stateChange', (s) => { if (s === 'poweredOn') n.startScanning([SERVICE], true); else n.stopScanning(); });
    n.on('discover', (p) => {
      if (this.links.has(p.uuid) || this.links.size >= 6) return;
      this.links.set(p.uuid, null);
      p.connect((err) => {
        if (err) { this.links.delete(p.uuid); return; }
        p.discoverSomeServicesAndCharacteristics([SERVICE], [RX, TX], (e2, _s, chars) => {
          const rx = chars && chars.find(c => c.uuid === RX), tx = chars && chars.find(c => c.uuid === TX);
          if (e2 || !rx || !tx) { p.disconnect(); this.links.delete(p.uuid); return; }
          const link = new BleLink((c) => new Promise((res) => rx.write(c, true, () => res())));
          tx.on('data', (d) => link.push(Buffer.from(d)));
          tx.subscribe(() => {});
          this.links.set(p.uuid, link);
          this.nb.addLink(link, 'ble');
          p.once('disconnect', () => { link.destroy(); this.links.delete(p.uuid); });
        });
      });
    });
  }

  stop() {
    try { this.noble && this.noble.stopScanning(); } catch (e) {}
    try { this.bleno && this.bleno.stopAdvertising(); } catch (e) {}
    for (const l of this.links.values()) { try { l && l.destroy(); } catch (e) {} }
    this.links.clear();
  }
}

module.exports = { BleCarrier, SERVICE };
