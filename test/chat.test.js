'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chat = require('../src/cli/commands/chat');
const { getPaths } = require('../src/core/paths');
const { loadConfig, saveConfig } = require('../src/core/config');
const { getManifest } = require('../src/install/manifest');
const llm = require('../src/install/llm');
const { buildSteps } = require('../src/install/setup');

const manifest = getManifest();

/** A fresh data folder, optionally with a saved config patch. */
function tmpPaths(patch = null) {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-chatcmd-')));
  if (patch) saveConfig(paths, patch);
  return paths;
}

/** UI stub that keeps every line, so tests can check the text. */
function quietUi() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return {
    lines,
    info: push, ok: push, warn: push, fail: push,
    table: (rows) => rows.forEach((r) => push(JSON.stringify(r))),
  };
}

/**
 * Stubbed dependencies: setup records what it was asked to do and can be made to fail.
 * @param {object} [o]
 */
function deps(paths, o = {}) {
  const calls = [];
  const d = {
    paths,
    manifest,
    ui: quietUi(),
    calls,
    serverRunning: () => Boolean(o.running),
    detect: async () => o.hw || { os: 'linux', arch: 'x64', ramGB: 16, freeDiskGB: 100, gpu: { vendor: 'nvidia', name: 'x', vramGB: 6 } },
    chatSteps: () => buildSteps().filter((s) => ['detect', 'chat-runtime', 'chat-model'].includes(s.id)),
    runSetup: async (options, setupDeps) => {
      calls.push({ options, steps: setupDeps.steps.map((s) => s.id) });
      if (o.setupFails) return { ok: false, summary: { error: 'boom' } };
      return { ok: true, summary: {} };
    },
  };
  return d;
}

test('chat device: accepts auto, cpu, gpu and saves it; rejects anything else', async () => {
  const paths = tmpPaths();
  const d = deps(paths);
  assert.throws(() => chat.device('tpu', d), /device must be one of auto, cpu, gpu/);
  assert.equal(loadConfig(paths).chat.device, 'auto');
  chat.device('cpu', d);
  assert.equal(loadConfig(paths).chat.device, 'cpu');
  assert.equal(d.ui.lines.some((l) => /restart Embernest/.test(l)), false);
});

test('chat device: prints the restart hint when the server is running', () => {
  const d = deps(tmpPaths(), { running: true });
  chat.device('gpu', d);
  assert.ok(d.ui.lines.some((l) => l === 'restart Embernest to apply'));
});

test('chat disable: turns chat off, keeps files, says how to delete them', () => {
  const paths = tmpPaths({ chat: { enabled: true, model: 'qwen3-4b' } });
  const d = deps(paths);
  chat.disable(d);
  assert.equal(loadConfig(paths).chat.enabled, false);
  assert.equal(loadConfig(paths).chat.model, 'qwen3-4b');
  assert.ok(d.ui.lines.some((l) => l.includes(paths.llm)));
  assert.equal(d.calls.length, 0);
});

test('chat use: rejects ids that are not in the manifest, before any setup', async () => {
  const d = deps(tmpPaths());
  await assert.rejects(chat.use('no-such-model', d), /unknown chat model "no-such-model"/);
  assert.equal(d.calls.length, 0);
});

test('chat use: an installed model is only selected, nothing is downloaded', async () => {
  const paths = tmpPaths();
  const model = llm.findChatModel(manifest, 'qwen3-4b');
  fs.mkdirSync(path.dirname(llm.modelFilePath(paths, model)), { recursive: true });
  fs.writeFileSync(llm.modelFilePath(paths, model), 'x');
  const d = deps(paths);
  await chat.use('qwen3-4b', d);
  assert.equal(d.calls.length, 0);
  assert.equal(loadConfig(paths).chat.model, 'qwen3-4b');
});

test('chat use: a missing model runs only the chat steps for that model, then selects it', async () => {
  const paths = tmpPaths();
  const d = deps(paths, { running: true });
  await chat.use('qwen25-7b', d);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].options.chatModel, 'qwen25-7b');
  assert.equal(d.calls[0].options.chat, true);
  assert.deepEqual(d.calls[0].steps, ['detect', 'chat-runtime', 'chat-model']);
  assert.equal(loadConfig(paths).chat.model, 'qwen25-7b');
  assert.ok(d.ui.lines.includes('restart Embernest to apply'));
});

