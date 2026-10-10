'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getManifest, assetKey, findPlaceholders } = require('../src/install/manifest');
const { tierId } = require('../src/core/tiers');

const manifest = getManifest();

function strings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => strings(v, out));
  return out;
}

const allModels = () => [...manifest.models.required, ...Object.values(manifest.models.starter)];

test('no string contains VERIFY', () => {
  assert.deepEqual(findPlaceholders(manifest), []);
  assert.ok(!strings(manifest).some((s) => s.includes('VERIFY')));
});

test('getManifest throws on placeholders unless dryRun (placeholder detection)', () => {
  assert.deepEqual(findPlaceholders({ a: { b: 'VERIFY x' }, c: ['ok', 'VERIFY'] }), ['a.b', 'c.1']);
});

test('every url and urlTemplate is https', () => {
  const urls = [
    manifest.uv.urlTemplate, manifest.comfyui.urlTemplate,
    ...Object.values(manifest.torch.indexes),
    ...allModels().flatMap((m) => [m.url, ...m.mirrors]),
  ];
  for (const u of urls) assert.ok(u.startsWith('https://'), u);
});

test('every sha256 is 64 hex chars', () => {
  const hashes = [
    manifest.comfyui.sha256,
    ...Object.values(manifest.uv.assets).map((a) => a.sha256),
    ...allModels().map((m) => m.sha256),
  ];
  for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
});

test('every model has sizeMB > 0 and a license on starters', () => {
  for (const m of allModels()) assert.ok(m.sizeMB > 0, m.id || m.file);
  for (const m of Object.values(manifest.models.starter)) assert.ok(m.license);
});

test('every tier has a starterByTier entry naming known starters', () => {
  const ids = [tierId('none', 0), tierId('nvidia', 2), tierId('nvidia', 5), tierId('nvidia', 8),
    tierId('nvidia', 12), tierId('nvidia', 24)];
  assert.deepEqual(ids, ['cpu', 'tiny', 'low', 'mid', 'high', 'ultra']);
  for (const id of ids) {
    const list = manifest.models.starterByTier[id];
    assert.ok(Array.isArray(list) && list.length > 0, id);
    for (const s of list) assert.ok(manifest.models.starter[s], s);
  }
});

test('torch index keys used by tiers.js exist; uv covers all supported platforms', () => {
  for (const k of ['cu130', 'cu128', 'cu126', 'rocm', 'xpu', 'cpu']) assert.ok(manifest.torch.indexes[k], k);
  for (const k of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']) {
    assert.ok(manifest.uv.assets[k], k);
  }
  assert.equal(assetKey('linux', 'x64'), 'linux-x64');
});

test('llm: server assets and models are pinned and well formed', () => {
  const { server, models } = manifest.llm;
  assert.ok(server.tag && server.urlTemplate.startsWith('https://') && server.urlTemplate.includes('{tag}'));
  for (const [key, a] of Object.entries(server.assets)) {
    assert.match(key, /^(linux|darwin|win32)-(x64|arm64)-(cpu|vulkan|cuda|metal)$/, key);
    for (const x of [a, ...(a.extra || [])]) {
      assert.ok(x.file, key);
      assert.match(x.sha256, /^[0-9a-f]{64}$/, key);
    }
  }
  for (const k of ['linux-x64-cpu', 'darwin-arm64-metal', 'darwin-x64-cpu', 'win32-x64-cpu']) {
    assert.ok(server.assets[k], k);
  }
  for (const m of models) {
    assert.ok(m.url.startsWith('https://'), m.id);
    assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id);
    assert.ok(m.sizeMB > 0 && m.contextLength > 0 && m.license && m.base && m.repo, m.id);
    assert.ok(/q4_k_m\.gguf$/i.test(m.file), m.id);
    assert.ok(['mainstream', 'uncensored'].includes(m.variant), m.id);
    assert.ok(['fast', 'balanced', 'think'].includes(m.role), m.id);
    assert.equal(Boolean(m.thinking), m.role === 'think', m.id);
    if (m.thinking) assert.ok(m.thinkFormat, m.id);
    assert.equal(typeof m.toolCalling, 'boolean');
  }
  assert.equal(new Set(models.map((m) => m.id)).size, models.length);
});

test('llm: every tier size class has a mainstream and an uncensored model', () => {
  const { planForHardware } = require('../src/core/tiers');
  const classes = new Set();
  for (const gpu of [{ vendor: 'none' }, { vendor: 'nvidia', vramGB: 2 }, { vendor: 'nvidia', vramGB: 5 },
    { vendor: 'nvidia', vramGB: 8 }, { vendor: 'nvidia', vramGB: 12 }, { vendor: 'nvidia', vramGB: 24 }]) {
    classes.add(planForHardware({ os: 'linux', arch: 'x64', ramGB: 32, freeDiskGB: 100, gpu }).llm.sizeClass);
  }
  assert.deepEqual([...classes].sort(), ['1-3B', '12-14B', '24B+', '3-4B', '7-8B']);
  // 24B+ reuses the 12-14B models: nothing suitable verified above 14B.
  const fallback = { '24B+': '12-14B' };
  for (const c of classes) {
    const want = manifest.llm.models.some((m) => m.sizeClass === c) ? c : fallback[c];
    for (const v of ['mainstream', 'uncensored']) {
      assert.ok(manifest.llm.models.some((m) => m.sizeClass === want && m.variant === v), `${c} ${v}`);
    }
  }
});

test('llm: every role has a mainstream and an uncensored model; old ids stay valid', () => {
  const { models } = manifest.llm;
  for (const role of ['fast', 'balanced', 'think']) {
    for (const v of ['mainstream', 'uncensored']) {
      assert.ok(models.some((m) => m.role === role && m.variant === v), `${role} ${v}`);
    }
  }
  for (const m of models.filter((x) => x.role === 'balanced')) assert.ok(['1-3B', '3-4B', '7-8B', '12-14B'].includes(m.sizeClass));
  for (const id of ['llama32-3b', 'qwen3-4b', 'qwen3-4b-abliterated', 'qwen25-7b', 'qwen25-14b-abliterated']) {
    assert.equal(models.find((m) => m.id === id).role, 'balanced', id);
  }
});
