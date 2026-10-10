'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getManifest } = require('../src/install/manifest');
const { getPaths } = require('../src/core/paths');
const d = require('../src/runtime/doctor');

const manifest = getManifest();
const paths = getPaths('/tmp/pk-doctor-fake');

/** Facts for a healthy managed install; tests override single fields. */
function facts(over = {}) {
  const hw = { gpu: { vendor: 'nvidia', name: 'RTX 3060' }, ramGB: 16, freeDiskGB: 100 };
  return {
    platform: 'linux', nodeVersion: '22.1.0', paths, manifest,
    cfg: { port: 3000, listenOnLan: true, comfy: { mode: 'managed', dir: '/c', version: manifest.comfyui.tag, python: '/p' }, hardware: hw },
    hw, plan: { torch: { backend: 'cuda' } }, running: false,
    homeWritable: true, freeDiskGB: 100, setupSteps: { config: {}, verify: {} },
    comfyMain: true, comfyMarker: true, modelsDir: '/m', missingModels: [], checkpointCount: 2,
    lanIps: [{ iface: 'eth0', address: '10.0.0.5' }], configMode: 0o600,
    uvVersion: manifest.uv.version, venvVersion: '3.12.1', torch: { torch: '2.9', device: 'cuda', name: 'RTX' },
    externalTorchOk: true, safety: { ok: true },
    engine: { reachable: false },
    ports: { server: { port: 3000, free: true }, comfy: { port: 8188, local: true, free: true } },
    ...over,
  };
}
const status = (check, f) => check(f).status;
const withCfg = (over, comfy = {}) => {
  const f = facts();
  return { ...f, cfg: { ...f.cfg, ...over, comfy: { ...f.cfg.comfy, ...comfy } } };
};
const ext = (over = {}) => ({ ...withCfg({}, { mode: 'external', dir: '/ext', python: '/ep' }), ...over });
const allNodes = () => ({ reachable: true, nodes: manifest.comfyui.requiredNodes });

test('healthy managed install: no warnings or failures', () => {
  const res = d.runChecks(facts());
  assert.ok(res.every((r) => r.status === 'ok'), JSON.stringify(res.filter((r) => r.status !== 'ok')));
  for (const r of res) assert.deepStrictEqual(Object.keys(r), ['id', 'status', 'message', 'hint']);
});

test('node version', () => {
  assert.strictEqual(status(d.CHECKS[0], facts({ nodeVersion: '22.0.0' })), 'ok');
  assert.strictEqual(status(d.CHECKS[0], facts({ nodeVersion: '20.11.0' })), 'fail');
});

test('data folder and disk', () => {
  assert.strictEqual(d.runChecks(facts({ homeWritable: false })).find((r) => r.id === 'data-folder').status, 'fail');
  const disk = (gb) => d.runChecks(facts({ freeDiskGB: gb })).find((r) => r.id === 'disk').status;
  assert.strictEqual(disk(15), 'ok');
  assert.strictEqual(disk(14.9), 'warn');
  assert.strictEqual(disk(0), 'warn');
});

test('setup records', () => {
  const r = d.runChecks(facts({ setupSteps: { config: {} } })).find((x) => x.id === 'setup');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.hint, /embernest setup/);
  assert.match(r.message, /verify/);
});

test('uv: ok, older, missing, skipped when external', () => {
  const id = (f) => d.runChecks(f).find((x) => x.id === 'uv');
  assert.strictEqual(id(facts()).status, 'ok');
  assert.strictEqual(id(facts({ uvVersion: '0.1.0' })).status, 'warn');
  assert.strictEqual(id(facts({ uvVersion: null })).status, 'fail');
  assert.strictEqual(id(ext()), undefined);
});

test('python: venv ok/fail, external torch import', () => {
  const id = (f) => d.runChecks(f).find((x) => x.id === 'python');
  assert.strictEqual(id(facts()).status, 'ok');
  assert.strictEqual(id(facts({ venvVersion: null })).status, 'fail');
  assert.strictEqual(id(ext()).status, 'ok');
  assert.strictEqual(id(ext({ externalTorchOk: false })).status, 'fail');
  assert.strictEqual(id(withCfg({}, { mode: 'external', python: '' })), undefined);
});

