'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sg = require('../src/server/suggestions');
const { FAMILIES: META_FAMILIES } = require('../src/server/model-meta');
const { FOLDER_BY_TYPE } = require('../src/server/downloads');
const { tierId } = require('../src/core/tiers');
const { planModels } = require('../src/install/models');
const { getManifest } = require('../src/install/manifest');
const { runSetup } = require('../src/install/setup');
const { getPaths } = require('../src/core/paths');

const { goals, suggestions } = sg.loadSuggestions();

test('every suggestion has the required fields and valid values', () => {
  const ids = new Set();
  for (const e of suggestions) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(sg.GOALS.includes(e.goal), `${e.id} goal`);
    assert.ok(sg.TYPES.includes(e.type) && FOLDER_BY_TYPE[e.type], `${e.id} type`);
    assert.ok(sg.FAMILIES.includes(e.family) && META_FAMILIES.includes(e.family), `${e.id} family`);
    assert.ok(sg.TIER_ORDER.includes(e.minTier), `${e.id} minTier`);
    for (const k of ['name', 'what', 'howToUse', 'license', 'fileName']) {
      assert.ok(typeof e[k] === 'string' && e[k].trim(), `${e.id} ${k}`);
    }
    assert.ok(['civitai', 'huggingface'].includes(e.provider), `${e.id} provider`);
    for (const k of ['homeUrl', 'downloadUrl']) assert.match(e[k], /^https:\/\//, `${e.id} ${k}`);
    assert.ok(e.sizeMB > 0, `${e.id} sizeMB`);
    assert.equal(e.nsfw, false, `${e.id} nsfw`);
    assert.equal(typeof e.needsToken, 'boolean', `${e.id} needsToken`);
    if (e.sha256) assert.match(e.sha256, /^[0-9a-f]{64}$/, `${e.id} sha256`);
    assert.ok(!JSON.stringify(e).includes('VERIFY'), `${e.id} VERIFY`);
    assert.ok(path.basename(e.fileName) === e.fileName, `${e.id} fileName is a plain name`);
  }
});

test('every goal has a label and at least 2 entries for SD 1.5 and for SDXL', () => {
  assert.deepEqual(Object.keys(goals).sort(), [...sg.GOALS].sort());
  for (const goal of sg.GOALS) {
    for (const family of ['sd15', 'sdxl']) {
      const n = suggestions.filter((e) => e.goal === goal && e.family === family).length;
      assert.ok(n >= 2, `${goal}/${family} has ${n}`);
    }
  }
});

test('edit-photos entries are inpainting checkpoints', () => {
  for (const e of suggestions.filter((s) => s.goal === 'edit-photos')) {
    assert.equal(e.type, 'checkpoint');
    assert.equal(e.inpainting, true);
  }
});

test('forTier: low machines see only SD 1.5 entries, mid and up see SDXL too', () => {
  const low = sg.forTier(suggestions, 'low');
  assert.ok(low.length > 0 && low.every((e) => e.family === 'sd15'));
  assert.ok(sg.forTier(suggestions, 'cpu').every((e) => e.family === 'sd15'));
  const mid = sg.forTier(suggestions, 'mid');
  assert.ok(mid.some((e) => e.family === 'sdxl') && mid.some((e) => e.family === 'sd15'));
  assert.equal(sg.forTier(suggestions, 'ultra').length, suggestions.length);
  // tier ids used here are the ones tiers.js produces
  assert.deepEqual([tierId('none', 0), tierId('nvidia', 3), tierId('nvidia', 6), tierId('nvidia', 8), tierId('nvidia', 12), tierId('nvidia', 24)], sg.TIER_ORDER);
});

