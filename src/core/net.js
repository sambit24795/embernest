'use strict';
const net = require('node:net');
const os = require('node:os');

/** Virtual/container interfaces that never carry a phone's traffic. */
const SKIP_IFACE = /^(docker|br-|veth|virbr|tun|tap|wg|podman|zt)/i;
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/**
 * External IPv4 addresses of this machine (for the "open on your phone" hint).
 * @returns {Array<{ iface: string, address: string }>}
 */
function getLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    if (SKIP_IFACE.test(name)) continue;
    for (const entry of nets[name] || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        ips.push({ iface: name, address: entry.address });
      }
    }
  }
  return ips;
}

/**
 * True when a port can be bound right now. Any bind error counts as "not free".
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * True for IPv4 127.0.0.0/8, IPv6 ::1 and IPv4-mapped 127.x addresses.
 * @param {unknown} address
 * @returns {boolean}
 */
function isLoopback(address) {
  return typeof address === 'string' && LOOPBACK.test(address);
}

module.exports = { getLanIps, isPortFree, isLoopback };