test('chat use: a failed install leaves the selected model unchanged', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen3-4b' } });
  await assert.rejects(chat.use('qwen25-7b', deps(paths, { setupFails: true })), /boom/);
  assert.equal(loadConfig(paths).chat.model, 'qwen3-4b');
});

test('chat enable: reuses setup with the chat steps only and turns chat on', async () => {
  const paths = tmpPaths();
  const d = deps(paths);
  await chat.enable({ yes: true }, d);
  assert.equal(d.calls[0].options.chat, true);
  assert.equal(d.calls[0].options.yes, true);
  assert.equal('chatModel' in d.calls[0].options, false);
  assert.deepEqual(d.calls[0].steps, ['detect', 'chat-runtime', 'chat-model']);
  assert.equal(loadConfig(paths).chat.enabled, true);
});

test('chat enable --model: passes the exact id and saves it', async () => {
  const paths = tmpPaths();
  const d = deps(paths);
  await chat.enable({ model: 'qwen3-4b-abliterated' }, d);
  assert.equal(d.calls[0].options.chatModel, 'qwen3-4b-abliterated');
  assert.equal(loadConfig(paths).chat.model, 'qwen3-4b-abliterated');
});

test('chat enable: an unknown --model is rejected before setup runs', async () => {
  const paths = tmpPaths();
  const d = deps(paths);
  await assert.rejects(chat.enable({ model: 'nope' }, d), /unknown chat model/);
  assert.equal(d.calls.length, 0);
  assert.equal(loadConfig(paths).chat.enabled, false);
});

test('chat enable: a failed setup leaves chat off', async () => {
  const paths = tmpPaths();
  await assert.rejects(chat.enable({ yes: true }, deps(paths, { setupFails: true })), /boom/);
  assert.equal(loadConfig(paths).chat.enabled, false);
});

test('chat models: shows this machine class and the one above, with fit and installed columns', async () => {
  // 6 GB GPU on a 6 GB-RAM box: chat runs on the CPU, so RAM is the budget.
  const paths = tmpPaths({ hardware: { os: 'linux', arch: 'x64', ramGB: 6, gpu: { vendor: 'nvidia', vramGB: 6 } } });
  const d = deps(paths);
  const rows = await chat.models(d);
  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, ['qwen25-1b5', 'qwen25-1b5-abliterated', 'qwen3-4b', 'qwen3-4b-abliterated', 'qwen25-7b', 'qwen25-7b-abliterated', 'qwen3-4b-thinking', 'qwen3-4b-thinking-abliterated']);
  assert.deepEqual([...new Set(rows.map((r) => r.role))], ['fast', 'balanced', 'think']);
  assert.equal(rows.find((r) => r.id === 'qwen3-4b').fit, 'fits');
  assert.equal(rows.find((r) => r.id === 'qwen25-7b').fit, 'tight');
  assert.equal(rows.every((r) => r.installed === 'no'), true);
});

test('chat models: uses detection when no hardware is cached', async () => {
  const d = deps(tmpPaths());
  let detected = false;
  d.detect = async () => {
    detected = true;
    return { os: 'linux', arch: 'x64', ramGB: 32, gpu: { vendor: 'none' } };
  };
  const rows = await chat.models(d);
  assert.equal(detected, true);
  assert.ok(rows.some((r) => r.id === 'llama32-3b'));
});

test('shownClass: a class with no pinned models steps down', () => {
  assert.equal(chat.shownClass(manifest, '24B+'), '12-14B');
  assert.equal(chat.shownClass(manifest, '3-4B'), '3-4B');
});

test('chat: DEVICES lists the three accepted values', () => {
  assert.deepEqual(chat.DEVICES, ['auto', 'cpu', 'gpu']);
});

