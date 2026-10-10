'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { getPaths } = require('../src/core/paths');
const { saveConfig } = require('../src/core/config');
const { writeJson } = require('../src/core/state');
const { readTail, followFile } = require('../src/runtime/logs');
const { collectStatus, stopServer, dirSize } = require('../src/runtime/status');
const { formatBytes, formatUptime } = require('../src/cli/commands/status');

/** A fresh EMBERNEST_HOME-style folder with its paths. */
function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-status-'));
  return { dir, paths: getPaths(dir) };
}

test('readTail returns the last N lines of a file', () => {
  const { dir } = tempHome();
  const file = path.join(dir, 'log.txt');
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.deepStrictEqual(readTail(file, 3), ['line 248', 'line 249', 'line 250']);
  assert.strictEqual(readTail(file, 1000).length, 250);
  assert.deepStrictEqual(readTail(file, 0), []);
  assert.deepStrictEqual(readTail(path.join(dir, 'missing.log'), 5), []);
});

test('followFile prints only lines appended after it starts', async () => {
  const { dir } = tempHome();
  const file = path.join(dir, 'follow.log');
  fs.writeFileSync(file, 'old\n');
  let seen = '';
  const stop = followFile(file, (text) => { seen += text; }, { interval: 20 });
  try {
    // fs.watchFile takes its baseline on the first poll; wait for it before appending.
    await new Promise((r) => setTimeout(r, 100));
    fs.appendFileSync(file, 'new one\n');
    for (let i = 0; i < 100 && !seen.includes('new one'); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    stop();
  }
  assert.strictEqual(seen, 'new one\n');
});

test('collectStatus with nothing running reports not running and no secrets', async () => {
  const { dir, paths } = tempHome();
  const token = 'f'.repeat(64);
  saveConfig(paths, { authToken: token, tokens: { hf: 'hf_secret' } });
  fs.mkdirSync(paths.models, { recursive: true });
  fs.writeFileSync(path.join(paths.models, 'a.safetensors'), Buffer.alloc(1000));

  const status = await collectStatus(paths);
  assert.strictEqual(status.running, false);
  assert.strictEqual(status.pid, null);
  assert.strictEqual(status.engine.state, 'stopped');
  assert.strictEqual(status.disk.modelsBytes, 1000);
  assert.deepStrictEqual(status.chat, { enabled: false, model: null, device: null, port: 8189, state: 'off' });
  assert.strictEqual(status.dataFolder, dir);
  const text = JSON.stringify(status);
  assert.ok(!text.includes(token));
  assert.ok(!text.includes('hf_secret'));
  assert.ok(!('authToken' in status));
});

test('collectStatus ignores a stale state file whose pid is gone', async () => {
  const { paths } = tempHome();
  writeJson(paths.state, { pid: 2147483646, port: 3300, startedAt: new Date().toISOString(), version: '0' });
  const status = await collectStatus(paths);
  assert.strictEqual(status.running, false);
});

test('stopServer with no state says not running and succeeds', async () => {
  const { paths } = tempHome();
  assert.deepStrictEqual(await stopServer(paths), { status: 'not-running', pid: null });
});

test('stopServer never signals a live pid that is not a Embernest server', async () => {
  const { paths } = tempHome();
  // This test process is alive, but nothing answers /api/health on port 1.
  writeJson(paths.state, { pid: process.pid, port: 1, startedAt: new Date().toISOString(), version: '0' });
  const result = await stopServer(paths);
  assert.strictEqual(result.status, 'not-running');
  assert.strictEqual(fs.existsSync(paths.state), false);
});

test('stopServer stops a running server process and removes its state', async () => {
  const { paths } = tempHome();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const api = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = api.address();
    writeJson(paths.state, { pid: child.pid, port, startedAt: new Date().toISOString(), version: 'test' });
    assert.strictEqual((await collectStatus(paths)).running, true);
    const result = await stopServer(paths, { timeoutMs: 10000 });
    assert.deepStrictEqual(result, { status: 'stopped', pid: child.pid });
    assert.strictEqual(fs.existsSync(paths.state), false);
  } finally {
    api.close();
    child.kill();
  }
});

test('dirSize sums nested files and is 0 for a missing folder', () => {
  const { dir } = tempHome();
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'x.bin'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, 'a', 'b', 'y.bin'), Buffer.alloc(5));
  assert.strictEqual(dirSize(path.join(dir, 'a')), 15);
  assert.strictEqual(dirSize(path.join(dir, 'nope')), 0);
});

test('human formatting for bytes and uptime', () => {
  assert.strictEqual(formatBytes(1024 * 1024 * 1536), '1.5 GB');
  assert.strictEqual(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.strictEqual(formatUptime(null), '-');
  assert.strictEqual(formatUptime(65), '1m 05s');
  assert.strictEqual(formatUptime(3725), '1h 02m');
});

test('collectStatus reports the chat row: stopped while Embernest is down, with model and device', async () => {
  const { paths } = tempHome();
  saveConfig(paths, {
    chat: { enabled: true, model: 'qwen3-4b' },
    hardware: { os: 'linux', arch: 'x64', ramGB: 16, gpu: { vendor: 'nvidia', name: 'x', vramGB: 6 } },
  });
  const { chat } = await collectStatus(paths);
  assert.deepStrictEqual(chat, { enabled: true, model: 'qwen3-4b', device: 'cpu', port: 8189, state: 'stopped' });
});
