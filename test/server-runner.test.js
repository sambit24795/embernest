'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { bannerLines, pairingUrl, pairingUrlFromBase, baseUrlOf, firewallHint } = require('../src/runtime/server-runner');

const cfg = {
  port: 3300, listenOnLan: true, authToken: 'a'.repeat(64),
  comfy: { mode: 'managed', version: 'v0.39.0', url: 'http://127.0.0.1:18188' },
  hardware: { gpu: { name: 'Test GPU' } },
};

test('banner lists URLs, engine and GPU but never the token', () => {
  const text = bannerLines(cfg, [{ iface: 'eth0', address: '10.1.2.5' }], 'linux').join('\n');
  assert.match(text, /http:\/\/127\.0\.0\.1:3300/);
  assert.match(text, /http:\/\/10\.1\.2\.5:3300/);
  assert.match(text, /ComfyUI v0\.39\.0/);
  assert.match(text, /Test GPU/);
  assert.match(text, /ufw allow 3300\/tcp/);
  assert.ok(!text.includes(cfg.authToken));
});

test('banner without LAN has no network URLs or firewall hint', () => {
  const text = bannerLines({ ...cfg, listenOnLan: false }, [{ iface: 'eth0', address: '10.1.2.5' }], 'linux').join('\n');
  assert.match(text, /LAN access is off/);
  assert.ok(!text.includes('10.1.2.5'));
  assert.ok(!/firewall/i.test(text));
});

test('pairing URL carries the token; firewall hints exist per OS', () => {
  assert.strictEqual(pairingUrl('10.0.0.2', 3000, 'abc'), 'http://10.0.0.2:3000/pair?token=abc');
  assert.match(firewallHint(3000, 'win32').join(' '), /New-NetFirewallRule/);
  assert.match(firewallHint(3000, 'darwin').join(' '), /System Settings/);
});

test('pair --url: base URL is reduced to its origin and must be http(s)', () => {
  assert.strictEqual(baseUrlOf('https://pc.tail1234.ts.net/'), 'https://pc.tail1234.ts.net');
  assert.strictEqual(pairingUrlFromBase('https://pc.tail1234.ts.net', 'abc'), 'https://pc.tail1234.ts.net/pair?token=abc');
  assert.throws(() => baseUrlOf('ftp://pc'), /http/);
  assert.throws(() => baseUrlOf('not a url'), /not a valid URL/);
});
