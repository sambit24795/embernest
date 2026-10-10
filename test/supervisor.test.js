'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { getPaths } = require('../src/core/paths');
const { Supervisor } = require('../src/runtime/supervisor');

const MAIN = path.join(__dirname, 'helpers', 'fake-comfy-main.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function make(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-sup-'));
  const paths = getPaths(home);
  const port = await freePort();
  const cfg = { comfy: { mode: 'managed', port, url: `http://127.0.0.1:${port}`, args: [], ...overrides } };
  const sup = new Supervisor({
    paths,
    getConfig: () => cfg,
    command: () => ({ cmd: process.execPath, args: [MAIN, String(port)] }),
    timing: { healthIntervalMs: 50, restartDelayMs: 50, stopGraceMs: 2000, healthTimeoutMs: 15000 },
  });
  return { sup, paths, port, cleanup: async () => { await sup.stop(); fs.rmSync(home, { recursive: true, force: true }); } };
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('waitFor timed out');
}

test('start, restart and stop a managed engine', async () => {
  const { sup, paths, port, cleanup } = await make();
  try {
    assert.strictEqual(sup.status().state, 'stopped');
    await sup.start();
    assert.strictEqual(sup.status().state, 'running');
    const pid1 = sup.pid;
    assert.ok(pid1);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/system_stats`)).status, 200);
    assert.match(fs.readFileSync(paths.comfyLog, 'utf8'), /fake comfy ready/);

    await sup.restart();
    assert.strictEqual(sup.status().state, 'running');
    assert.notStrictEqual(sup.pid, pid1);
    assert.strictEqual(sup.status().restarts, 1);
    assert.throws(() => process.kill(pid1, 0));

    const pid2 = sup.pid;
    await sup.stop();
    assert.strictEqual(sup.status().state, 'stopped');
    assert.throws(() => process.kill(pid2, 0));
  } finally {
    await cleanup();
  }
});

test('an unexpected exit restarts the engine', async () => {
  const { sup, cleanup } = await make();
  try {
    await sup.start();
    const pid = sup.pid;
    process.kill(pid, 'SIGKILL');
    await waitFor(() => sup.status().state === 'running' && sup.pid && sup.pid !== pid);
    assert.strictEqual(sup.status().restarts, 1);
  } finally {
    await cleanup();
  }
});

test('four quick crashes give up with state crashed', async () => {
  const { sup, cleanup } = await make();
  try {
    let crashed = false;
    sup.on('crashed', () => { crashed = true; });
    await sup.start();
    for (let i = 0; i < 4; i += 1) {
      await waitFor(() => sup.status().state === 'running' && sup.pid);
      process.kill(sup.pid, 'SIGKILL');
      await sleep(100);
    }
    await waitFor(() => sup.status().state === 'crashed');
    assert.ok(crashed);
    assert.strictEqual(sup.pid, null);
  } finally {
    await cleanup();
  }
});

test('refuses to start when something already answers on the port', async () => {
  const { sup, cleanup } = await make();
  const other = await make();
  try {
    await other.sup.start();
    const clash = new Supervisor({
      paths: sup.paths,
      getConfig: () => ({ comfy: { mode: 'managed', port: other.port, url: `http://127.0.0.1:${other.port}`, args: [] } }),
      command: () => ({ cmd: process.execPath, args: [MAIN, String(other.port)] }),
    });
    await assert.rejects(clash.start(), /Something is already running on port/);
    assert.ok(other.sup.pid, 'the other engine is untouched');
  } finally {
    await other.cleanup();
    await cleanup();
  }
});

test('a child that exits before it is healthy rejects with the log tail', async () => {
  const { sup, port, cleanup } = await make();
  try {
    sup.command = () => ({ cmd: process.execPath, args: ['-e', 'console.log("boom line"); process.exit(3)'] });
    await assert.rejects(sup.start(), /boom line/);
    assert.strictEqual(sup.status().state, 'crashed');
    assert.ok(port);
  } finally {
    await cleanup();
  }
});

