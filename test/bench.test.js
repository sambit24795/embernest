'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const bench = require('../src/runtime/bench');
const { benchCommand } = require('../src/runtime/llm-supervisor');
const { getPaths } = require('../src/core/paths');
const { getManifest } = require('../src/install/manifest');
const llm = require('../src/install/llm');
const { startFakeLlm } = require('./helpers/fake-llm');

const manifest = getManifest();

test('verdictFor: fast enough only with >= 8 tok/s and a first token within 3 s on turn 2', () => {
  assert.equal(bench.verdictFor({ ttft2Ms: 1200, genTps: 20 }), 'fast enough for chat');
  assert.equal(bench.verdictFor({ ttft2Ms: 3000, genTps: 8 }), 'fast enough for chat');
  assert.equal(bench.verdictFor({ ttft2Ms: 3001, genTps: 20 }), 'slower than the chat target');
  assert.equal(bench.verdictFor({ ttft2Ms: 500, genTps: 7.9 }), 'slower than the chat target');
  assert.equal(bench.verdictFor({ ttft2Ms: null, genTps: 20 }), 'no timing reported');
  assert.equal(bench.verdictFor({ error: 'boom' }), 'error: boom');
  assert.equal(bench.verdictFor({ role: 'think', ttft2Ms: 900, genTps: 30 }), 'reasons before it answers: use for tricky questions');
});

test('turnStats reads llama-server timings and drops non-numbers', () => {
  assert.deepEqual(bench.turnStats({ ttftMs: 250, timings: { prompt_per_second: 90.5, predicted_per_second: 12 } }),
    { firstTokenMs: 250, promptTps: 90.5, genTps: 12 });
  assert.deepEqual(bench.turnStats({ ttftMs: null, timings: { predicted_per_second: 'x' } }),
    { firstTokenMs: null, promptTps: null, genTps: null });
});

test('summarizeTurns: first token per turn, mean speeds over both turns', () => {
  const first = { firstTokenMs: 900, promptTps: 100, genTps: 10 };
  const second = { firstTokenMs: 400, promptTps: 200, genTps: 14 };
  assert.deepEqual(bench.summarizeTurns(first, second), { ttft1Ms: 900, ttft2Ms: 400, promptTps: 150, genTps: 12 });
  assert.equal(bench.mean([null, null]), null);
});

test('formatBenchRows: seconds, one decimal for speeds, dashes for missing values', () => {
  const [row] = bench.formatBenchRows([{
    model: 'qwen25-1b5', role: 'fast', ttft1Ms: 1500, ttft2Ms: null, promptTps: null, genTps: 21.25, verdict: 'x',
  }]);
  assert.deepEqual(row, {
    model: 'qwen25-1b5', role: 'fast', 'first token 1': '1.5 s', 'first token 2': '-', 'prompt tok/s': '-', 'gen tok/s': '21.3', verdict: 'x',
  });
});

test('benchModels: names each model in the request, warms it up, and runs the two fixed turns', async (t) => {
  const fake = await startFakeLlm();
  t.after(() => fake.close());
  const rows = await bench.benchModels({
    url: fake.url,
    models: [{ id: 'fast-a', role: 'fast' }, { id: 'think-b', role: 'think' }],
  });
  assert.deepEqual(rows.map((r) => r.model), ['fast-a', 'think-b']);
  assert.deepEqual(rows.map((r) => r.role), ['fast', 'think']);
  for (const r of rows) {
    assert.equal(r.genTps, 10, 'fake llama-server reports 10 tok/s');
    assert.ok(Number.isFinite(r.ttft1Ms) && Number.isFinite(r.ttft2Ms));
    assert.equal(r.verdict, r.role === 'think' ? 'reasons before it answers: use for tricky questions' : 'fast enough for chat');
  }
  const models = fake.requests.map((b) => b.model);
  assert.deepEqual(models, ['fast-a', 'fast-a', 'fast-a', 'think-b', 'think-b', 'think-b']);
  assert.equal(fake.requests[1].max_tokens, 96, 'turn 1 uses the fixed reply budget');
  assert.equal(fake.requests[0].max_tokens, 1, 'warm-up is a single token');
  const turn2 = fake.requests[2].messages;
  assert.equal(turn2[turn2.length - 1].content, bench.BENCH_TURNS[1]);
  assert.equal(turn2[turn2.length - 2].role, 'assistant', 'turn 2 repeats turn 1 before the follow-up');
});