test('markInstalled flags entries whose file is in the matching folder', () => {
  const ckpt = suggestions.find((e) => e.type === 'checkpoint');
  const lora = suggestions.find((e) => e.type === 'lora');
  const out = sg.markInstalled([ckpt, lora], { checkpoints: [{ name: ckpt.fileName }], loras: [{ name: 'other.safetensors' }] });
  assert.deepEqual(out.map((e) => e.installed), [true, false]);
  assert.equal(sg.markInstalled([ckpt], {})[0].installed, false);
  assert.equal(ckpt.installed, undefined, 'input is not mutated');
});

test('GET /api/models/suggestions filters by tier and flags installed files', async (t) => {
  const { saveConfig } = require('../src/core/config');
  const { createApp } = require('../src/server/app');
  const { startFakeComfy } = require('./helpers/fake-comfy');
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-sugg-')));
  const fake = await startFakeComfy();
  saveConfig(paths, { authToken: 'tok', comfy: { mode: 'external', url: fake.url, dir: path.dirname(fake.modelsDir) } });
  const first = suggestions.find((e) => e.family === 'sd15' && e.type === 'checkpoint');
  fs.mkdirSync(path.join(fake.modelsDir, 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(fake.modelsDir, 'checkpoints', first.fileName), 'x');
  const hw = { os: 'linux', cpu: { model: 'x', cores: 1 }, ramGB: 16, freeDiskGB: 10, gpu: { vendor: 'nvidia', name: 'g', vramGB: 6 }, source: [] };
  const server = createApp({ paths, hardware: hw, safety: { check: async () => ({}), close() {} } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fake.close(); });

  const res = await (await fetch(`http://127.0.0.1:${server.address().port}/api/models/suggestions`)).json();
  assert.equal(res.tier, 'low');
  assert.ok(res.suggestions.length > 0 && res.suggestions.every((e) => e.family === 'sd15'));
  assert.deepEqual(Object.keys(res.goals).sort(), [...sg.GOALS].sort());
  assert.equal(res.suggestions.find((e) => e.id === first.id).installed, true);
  assert.ok(res.suggestions.filter((e) => e.id !== first.id).every((e) => e.installed === false));
});

test('setup plan: no starter checkpoint by default, included with --starter', async () => {
  const hw = {
    os: 'linux', distro: 'Test', arch: 'x64', cpu: { model: 'x', cores: 4 }, ramGB: 16, freeDiskGB: 100,
    gpu: { vendor: 'nvidia', name: 'RTX Test', vramGB: 6, driver: '', cudaVersion: '12.8', computeCap: '8.6' }, source: [],
  };
  // The plan table goes through the shared cli/ui module, so capture it there.
  const cliUi = require('../src/cli/ui');
  const realTable = cliUi.table;
  const realWarn = cliUi.warn;
  const tables = [];
  cliUi.table = (rows) => tables.push(JSON.stringify(rows));
  cliUi.warn = () => {};
  const restore = () => { cliUi.table = realTable; cliUi.warn = realWarn; };
  const quiet = () => {
    const lines = [];
    const push = (m) => lines.push(String(m));
    return { lines, info: push, ok: push, warn: push, fail: push, table: (r) => push(JSON.stringify(r)), step: push, progressBar: () => ({ update() {}, done() {} }), confirm: async () => true };
  };
  const mk = () => getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-setup-')));
  try {
    await runSetup({ dryRun: true, yes: true }, { paths: mk(), detect: async () => hw, ui: quiet() });
    await runSetup({ dryRun: true, yes: true, starter: true }, { paths: mk(), detect: async () => hw, ui: quiet() });
  } finally { restore(); }
  const [text, starterText] = tables;
  assert.doesNotMatch(text, /sd15-inpaint/);
  assert.match(text, /birefnet, mediapipe-face/);
  assert.match(text, /Pick your first model in the app \(Models → Suggested\)/);
  assert.match(starterText, /sd15-inpaint/);
  assert.doesNotMatch(starterText, /Pick your first model/);

  assert.equal(planModels(getManifest(), 'low', { includeStarter: false }).length, 2);
});
