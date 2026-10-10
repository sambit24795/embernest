'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { getLanIps, isPortFree, isLoopback } = require('../src/core/net');

test('isLoopback accepts 127/8, ::1 and mapped 127.x', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.strictEqual(isLoopback(address), true, address);
  }
});

test('isLoopback rejects LAN, public and malformed addresses', () => {
  for (const address of ['10.1.2.5', '10.0.0.1', '::2', '::ffff:10.1.2.5', '1270.0.0.1', '', null]) {
    assert.strictEqual(isLoopback(address), false, String(address));
  }
});

test('isPortFree is false while a port is bound and true after it is released', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.strictEqual(await isPortFree(port, '127.0.0.1'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.strictEqual(await isPortFree(port, '127.0.0.1'), true);
});

test('getLanIps returns only non-internal IPv4 entries with iface and address', () => {
  for (const ip of getLanIps()) {
    assert.strictEqual(typeof ip.iface, 'string');
    assert.match(ip.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.doesNotMatch(ip.iface, /^(docker|br-|veth|virbr|tun|tap|wg|podman|zt)/i);
    assert.notStrictEqual(ip.address.split('.')[0], '127');
  }
});
