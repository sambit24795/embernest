'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = require('../src/core/config');
const { getPaths } = require('../src/core/paths');

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-config-'));
  return { dir, paths: getPaths(dir) };
}

test('loadConfig returns defaults and writes nothing when there is no file', () => {
  const { dir, paths } = tempPaths();
  try {
    assert.deepStrictEqual(cfg.loadConfig(paths), cfg.DEFAULTS);
    assert.strictEqual(fs.existsSync(paths.config), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig then loadConfig round-trips the patch', () => {
  const { dir, paths } = tempPaths();
  try {
    cfg.saveConfig(paths, { port: 4321, authToken: 'abc' });
    const back = cfg.loadConfig(paths);
    assert.strictEqual(back.port, 4321);
    assert.strictEqual(back.authToken, 'abc');
    assert.strictEqual(back.comfy.url, cfg.DEFAULTS.comfy.url);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('arrays replace instead of merging', () => {
  const { dir, paths } = tempPaths();
  try {
    cfg.saveConfig(paths, { comfy: { args: ['--lowvram', '--fp32-vae'] } });
    cfg.saveConfig(paths, { comfy: { args: ['--novram'] } });
    assert.deepStrictEqual(cfg.loadConfig(paths).comfy.args, ['--novram']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveConfig leaves no .tmp file behind', () => {
  const { dir, paths } = tempPaths();
  try {
    cfg.saveConfig(paths, { port: 1 });
    assert.strictEqual(fs.existsSync(`${paths.config}.tmp`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config file is mode 0600 on POSIX', { skip: process.platform === 'win32' }, () => {
  const { dir, paths } = tempPaths();
  try {
    cfg.saveConfig(paths, { port: 1 });
    assert.strictEqual(fs.statSync(paths.config).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig returns a copy: mutating it does not change DEFAULTS', () => {
  const { dir, paths } = tempPaths();
  try {
    const loaded = cfg.loadConfig(paths);
    loaded.comfy.args.push('--x');
    loaded.tokens.hf = 'leak';
    assert.deepStrictEqual(cfg.DEFAULTS.comfy.args, []);
    assert.strictEqual(cfg.DEFAULTS.tokens.hf, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateLegacy maps the v0.1 shape (flat keys + sharedToken)', () => {
  // A v0.1-style config, plus a sharedToken and a removed restart key.
  const legacy = {
    comfyUrl: 'http://127.0.0.1:8188',
    port: 3000,
    listenOnLan: true,
    comfyRestartCommand: '',
    allowComfyRestart: false,
    sharedToken: 'f'.repeat(64),
    tokens: { civitai: '', hf: '', modelscope: '', github: '' }, // old files still carry these
    defaults: { denoise: 0.9, steps: 28, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', seed: -1, maxSize: 768, preserveFace: true, restoreSize: true },
  };
  const next = cfg.migrateLegacy(legacy);
  assert.strictEqual(next.comfy.url, 'http://127.0.0.1:8188');
  assert.strictEqual(next.authToken, 'f'.repeat(64));
  assert.strictEqual(next.port, 3000);
  assert.strictEqual(next.listenOnLan, true);
  assert.strictEqual(next.defaults.denoise, 0.9);
  assert.strictEqual(next.comfy.mode, 'managed');
  assert.strictEqual('comfyUrl' in next, false);
  assert.strictEqual('sharedToken' in next, false);
  assert.strictEqual('comfyRestartCommand' in next, false);
  assert.strictEqual('allowComfyRestart' in next, false);
});

test('generateToken returns 64 hex characters, different each call', () => {
  const a = cfg.generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, cfg.generateToken());
});

test('redact hides authToken and tokens.* without changing other values', () => {
  const config = cfg.migrateLegacy({ sharedToken: 'secret', tokens: { hf: 'hf-secret', civitai: '' } });
  const out = cfg.redact(config);
  assert.strictEqual(out.authToken, 'set');
  assert.strictEqual(out.tokens.hf, 'set');
  assert.strictEqual(out.tokens.civitai, 'not set');
  assert.strictEqual(out.port, 3000);
  assert.strictEqual(JSON.stringify(out).includes('hf-secret'), false);
  assert.strictEqual(JSON.stringify(out).includes('"secret"'), false);
  assert.strictEqual(cfg.redact(cfg.DEFAULTS).authToken, 'not set');
});

test('config set allow-list accepts only the documented keys', () => {
  for (const key of ['port', 'listenOnLan', 'allowedHosts', 'comfy.args', 'defaults.steps', 'tokens.civitai']) {
    assert.equal(cfg.isSettableKey(key), true, key);
  }
  for (const key of ['authToken', 'comfy.url', 'comfy.dir', 'defaults.nope', 'tokens', 'tokens.civitai.x', 'configVersion', '']) {
    assert.equal(cfg.isSettableKey(key), false, key);
  }
});

test('dotted keys read and build nested patches', () => {
  const obj = { comfy: { url: 'http://x', args: ['--lowvram'] }, port: 3000 };
  assert.equal(cfg.getByPath(obj, 'comfy.url'), 'http://x');
  assert.equal(cfg.getByPath(obj, 'comfy.nope.deeper'), undefined);
  assert.deepEqual(cfg.patchFromPath('defaults.steps', 5), { defaults: { steps: 5 } });
  assert.deepEqual(cfg.patchFromPath('port', 3300), { port: 3300 });
});

test('parseSettingValue turns typed text into the right type', () => {
  assert.equal(cfg.parseSettingValue('port', '3300'), 3300);
  assert.equal(cfg.parseSettingValue('listenOnLan', 'false'), false);
  assert.equal(cfg.parseSettingValue('defaults.cfg', '6.5'), 6.5);
  assert.equal(cfg.parseSettingValue('tokens.hf', '123'), '123');
  assert.deepEqual(cfg.parseSettingValue('comfy.args', '["--lowvram","--fp32-vae"]'), ['--lowvram', '--fp32-vae']);
  assert.deepEqual(cfg.parseSettingValue('allowedHosts', 'a.ts.net, b.ts.net,'), ['a.ts.net', 'b.ts.net']);
  assert.deepEqual(cfg.parseSettingValue('allowedHosts', '[]'), []);
});

test('parseSettingValue rejects values that do not fit the key', () => {
  assert.throws(() => cfg.parseSettingValue('port', 'abc'), /port must be a number/);
  assert.throws(() => cfg.parseSettingValue('port', '70000'), /1 to 65535/);
  assert.throws(() => cfg.parseSettingValue('port', '3000.5'), /1 to 65535/);
  assert.throws(() => cfg.parseSettingValue('listenOnLan', 'yes'), /must be a boolean/);
  assert.throws(() => cfg.parseSettingValue('defaults.steps', 'NaN'), /must be a number/);
  assert.throws(() => cfg.parseSettingValue('comfy.args', '[1,2]'), /list of strings/);
  assert.throws(() => cfg.parseSettingValue('comfy.args', '[oops'), /JSON array/);
});

test('DEFAULTS has the chat block, and a saved partial chat block keeps the other defaults', () => {
  const { DEFAULTS, loadConfig, saveConfig } = require('../src/core/config');
  const { getPaths } = require('../src/core/paths');
  assert.deepStrictEqual(DEFAULTS.chat, {
    enabled: false, model: '', thinkModel: '', port: 8189, url: 'http://127.0.0.1:8189', device: 'auto',
    contextSize: 8192, threads: 0, search: { provider: 'auto', searxngUrl: '' },
  });
  const paths = getPaths(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pk-cfg-')));
  saveConfig(paths, { chat: { enabled: true, model: 'qwen3-4b' } });
  const cfg = loadConfig(paths);
  assert.strictEqual(cfg.chat.enabled, true);
  assert.strictEqual(cfg.chat.port, 8189);
  assert.strictEqual(cfg.chat.search.provider, 'auto');
});

test('old configs with modelscope/github tokens still load and keep those values', () => {
  const { dir, paths } = tempPaths();
  try {
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.writeFileSync(paths.config, JSON.stringify({ tokens: { civitai: 'c', modelscope: 'm', github: 'g' } }));
    const loaded = cfg.loadConfig(paths);
    assert.strictEqual(loaded.tokens.civitai, 'c');
    assert.strictEqual(loaded.tokens.modelscope, 'm');
    assert.strictEqual(loaded.tokens.hf, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