test('torch device vs planned backend, with vendor hints', () => {
  const id = (f) => d.runChecks(f).find((x) => x.id === 'torch');
  assert.strictEqual(id(facts()).status, 'ok');
  const bad = id(facts({ torch: { torch: '2', device: 'cpu', name: 'CPU' } }));
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.hint, /NVIDIA driver/);
  assert.strictEqual(id(facts({ torch: null })).status, 'fail');
  assert.strictEqual(id(facts({ venvVersion: null })), undefined);
  assert.strictEqual(id(ext()), undefined);
  assert.match(d.torchHint('amd', 'linux'), /HSA_OVERRIDE_GFX_VERSION/);
  assert.doesNotMatch(d.torchHint('amd', 'win32'), /HSA_OVERRIDE/);
});

test('hardware change warns, unchanged ok, none recorded warns', () => {
  const id = (f) => d.runChecks(f).find((x) => x.id === 'hardware');
  assert.strictEqual(id(facts()).status, 'ok');
  assert.strictEqual(id(facts({ hw: { gpu: { vendor: 'amd', name: 'RX 7600' } } })).status, 'warn');
  assert.strictEqual(id(withCfg({ hardware: {} })).status, 'warn');
});

test('comfyui: missing, older, current, external', () => {
  const id = (f) => d.runChecks(f).find((x) => x.id === 'comfyui');
  assert.strictEqual(id(facts()).status, 'ok');
  assert.strictEqual(id(facts({ comfyMain: false })).status, 'fail');
  assert.strictEqual(id(facts({ comfyMarker: false })).status, 'fail');
  const old = id(withCfg({}, { version: 'v0.1.0' }));
  assert.strictEqual(old.status, 'warn');
  assert.match(old.hint, /update engine/);
  assert.strictEqual(id(ext()).status, 'ok');
  assert.strictEqual(id(ext({ comfyMain: false })).status, 'fail');
  assert.strictEqual(id(withCfg({}, { mode: 'external', dir: '' })), undefined);
});

test('required models and checkpoint', () => {
  const id = (f, n) => d.runChecks(f).find((x) => x.id === n);
  assert.strictEqual(id(facts(), 'models').status, 'ok');
  const miss = id(facts({ missingModels: [{ folder: 'background_removal', file: 'birefnet.safetensors' }] }), 'models');
  assert.strictEqual(miss.status, 'fail');
  assert.match(miss.message, /birefnet/);
  assert.match(miss.hint, /embernest setup/);
  assert.strictEqual(id(facts({ checkpointCount: 0 }), 'checkpoint').status, 'warn');
  assert.strictEqual(id(facts({ modelsDir: null }), 'models'), undefined);
  assert.strictEqual(id(facts({ modelsDir: null }), 'checkpoint'), undefined);
});

test('engine: stopped, running but unreachable, missing nodes, all nodes', () => {
  const eng = (f) => d.runChecks(f).find((x) => x.id === 'engine');
  assert.strictEqual(eng(facts()).status, 'ok');
  assert.strictEqual(eng(facts({ running: true, engine: { reachable: false, error: 'refused' } })).status, 'fail');
  const m = eng(facts({ engine: { reachable: true, nodes: ['KSampler'] } }));
  assert.strictEqual(m.status, 'fail');
  assert.match(m.message, /RemoveBackground/);
  assert.match(m.hint, /update engine/);
  assert.strictEqual(eng(facts({ engine: allNodes() })).status, 'ok');
});

test('ports: free, busy, owned by us, external engine in use', () => {
  const ports = (f) => d.runChecks(f).find((x) => x.id === 'ports');
  assert.strictEqual(ports(facts()).status, 'ok');
  const busy = ports(facts({ ports: { server: { port: 3000, free: false }, comfy: { port: 8188, local: true, free: true } } }));
  assert.strictEqual(busy.status, 'fail');
  assert.match(busy.message, /3000/);
  assert.strictEqual(ports(facts({ running: true, ports: { server: { port: 3000, free: false }, comfy: { port: 8188, local: true, free: false } } })).status, 'ok');
  assert.strictEqual(ports(facts({ ports: { server: { port: 3000, free: false }, comfy: { port: 8188, local: true, free: false } } })).status, 'fail');
  assert.strictEqual(ports(ext({ ports: { server: { port: 3000, free: true }, comfy: { port: 8188, local: true, free: false } } })).status, 'ok');
});

