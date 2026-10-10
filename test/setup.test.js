'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSetup, runSteps, buildSteps } = require('../src/install/setup');
const { getPaths } = require('../src/core/paths');
const { loadConfig } = require('../src/core/config');

const quietUi = () => {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, info: push, ok: push, warn: push, fail: push, table: (r) => push(JSON.stringify(r)), step: (n, t, title) => push(`[${n}/${t}] ${title}`), progressBar: () => ({ update() {}, done() {} }), confirm: async () => true };
};

const tmpPaths = () => getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-setup-')));
const fakeHw = () => ({
  os: 'linux', distro: 'Test', arch: 'x64', cpu: { model: 'x', cores: 4 }, ramGB: 16, freeDiskGB: 100,
  gpu: { vendor: 'nvidia', name: 'RTX Test', vramGB: 8, driver: '', cudaVersion: '12.8', computeCap: '8.6' }, source: [],
});
const detect = async () => fakeHw();

/** A stub step that records calls. */
function stub(id, { done = false, skip = null, readOnly = false, fail = false } = {}) {
  const s = { id, readOnly, calls: 0, title: () => `step ${id}`, isDone: async () => done, async run() { s.calls += 1; if (fail) throw new Error('boom'); return `v-${id}`; } };
  if (skip) s.skip = () => skip;
  return s;
}
const ctxFor = (paths, options = {}) => ({ options, paths, ui: quietUi(), log: null });

test('runner runs undone steps, skips done ones, records setup.json', async () => {
  const paths = tmpPaths();
  const [a, b] = [stub('a'), stub('b', { done: true })];
  const ctx = ctxFor(paths);
  const res = await runSteps([a, b], ctx);
  assert.equal(res.ok, true);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 0);
  assert.deepEqual(res.summary.steps.map((s) => s.status), ['ran', 'done']);
  const rec = JSON.parse(fs.readFileSync(paths.setupState, 'utf8')).steps;
  assert.equal(rec.a.version, 'v-a');
  assert.ok(rec.a.doneAt);
  assert.equal(rec.b, undefined);
});

test('runner stops at the first failure and says how to resume', async () => {
  const paths = tmpPaths();
  const [a, b, c] = [stub('a'), stub('b', { fail: true }), stub('c')];
  const ctx = ctxFor(paths);
  const res = await runSteps([a, b, c], ctx);
  assert.equal(res.ok, false);
  assert.equal(res.summary.failedStep, 'b');
  assert.equal(c.calls, 0);
  const text = ctx.ui.lines.join('\n');
  assert.match(text, /boom/);
  assert.match(text, /re-run `embernest setup`/);
});

test('dry-run runs only read-only steps and reports the rest', async () => {
  const paths = tmpPaths();
  const [d, a, b] = [stub('detect', { readOnly: true }), stub('a'), stub('b', { done: true })];
  const ctx = ctxFor(paths, { dryRun: true });
  const res = await runSteps([d, a, b], ctx);
  assert.equal(res.ok, true);
  assert.equal(d.calls, 1);
  assert.equal(a.calls, 0);
  assert.deepEqual(res.summary.steps.map((s) => s.status), ['ran', 'would-run', 'done']);
  assert.match(ctx.ui.lines.join('\n'), /step a: would run/);
  assert.match(ctx.ui.lines.join('\n'), /step b: already done/);
  assert.equal(fs.existsSync(paths.setupState), false);
});

test('skipped steps are reported and not run', async () => {
  const s = stub('uv', { skip: 'external engine' });
  const res = await runSteps([s], ctxFor(tmpPaths()));
  assert.equal(s.calls, 0);
  assert.equal(res.summary.steps[0].status, 'skipped');
});

test('real dry-run creates nothing and downloads nothing', async () => {
  const paths = tmpPaths();
  const ui = quietUi();
  const res = await runSetup({ dryRun: true, yes: true }, { paths, detect, ui, confirm: async () => assert.fail('no prompt in dry-run') });
  assert.equal(res.ok, true);
  assert.equal(res.summary.steps.length, 11);
  assert.deepEqual(fs.readdirSync(paths.home), []);
  assert.match(ui.lines.join('\n'), /Install uv \(Python manager\): would run/);
});