/** Bench deps on top of the stubs: a running or stopped engine, and a fake benchmark. */
function benchDeps(paths, { serving = true, served = null, installedIds = ['qwen25-1b5', 'qwen3-4b-thinking'], failBench = false } = {}) {
  for (const id of installedIds) {
    const model = llm.findChatModel(manifest, id);
    fs.mkdirSync(path.dirname(llm.modelFilePath(paths, model)), { recursive: true });
    fs.writeFileSync(llm.modelFilePath(paths, model), 'x');
  }
  const d = deps(paths);
  const log = { started: 0, stopped: 0, benched: [] };
  d.serving = async () => serving;
  d.servedModels = async () => served;
  d.startTemp = async () => { log.started++; return { url: 'http://temp', stop: async () => { log.stopped++; } }; };
  d.benchModels = async ({ models }) => {
    log.benched.push(...models.map((m) => m.id));
    if (failBench) throw new Error('bench broke');
    return models.map((m) => ({ model: m.id, role: m.role, ttft1Ms: 900, ttft2Ms: 700, promptTps: 80, genTps: 15, verdict: 'fast enough for chat' }));
  };
  return { d, log };
}

test('chat bench: uses the running engine and benches installed models only, fast before think', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const { d, log } = benchDeps(paths);
  const result = await chat.runBench({}, d);
  assert.equal(result.server, 'running');
  assert.deepEqual(log.benched, ['qwen25-1b5', 'qwen3-4b-thinking']);
  assert.equal(log.started, 0);
  assert.equal(result.models.length, 2);
});

test('chat bench: a running engine that does not load a model skips it and says so', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const { d, log } = benchDeps(paths, { served: ['qwen25-1b5'] });
  const result = await chat.runBench({}, d);
  assert.deepEqual(result.skipped, ['qwen3-4b-thinking']);
  assert.deepEqual(log.benched, ['qwen25-1b5']);
  assert.ok(d.ui.lines.some((l) => l.includes('Skipped')));
});

test('chat bench: with Embernest stopped, a temporary engine is started and always stopped', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const { d, log } = benchDeps(paths, { serving: false, failBench: true });
  await assert.rejects(chat.runBench({}, d), /bench broke/);
  assert.equal(log.started, 1);
  assert.equal(log.stopped, 1);
});

test('chat bench --json prints one JSON document with the server and the rows', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const { d } = benchDeps(paths, { serving: false });
  await chat.runBench({ json: true }, d);
  const parsed = JSON.parse(d.ui.lines[0]);
  assert.equal(parsed.server, 'temporary');
  assert.equal(parsed.models[0].model, 'qwen25-1b5');
  assert.equal(parsed.models[0].verdict, 'fast enough for chat');
});

test('chat bench: nothing installed is an error that says what to run', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const d = deps(paths);
  await assert.rejects(chat.runBench({}, d), /no chat model is installed. Run: embernest chat enable/);
});

test('chat think enable --model: installs a missing think model with the chat model, then selects it', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const d = deps(paths);
  await chat.thinkEnable({ model: 'qwen3-4b-thinking' }, d);
  assert.equal(d.calls[0].options.chatModel, 'qwen25-1b5');
  assert.equal(d.calls[0].options.chatThinkModel, 'qwen3-4b-thinking');
  assert.equal(loadConfig(paths).chat.thinkModel, 'qwen3-4b-thinking');
});

test('chat think use: an installed think model is only selected', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  const model = llm.findChatModel(manifest, 'qwen3-4b-thinking');
  fs.mkdirSync(path.dirname(llm.modelFilePath(paths, model)), { recursive: true });
  fs.writeFileSync(llm.modelFilePath(paths, model), 'x');
  const d = deps(paths);
  await chat.thinkUse('qwen3-4b-thinking', d);
  assert.equal(d.calls.length, 0);
  assert.equal(loadConfig(paths).chat.thinkModel, 'qwen3-4b-thinking');
});

test('chat think: refuses a non-think model, an unknown id, and a missing chat setup', async () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5' } });
  await assert.rejects(chat.thinkUse('qwen25-1b5', deps(paths)), /is not a think model \(role fast\)/);
  await assert.rejects(chat.thinkUse('no-such', deps(paths)), /unknown chat model "no-such"/);
  const bare = tmpPaths();
  await assert.rejects(chat.thinkUse('qwen3-4b-thinking', deps(bare)), /chat is not set up yet/);
});

test('chat think disable: clears the think model and keeps the files', () => {
  const paths = tmpPaths({ chat: { model: 'qwen25-1b5', thinkModel: 'qwen3-4b-thinking' } });
  chat.thinkDisable(deps(paths));
  assert.equal(loadConfig(paths).chat.thinkModel, '');
});