test('lan: off, no address, firewall hint per OS', () => {
  const lan = (f) => d.runChecks(f).find((x) => x.id === 'lan');
  assert.strictEqual(lan(withCfg({ listenOnLan: false })).status, 'ok');
  assert.strictEqual(lan(facts({ lanIps: [] })).status, 'warn');
  assert.match(lan(facts()).hint, /ufw/);
  assert.match(lan(facts({ platform: 'win32' })).hint, /Firewall/);
  assert.match(lan(facts({ platform: 'darwin' })).hint, /Firewall/);
});

test('config.json mode: 0600 ok, 0644 warn with chmod hint, skipped on win32', () => {
  const m = (f) => d.runChecks(f).find((x) => x.id === 'config-mode');
  assert.strictEqual(m(facts()).status, 'ok');
  const bad = m(facts({ configMode: 0o644 }));
  assert.strictEqual(bad.status, 'warn');
  assert.match(bad.hint, /^chmod 600 /);
  assert.strictEqual(m(facts({ platform: 'win32', configMode: null })), undefined);
});

test('results never contain the auth token', () => {
  const f = facts();
  f.cfg.authToken = 'SECRET-TOKEN-VALUE';
  assert.doesNotMatch(JSON.stringify(d.runChecks(f)), /SECRET-TOKEN-VALUE/);
});

test('safety check: ok when the model loads, fail when it cannot, skipped without facts', () => {
  const id = (f) => d.runChecks(f).find((r) => r.id === 'safety');
  assert.strictEqual(id(facts()).status, 'ok');
  const bad = id(facts({ safety: { ok: false, error: 'no cache' } }));
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.message, /no cache/);
  assert.strictEqual(id(facts({ safety: undefined })), undefined);
});

test('chat check: not shown when chat is off; each failure has a fix; ok when everything is in place', () => {
  const model = { label: 'Qwen3 4B', sizeMB: 100 };
  const good = { model, bin: '/b/llama-server', version: 'llama-server 0.6.0 (build 1)', modelFile: '/m.gguf', modelBytes: 100 * 1e6, healthOk: true };
  const f = (chat, over = {}) => {
    const base = facts(over);
    return { ...base, cfg: { ...base.cfg, chat: { enabled: true, model: 'x', url: 'http://127.0.0.1:8189' } }, chat };
  };
  const find = (facts_) => d.runChecks(facts_).find((r) => r.id === 'chat');
  assert.strictEqual(find(facts()), undefined);
  assert.strictEqual(find(f(good)).status, 'ok');
  assert.strictEqual(find(f({ ...good, bin: null })).status, 'fail');
  assert.strictEqual(find(f({ ...good, version: null })).status, 'fail');
  assert.match(find(f({ ...good, modelBytes: null })).message, /missing/);
  assert.match(find(f({ ...good, modelBytes: 50 * 1e6 })).message, /incomplete/);
  assert.strictEqual(find(f({ ...good, healthOk: false })).status, 'ok', 'health only matters while running');
  const bad = find(f({ ...good, healthOk: false }, { running: true }));
  assert.strictEqual(bad.status, 'fail');
  assert.match(bad.hint, /logs chat/);
  assert.strictEqual(find(f({ ...good, healthOk: true }, { running: true })).status, 'ok');
  // Router mode: /health is up at once, so the default model must be loaded too.
  const notLoaded = find(f({ ...good, model: { ...model, id: 'x' }, defaultLoaded: false }, { running: true }));
  assert.strictEqual(notLoaded.status, 'fail');
  assert.match(notLoaded.message, /default model \(x\) is not loaded/);
  assert.match(find(f({ ...good, defaultLoaded: true }, { running: true })).message, /default model loaded/);
});