test('external mode waits for health, never spawns, and cannot restart', async () => {
  const { startFakeComfy } = require('./helpers/fake-comfy');
  const fake = await startFakeComfy();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-sup-'));
  const sup = new Supervisor({
    paths: getPaths(home),
    getConfig: () => ({ comfy: { mode: 'external', url: fake.url, port: fake.port, args: [] } }),
    timing: { healthIntervalMs: 50 },
  });
  try {
    await sup.start();
    assert.strictEqual(sup.status().state, 'external');
    assert.strictEqual(sup.pid, null);
    await assert.rejects(sup.restart(), /external engine/);
  } finally {
    await sup.stop();
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('default command line honours dataMode', () => {
  const paths = getPaths('/h');
  const mk = (dataMode) => new Supervisor({
    paths,
    getConfig: () => ({}),
  }).buildCommand({ comfy: { python: '/p', dir: '/d', port: 1, args: ['--lowvram'], dataMode } });
  const a = mk('base-directory');
  assert.deepStrictEqual(a.args.slice(0, 5), ['main.py', '--listen', '127.0.0.1', '--port', '1']);
  assert.ok(a.args.includes('--base-directory') && a.args.includes('--lowvram'));
  const b = mk('extra-model-paths');
  assert.ok(!b.args.includes('--base-directory'));
  assert.ok(b.args.includes('--output-directory'));
});

// ---- LlmSupervisor (same behaviour, different command, health URL and log) ----

const { LlmSupervisor, llamaCommand, presetsText, modelsMax } = require('../src/runtime/llm-supervisor');
const { ProcessSupervisor, ComfySupervisor } = require('../src/runtime/supervisor');
const FAKE_LLAMA = path.join(__dirname, 'helpers', 'fake-llama-main.js');

async function makeLlm({ loadMs = 0, router = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-llm-sup-'));
  const paths = getPaths(home);
  const port = await freePort();
  const cfg = { chat: { enabled: true, model: 'm', port, url: `http://127.0.0.1:${port}`, device: 'cpu' } };
  const sup = new LlmSupervisor({
    paths,
    getConfig: () => cfg,
    command: (c) => ({ cmd: process.execPath, args: [FAKE_LLAMA, '--port', String(c.chat.port), '--load-ms', String(loadMs), ...(router ? ['--router-model', 'm'] : [])] }),
    timing: { healthIntervalMs: 50, restartDelayMs: 50, stopGraceMs: 2000, healthTimeoutMs: 15000 },
  });
  return { sup, paths, port, cleanup: async () => { await sup.stop(); fs.rmSync(home, { recursive: true, force: true }); } };
}

test('both wrappers are ProcessSupervisors', () => {
  assert.ok(Object.getPrototypeOf(ComfySupervisor) === ProcessSupervisor);
  assert.ok(Object.getPrototypeOf(LlmSupervisor) === ProcessSupervisor);
});

test('llm: waits for /health to turn 200, logs to chat.log, restarts and stops with no orphan', async () => {
  const { sup, paths, port, cleanup } = await makeLlm({ loadMs: 400 });
  try {
    const t0 = Date.now();
    await sup.start();
    assert.ok(Date.now() - t0 >= 300, 'start waited for the model to load');
    const st = sup.status();
    assert.strictEqual(st.state, 'running');
    assert.strictEqual(st.model, 'm');
    assert.strictEqual(st.url, `http://127.0.0.1:${port}/health`);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.match(fs.readFileSync(paths.chatLog, 'utf8'), /fake llama ready/);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(paths.chatLog).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(paths.comfyLog));

    const pid1 = sup.pid;
    process.kill(pid1, 'SIGKILL');
    await waitFor(() => sup.status().state === 'running' && sup.pid && sup.pid !== pid1);
    assert.strictEqual(sup.status().restarts, 1);

    const pid2 = sup.pid;
    await sup.stop();
    assert.strictEqual(sup.status().state, 'stopped');
    assert.throws(() => process.kill(pid2, 0));
  } finally {
    await cleanup();
  }
});

test('llm: four quick crashes give up with state crashed', async () => {
  const { sup, cleanup } = await makeLlm();
  try {
    let crashed = false;
    sup.on('crashed', () => { crashed = true; });
    await sup.start();
    for (let i = 0; i < 4; i += 1) {
      await waitFor(() => sup.status().state === 'running' && sup.pid);
      process.kill(sup.pid, 'SIGKILL');
      await sleep(100);
    }
    await waitFor(() => sup.status().state === 'crashed');
    assert.ok(crashed);
  } finally {
    await cleanup();
  }
});

test('llm: refuses to start on a busy port, and a child that exits early rejects with its output', async () => {
  const a = await makeLlm();
  const b = await makeLlm();
  try {
    await a.sup.start();
    const clash = new LlmSupervisor({
      paths: b.paths,
      getConfig: () => ({ chat: { port: a.port, url: `http://127.0.0.1:${a.port}`, model: 'm' } }),
      command: () => ({ cmd: process.execPath, args: [FAKE_LLAMA, '--port', String(a.port)] }),
    });
    await assert.rejects(clash.start(), /Something is already running on port \d+ — stop it or change chat\.port/);
    b.sup.command = () => ({ cmd: process.execPath, args: ['-e', 'console.log("no model file"); process.exit(1)'] });
    await assert.rejects(b.sup.start(), /llama-server exited .*no model file/s);
    assert.strictEqual(b.sup.status().state, 'crashed');
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('llama command line: flags, cpu/gpu layers, optional threads', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-llm-cmd-'));
  const paths = getPaths(home);
  const manifest = require('../src/install/manifest').getManifest();
  const hardware = { os: 'linux', arch: 'x64', ramGB: 16, gpu: { vendor: 'nvidia', vramGB: 6 } };
  const chat = { enabled: true, model: 'qwen3-4b', port: 8189, url: 'http://127.0.0.1:8189', device: 'auto', contextSize: 8192, threads: 0 };
  const dir = path.join(paths.llm, 'server', manifest.llm.server.tag, 'linux-x64-cpu');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(paths.llm, 'models'), { recursive: true });
  const bin = path.join(dir, 'llama-server');
  fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(dir, '.pixelkiln-llm.json'), JSON.stringify({ file: 'x', bin: 'llama-server' }));

  assert.throws(() => llamaCommand(paths, { chat, hardware }, manifest), /model file is missing/);
  const gguf = path.join(paths.llm, 'models', 'Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
  fs.writeFileSync(gguf, '');
  const c = llamaCommand(paths, { chat, hardware }, manifest);
  assert.strictEqual(c.cmd, bin);
  assert.deepStrictEqual(c.args, ['--models-preset', paths.llmPresets, '--models-max', '1', '--host', '127.0.0.1',
    '--port', '8189', '--no-webui', '--cache-reuse', '256']);
  assert.strictEqual(fs.readFileSync(paths.llmPresets, 'utf8'),
    `version = 1\n\n[*]\nctx-size = 8192\njinja = true\nn-gpu-layers = 0\n\n[qwen3-4b]\nmodel = ${gguf}\nload-on-startup = true\n`);
  llamaCommand(paths, { chat: { ...chat, threads: 6 }, hardware }, manifest);
  assert.match(fs.readFileSync(paths.llmPresets, 'utf8'), /\nthreads = 6\n/);
  // A think model is added only once its file is installed; 16 GB lets the router keep two.
  const thinkFile = path.join(paths.llm, 'models', 'Qwen_Qwen3-4B-Thinking-2507-Q4_K_M.gguf');
  const withThink = { chat: { ...chat, thinkModel: 'qwen3-4b-thinking' }, hardware: { ...hardware, ramGB: 32 } };
  assert.deepStrictEqual(llamaCommand(paths, withThink, manifest).args.slice(0, 4), ['--models-preset', paths.llmPresets, '--models-max', '1']);
  fs.writeFileSync(thinkFile, '');
  assert.strictEqual(llamaCommand(paths, withThink, manifest).args[3], '2');
  const ini = fs.readFileSync(paths.llmPresets, 'utf8');
  assert.match(ini, new RegExp(`\\[qwen3-4b-thinking\\]\nmodel = ${thinkFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\nreasoning-format = deepseek\n`));
  assert.ok(ini.indexOf('load-on-startup') === ini.lastIndexOf('load-on-startup'), 'only the default model preloads');
  assert.throws(() => llamaCommand(paths, { chat: { ...chat, model: 'nope' }, hardware }, manifest), /not a known model/);
  fs.rmSync(path.join(dir, '.pixelkiln-llm.json'));
  assert.throws(() => llamaCommand(paths, { chat, hardware }, manifest), /not installed/);
});

test('presets.ini text and models-max', () => {
  const text = presetsText([
    { id: 'a', file: '/m/My Models/a.gguf', loadOnStartup: true },
    { id: 'b', file: '/m/b.gguf', think: true },
  ], { contextSize: 4096, gpuLayers: 99 });
  assert.strictEqual(text, 'version = 1\n\n[*]\nctx-size = 4096\njinja = true\nn-gpu-layers = 99\n\n'
    + '[a]\nmodel = /m/My Models/a.gguf\nload-on-startup = true\n\n[b]\nmodel = /m/b.gguf\nreasoning-format = deepseek\n');
  const laptop = { gpu: { vendor: 'nvidia', vramGB: 6, name: 'GTX 1660 Ti' }, ramGB: 15.5, os: 'linux', arch: 'x64', freeDiskGB: 100 };
  const fast = { sizeMB: 1117 };
  const think = { sizeMB: 2497 };
  const cfgFor = (hardware) => ({ hardware, chat: { device: 'auto' } });
  // 15.5 GB RAM, CPU chat: budget ~5.4 GB holds fast + think (~4.7 GB loaded)
  assert.strictEqual(modelsMax(cfgFor(laptop), [fast, think]), 2);
  assert.strictEqual(modelsMax(cfgFor({ ...laptop, ramGB: 8 }), [fast, think]), 1);
  assert.strictEqual(modelsMax(cfgFor(laptop), [fast]), 1);
  assert.strictEqual(modelsMax(cfgFor({}), [fast, think]), 1);
});

test('presets.ini writes paths raw: spaces and Windows paths are fine, # ; and newlines are refused', () => {
  const shared = { contextSize: 2048, gpuLayers: 0 };
  const text = presetsText([
    { id: 'a', file: '/tmp/pk test/two  spaces/a.gguf', loadOnStartup: true },
    { id: 'b', file: 'C:\\Users\\Some One\\AppData\\Roaming\\Pixel Kiln\\b.gguf' },
  ], shared);
  // No quotes and no escapes: llama-server b11429 would keep them literally (verified live).
  assert.ok(text.includes('model = /tmp/pk test/two  spaces/a.gguf\n'));
  assert.ok(text.includes('model = C:\\Users\\Some One\\AppData\\Roaming\\Pixel Kiln\\b.gguf\n'));
  assert.ok(!/["']/.test(text));
  for (const bad of ['/tmp/pk#1/a.gguf', '/tmp/pk;1/a.gguf', '/tmp/a\nb.gguf']) {
    assert.throws(() => presetsText([{ id: 'a', file: bad }], shared), /preset file cannot hold/);
  }
});

test('llm router mode: start waits until the default model is loaded, not just /health', async () => {
  const { sup, cleanup } = await makeLlm({ loadMs: 500, router: true });
  try {
    const t0 = Date.now();
    await sup.start();
    assert.ok(Date.now() - t0 >= 400, 'start waited for status "loaded"');
    assert.strictEqual(sup.status().state, 'running');
    assert.ok(sup.pid);
  } finally {
    await cleanup();
  }
});