test('declining the prompt cancels without running steps', async () => {
  const paths = tmpPaths();
  const res = await runSetup({}, { paths, detect, ui: quietUi(), confirm: async () => false, steps: [buildSteps()[0], stub('x')] });
  assert.equal(res.ok, false);
  assert.equal(res.summary.cancelled, true);
});

test('external mode skips uv, python, torch and comfyui; --no-models skips models', async () => {
  const paths = tmpPaths();
  const comfyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ext-'));
  fs.writeFileSync(path.join(comfyDir, 'main.py'), '');
  const ui = quietUi();
  const res = await runSetup({ dryRun: true, comfyDir, models: false }, { paths, detect, ui });
  const status = Object.fromEntries(res.summary.steps.map((s) => [s.id, s.status]));
  for (const id of ['uv', 'python', 'torch', 'comfyui', 'models']) assert.equal(status[id], 'skipped', id);
  assert.equal(status.config, 'would-run');
});

test('external --comfy-dir without main.py fails validation', async () => {
  const comfyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ext-'));
  const res = await runSetup({ dryRun: true, comfyDir }, { paths: tmpPaths(), detect, ui: quietUi() });
  assert.equal(res.ok, false);
  assert.equal(res.summary.failedStep, 'detect');
});

test('config step writes external config, imports legacy tokens, keeps the token on re-run', async () => {
  const paths = tmpPaths();
  const comfyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ext-'));
  fs.writeFileSync(path.join(comfyDir, 'main.py'), '');
  const old = path.join(paths.home, 'old.json');
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ comfyUrl: 'http://x:1', sharedToken: 'legacy-token', tokens: { hf: 'hf-secret' } }));
  const opts = { yes: true, comfyDir, models: false, importConfig: old, port: 3456, lan: false };
  const deps = () => ({ paths, detect, ui: quietUi(), fetch: async () => ({ ok: true }), steps: buildSteps().filter((s) => ['detect', 'config', 'verify'].includes(s.id)) });

  const res = await runSetup(opts, deps());
  assert.equal(res.ok, true, JSON.stringify(res.summary));
  const cfg = loadConfig(paths);
  assert.equal(cfg.comfy.mode, 'external');
  assert.equal(cfg.comfy.dir, comfyDir);
  assert.equal(cfg.comfy.url, 'http://127.0.0.1:8188');
  assert.equal(cfg.authToken === 'legacy-token', true);
  assert.equal(cfg.tokens.hf === 'hf-secret', true);
  assert.equal(cfg.port, 3456);
  assert.equal(cfg.listenOnLan, false);
  assert.equal(cfg.hardware.tier, 'mid');

  const again = await runSetup(opts, deps());
  assert.deepEqual(again.summary.steps.map((s) => s.status), ['ran', 'done', 'ran']);
  assert.equal(loadConfig(paths).authToken === 'legacy-token', true);
});

test('config step generates a token when none exists', async () => {
  const paths = tmpPaths();
  const comfyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ext-'));
  fs.writeFileSync(path.join(comfyDir, 'main.py'), '');
  const steps = buildSteps().filter((s) => ['detect', 'config'].includes(s.id));
  await runSetup({ yes: true, comfyDir, models: false }, { paths, detect, ui: quietUi(), steps });
  assert.match(loadConfig(paths).authToken, /^[0-9a-f]{64}$/);
});

test('--gpu rejects an unknown vendor', async () => {
  await assert.rejects(runSetup({ gpu: 'banana' }, { paths: tmpPaths(), ui: quietUi() }), /--gpu/);
});

test('safety step: done only when the pinned revision is recorded; skipped for external without python', async () => {
  const paths = tmpPaths();
  const step = buildSteps().find((s) => s.id === 'safety');
  const manifest = require('../src/install/manifest').getManifest();
  const ctx = { options: {}, paths, manifest };
  assert.equal(await step.isDone(ctx), false);
  fs.mkdirSync(paths.run, { recursive: true });
  fs.writeFileSync(paths.setupState, JSON.stringify({ steps: { safety: { version: 'old' } } }));
  assert.equal(await step.isDone(ctx), false);
  fs.writeFileSync(paths.setupState, JSON.stringify({ steps: { safety: { version: manifest.safety.revision } } }));
  assert.equal(await step.isDone(ctx), true);
  assert.equal(step.skip(ctx), false);
  assert.match(step.skip({ ...ctx, options: { comfyDir: '/x' } }), /no Python/);
});
