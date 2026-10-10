'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { getPaths } = require('../src/core/paths');
const { saveConfig } = require('../src/core/config');
const { createApp } = require('../src/server/app');
const { hostnameOf } = require('../src/server/auth');
const { startFakeComfy } = require('./helpers/fake-comfy');

const TOKEN = 'good-token-0123456789';
const HARDWARE = {
  os: 'linux', distro: 'Test', arch: 'x64', cpu: { model: 'T', cores: 4 }, ramGB: 16, freeDiskGB: 100,
  gpu: { vendor: 'nvidia', name: 'Fake', vramGB: 6, driver: '', cudaVersion: '12.8', computeCap: '7.5' }, source: [],
};

/** App that treats 127.0.0.1 clients as phones (trustLoopback: false). */
async function setup(t, { trustLoopback = false, allowedHosts = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-auth-'));
  const fake = await startFakeComfy();
  const paths = getPaths(home);
  saveConfig(paths, { authToken: TOKEN, allowedHosts, comfy: { url: fake.url } });
  const server = createApp({ paths, hardware: HARDWARE, trustLoopback, safety: { check: async () => ({ nsfwScore: 0, blocked: false }), close() {} } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { port: server.address().port, base: `http://127.0.0.1:${server.address().port}` };
}

/** fetch cannot set Host, so use http.request for host-header tests. */
function rawGet(port, host, urlPath = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('hostnameOf strips ports, lowercases and handles IPv6', () => {
  assert.equal(hostnameOf('Pc.LOCAL:3000'), 'pc.local');
  assert.equal(hostnameOf('[::1]:3300'), '[::1]');
  assert.equal(hostnameOf('[::1]'), '[::1]');
  assert.equal(hostnameOf('127.0.0.1'), '127.0.0.1');
  assert.equal(hostnameOf(undefined), '');
});

test('Host check: unknown host is 421, known hosts pass (static files too)', async (t) => {
  const { port } = await setup(t, { allowedHosts: ['Extra.Example'] });
  assert.equal(await rawGet(port, 'evil.com'), 421);
  assert.equal(await rawGet(port, 'evil.com', '/index.html'), 421);
  assert.equal(await rawGet(port, `127.0.0.1:${port}`), 200);
  assert.equal(await rawGet(port, `LOCALHOST:${port}`), 200);
  assert.equal(await rawGet(port, `[::1]:${port}`), 200);
  assert.equal(await rawGet(port, 'my-box.tail1234.ts.net'), 200);
  assert.equal(await rawGet(port, 'extra.example:80'), 200);
});

test('non-loopback: 401 without token, 200 with cookie, header or bearer; ?token= refused', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Unauthorized', pair: true });
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: `pk_auth=${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'X-PixelKiln-Token': TOKEN } })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'X-Embernest-Token': TOKEN } })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { 'X-Ember-Token': TOKEN } })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: 'pk_auth=wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/status?token=${TOKEN}`)).status, 401);
});

test('GET /api/health stays open', async (t) => {
  const { base } = await setup(t);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('loopback is trusted by default', async (t) => {
  const { base } = await setup(t, { trustLoopback: true });
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
});

test('/pair sets a strict HttpOnly cookie and redirects; bad token is 401', async (t) => {
  const { base } = await setup(t);
  const ok = await fetch(`${base}/pair?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/');
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /pk_auth=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/);
  const https = await fetch(`${base}/pair?token=${TOKEN}`, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers.get('set-cookie'), /Secure/);
  assert.equal((await fetch(`${base}/pair?token=nope`, { redirect: 'manual' })).status, 401);
});

test('logout clears the cookie', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: `pk_auth=${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

test('11 bad attempts are rate limited (429), even for a later good token', async (t) => {
  const { base } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`)).status, 429);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: `pk_auth=${TOKEN}` } })).status, 429);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('POST with a foreign Origin is 403; a same-host Origin passes', async (t) => {
  const { base, port } = await setup(t);
  const headers = { Cookie: `pk_auth=${TOKEN}`, 'Content-Type': 'application/json' };
  const bad = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.com' } });
  assert.equal(bad.status, 403);
  const good = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { ...headers, Origin: `http://127.0.0.1:${port}` } });
  assert.notEqual(good.status, 403);
  const none = await fetch(`${base}/api/interrupt`, { method: 'POST', headers });
  assert.notEqual(none.status, 403);
});

test('loopback requests skip the token but not the Origin check', async (t) => {
  const { base, port } = await setup(t, { trustLoopback: true });
  const form = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { Origin: 'http://evil.com' } });
  assert.equal(form.status, 403);
  const same = await fetch(`${base}/api/interrupt`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.notEqual(same.status, 403);
  const cli = await fetch(`${base}/api/interrupt`, { method: 'POST' });
  assert.notEqual(cli.status, 403);
});

test('proxied loopback requests (tailscale serve, nginx) still need the token', async (t) => {
  const { base, port } = await setup(t, { trustLoopback: true });
  const direct = await fetch(`${base}/api/status`);
  assert.notEqual(direct.status, 401);
  const viaTs = await rawGet(port, 'pc.tail1234.ts.net', '/api/status');
  assert.equal(viaTs, 401);
  const forwarded = await fetch(`${base}/api/status`, { headers: { 'X-Forwarded-For': '100.64.0.7' } });
  assert.equal(forwarded.status, 401);
  const paired = await fetch(`${base}/api/status`, { headers: { 'X-Forwarded-For': '100.64.0.7', Cookie: `pk_auth=${TOKEN}` } });
  assert.notEqual(paired.status, 401);
});