test('benchModels: a failing model gets an error row and the others still run', async () => {
  const stream = async function* stream({ model }) {
    if (model === 'broken') throw new Error('engine says no');
    yield { delta: 'hi' };
    yield { timings: { predicted_per_second: 9, prompt_per_second: 50 } };
  };
  const rows = await bench.benchModels({ url: 'http://unused', models: [{ id: 'broken' }, { id: 'ok', role: 'fast' }], stream });
  assert.equal(rows[0].error, 'engine says no');
  assert.equal(rows[0].verdict, 'error: engine says no');
  assert.equal(rows[1].error, undefined);
  assert.equal(rows[1].genTps, 9);
});

test('benchCommand: one presets file for every installed model, one model loaded at a time, own file', () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bench-')));
  const hw = { os: 'linux', arch: 'x64', ramGB: 16, gpu: { vendor: 'none' } };
  const cfg = { chat: { model: 'qwen25-1b5', thinkModel: '', port: 8189, url: 'http://127.0.0.1:8189', device: 'cpu', contextSize: 8192, threads: 0 }, hardware: hw };
  const asset = llm.pickServerAsset(manifest, hw, 'cpu');
  const dir = path.join(paths.llm, 'server', manifest.llm.server.tag, asset.key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server'), '');
  fs.writeFileSync(path.join(dir, llm.MARKER), JSON.stringify({ file: asset.file, bin: 'llama-server' }));
  const models = [manifest.llm.models.find((m) => m.id === 'qwen25-1b5'), manifest.llm.models.find((m) => m.id === 'qwen3-4b-thinking')];

  const { cmd, args } = benchCommand(paths, cfg, { port: 40123, models, manifest });
  assert.equal(cmd, path.join(dir, 'llama-server'));
  assert.deepEqual(args.slice(0, 4), ['--models-preset', paths.llmBenchPresets, '--models-max', '1']);
  assert.equal(args[args.indexOf('--port') + 1], '40123');
  const ini = fs.readFileSync(paths.llmBenchPresets, 'utf8');
  assert.match(ini, /^\[qwen25-1b5\]$/m);
  assert.match(ini, /^\[qwen3-4b-thinking\]$/m);
  assert.match(ini, /^reasoning-format = deepseek$/m);
  assert.equal(fs.existsSync(paths.llmPresets), false, 'the running server presets file is not touched');
});

test('benchCommand: an uninstalled engine is an error that says what to run', () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bench-none-')));
  const cfg = { chat: { model: 'qwen25-1b5', thinkModel: '', port: 8189, device: 'cpu', contextSize: 8192, threads: 0 }, hardware: { os: 'linux', arch: 'x64' } };
  assert.throws(() => benchCommand(paths, cfg, { port: 1, models: [], manifest }), /chat engine is not installed/);
});

test('startBenchServer: a child that exits while starting fails, and nothing is left running', async () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bench-exit-')));
  const hw = { os: 'linux', arch: 'x64', ramGB: 16, gpu: { vendor: 'none' } };
  const cfg = { chat: { model: 'qwen25-1b5', thinkModel: '', port: 8189, device: 'cpu', contextSize: 8192, threads: 0 }, hardware: hw };
  const asset = llm.pickServerAsset(manifest, hw, 'cpu');
  const dir = path.join(paths.llm, 'server', manifest.llm.server.tag, asset.key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server'), '');
  fs.writeFileSync(path.join(dir, llm.MARKER), JSON.stringify({ file: asset.file, bin: 'llama-server' }));
  const models = [manifest.llm.models.find((m) => m.id === 'qwen25-1b5')];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.pid = 999999;
    child.exitCode = 1;
    child.signalCode = null;
    setImmediate(() => child.emit('exit', 1, null));
    return child;
  };
  await assert.rejects(bench.startBenchServer(paths, cfg, models, { spawnFn, timeoutMs: 2000 }), /stopped while starting/);
});
