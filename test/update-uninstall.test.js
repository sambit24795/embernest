'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getPaths } = require('../src/core/paths');
const { loadConfig, saveConfig } = require('../src/core/config');
const { updateEngine } = require('../src/cli/commands/update');
const { uninstall } = require('../src/cli/commands/uninstall');

const TAG_OLD = 'v0.1.0';
const manifest = { comfyui: { tag: 'v0.2.0' } };

/** A throwaway home with dummy folders matching the real layout. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-uu-'));
  const paths = getPaths(home);
  for (const d of [paths.models + '/checkpoints', paths.output, paths.input, paths.venv, paths.logs,
    paths.run, paths.tools, paths.cache, path.join(paths.comfyRoot, TAG_OLD)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(paths.models, 'checkpoints', 'm.safetensors'), 'model');
  fs.writeFileSync(path.join(paths.output, 'a.png'), 'img');
  fs.writeFileSync(path.join(paths.venv, 'x'), 'x');
  fs.writeFileSync(path.join(paths.logs, 'embernest.log'), 'log');
  saveConfig(paths, { authToken: 'a'.repeat(64), comfy: { mode: 'managed', dir: path.join(paths.comfyRoot, TAG_OLD), version: TAG_OLD, args: ['--lowvram'] } });
  return paths;
}
const quiet = { stop: async () => ({ status: 'not-running', pid: null }) };

test('uninstall --keep-models leaves only data/models', async () => {
  const paths = makeHome();
  assert.equal(await uninstall(paths, { keepModels: true }, { ...quiet, confirm: async () => true }), true);
  assert.deepEqual(fs.readdirSync(paths.home), ['data']);
  assert.deepEqual(fs.readdirSync(paths.data), ['models']);
  assert.ok(fs.existsSync(path.join(paths.models, 'checkpoints', 'm.safetensors')));
});

test('uninstall --keep-models --keep-outputs keeps both', async () => {
  const paths = makeHome();
  await uninstall(paths, { keepModels: true, keepOutputs: true }, { ...quiet, confirm: async () => true });
  assert.deepEqual(fs.readdirSync(paths.data).sort(), ['models', 'output']);
  assert.deepEqual(fs.readdirSync(paths.home), ['data']);
});

test('uninstall without keep flags removes the whole home', async () => {
  const paths = makeHome();
  await uninstall(paths, {}, { ...quiet, confirm: async () => true });
  assert.equal(fs.existsSync(paths.home), false);
});

test('uninstall does nothing when not confirmed', async () => {
  const paths = makeHome();
  let stopped = false;
  const done = await uninstall(paths, {}, { confirm: async () => false, stop: async () => { stopped = true; return { status: 'stopped' }; } });
  assert.equal(done, false);
  assert.equal(stopped, false);
  assert.ok(fs.existsSync(paths.config));
});

test('uninstall does not delete when the server will not stop', async () => {
  const paths = makeHome();
  await assert.rejects(uninstall(paths, {}, { confirm: async () => true, stop: async () => ({ status: 'timeout', pid: 1 }) }), /did not stop/);
  assert.ok(fs.existsSync(paths.config));
});

test('update engine: same tag is a no-op', async () => {
  const paths = makeHome();
  const res = await updateEngine(paths, { manifest: { comfyui: { tag: TAG_OLD } }, install: async () => { throw new Error('no'); } });
  assert.equal(res.status, 'up-to-date');
});

test('update engine: success switches config and removes the old folder', async () => {
  const paths = makeHome();
  const calls = [];
  const res = await updateEngine(paths, {
    manifest,
    running: async () => false,
    install: async (p, uv, o) => {
      calls.push(['install', o.tag]);
      const d = path.join(p.comfyRoot, o.tag);
      fs.mkdirSync(d);
      return d;
    },
    verify: async (p, d, args) => { calls.push(['verify', path.basename(d), args]); },
  });
  assert.equal(res.status, 'updated');
  assert.deepEqual(calls, [['install', 'v0.2.0'], ['verify', 'v0.2.0', ['--lowvram']]]);
  const cfg = loadConfig(paths);
  assert.equal(cfg.comfy.version, 'v0.2.0');
  assert.equal(cfg.comfy.dir, path.join(paths.comfyRoot, 'v0.2.0'));
  assert.equal(fs.existsSync(path.join(paths.comfyRoot, TAG_OLD)), false);
});

test('update engine: failed verify keeps the old config and folder', async () => {
  const paths = makeHome();
  await assert.rejects(updateEngine(paths, {
    manifest,
    running: async () => false,
    install: async (p, uv, o) => { const d = path.join(p.comfyRoot, o.tag); fs.mkdirSync(d); return d; },
    verify: async () => { throw new Error('smoke test failed'); },
  }), /smoke test failed/);
  const cfg = loadConfig(paths);
  assert.equal(cfg.comfy.version, TAG_OLD);
  assert.ok(fs.existsSync(path.join(paths.comfyRoot, TAG_OLD)));
});

test('update engine: asks before stopping a running server', async () => {
  const paths = makeHome();
  let installed = false;
  const res = await updateEngine(paths, {
    manifest, running: async () => true, confirmStop: async () => false,
    install: async () => { installed = true; },
  });
  assert.equal(res.status, 'cancelled');
  assert.equal(installed, false);
});

test('update engine: external mode is left alone', async () => {
  const paths = makeHome();
  saveConfig(paths, { comfy: { mode: 'external' } });
  assert.equal((await updateEngine(paths, { manifest })).status, 'external');
});
