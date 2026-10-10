'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const llm = require('../src/install/llm');
const { getManifest } = require('../src/install/manifest');
const { planForHardware } = require('../src/core/tiers');
const { getPaths } = require('../src/core/paths');
const { decideChat } = require('../src/install/setup');
const { saveConfig } = require('../src/core/config');

const manifest = getManifest();
const hw = (osName, arch, vendor, extra = {}) => ({ os: osName, arch, ramGB: 16, freeDiskGB: 100, gpu: { vendor, vramGB: 8, ...extra } });

test('pickServerAsset: cpu device uses the cpu build', () => {
  assert.equal(llm.pickServerAsset(manifest, hw('linux', 'x64', 'nvidia'), 'cpu').key, 'linux-x64-cpu');
  assert.equal(llm.pickServerAsset(manifest, hw('win32', 'x64', 'nvidia'), 'cpu').key, 'win32-x64-cpu');
  assert.equal(llm.pickServerAsset(manifest, hw('darwin', 'x64', 'none'), 'cpu').key, 'darwin-x64-cpu');
});

test('pickServerAsset: gpu backends per OS and vendor', () => {
  const key = (o, a, v) => llm.pickServerAsset(manifest, hw(o, a, v), 'gpu').key;
  assert.equal(key('win32', 'x64', 'nvidia'), 'win32-x64-cuda');
  assert.equal(key('linux', 'x64', 'nvidia'), 'linux-x64-vulkan');
  assert.equal(key('linux', 'x64', 'amd'), 'linux-x64-vulkan');
  assert.equal(key('linux', 'x64', 'intel'), 'linux-x64-vulkan');
  assert.equal(key('win32', 'x64', 'amd'), 'win32-x64-vulkan');
  assert.equal(key('win32', 'x64', 'intel'), 'win32-x64-vulkan');
  assert.equal(key('darwin', 'arm64', 'apple'), 'darwin-arm64-metal');
  assert.equal(key('darwin', 'x64', 'none'), 'darwin-x64-cpu');
});

test('pickServerAsset: apple silicon always uses the metal build, even for cpu', () => {
  assert.equal(llm.pickServerAsset(manifest, hw('darwin', 'arm64', 'apple'), 'cpu').key, 'darwin-arm64-metal');
});

test('pickServerAsset: a missing backend falls back to cpu with a warning', () => {
  const trimmed = structuredClone(manifest);
  delete trimmed.llm.server.assets['linux-x64-vulkan'];
  const a = llm.pickServerAsset(trimmed, hw('linux', 'x64', 'nvidia'), 'gpu');
  assert.equal(a.key, 'linux-x64-cpu');
  assert.match(a.warning, /vulkan/);
  assert.equal(llm.pickServerAsset(manifest, hw('linux', 'x64', 'nvidia'), 'gpu').warning, null);
});

test('pickServerAsset: windows cuda carries the cudart extra; unknown platform throws', () => {
  assert.equal(llm.pickServerAsset(manifest, hw('win32', 'x64', 'nvidia'), 'gpu').extra.length, 1);
  assert.throws(() => llm.pickServerAsset(manifest, hw('linux', 'arm64', 'none'), 'cpu'), /no llama.cpp build/);
});

test('chatModelChoices: both variants for every tier, 24B+ reuses the next class down', () => {
  for (const vram of [0, 3, 6, 8, 12, 24]) {
    const plan = planForHardware(hw('linux', 'x64', vram ? 'nvidia' : 'none', { vramGB: vram }));
    const c = llm.chatModelChoices(manifest, plan);
    assert.equal(c.mainstream.variant, 'mainstream', plan.id);
    assert.equal(c.uncensored.variant, 'uncensored', plan.id);
    assert.equal(c.mainstream.base, c.uncensored.base, plan.id);
  }
  const low = planForHardware(hw('linux', 'x64', 'nvidia', { vramGB: 6 }));
  assert.equal(llm.chatModelChoices(manifest, low).mainstream.id, 'qwen3-4b');
});

test('resolveDevice: auto is cpu up to 8 GB effective VRAM and gpu above', () => {
  const dev = (device, effectiveVramGB) => llm.resolveDevice({ chat: { device } }, { effectiveVramGB });
  assert.equal(dev('auto', 0), 'cpu');
  assert.equal(dev('auto', 6), 'cpu');
  assert.equal(dev('auto', 8), 'cpu');
  assert.equal(dev('auto', 8.1), 'gpu');
  assert.equal(dev('auto', 24), 'gpu');
  assert.equal(dev('cpu', 24), 'cpu');
  assert.equal(dev('gpu', 0), 'gpu');
});

test('installedServer is null until the marker and binary exist', () => {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-llm-')));
  assert.equal(llm.installedServer(paths, manifest, 'linux-x64-cpu'), null);
  const dir = path.join(paths.llm, 'server', manifest.llm.server.tag, 'linux-x64-cpu');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, llm.MARKER), JSON.stringify({ file: 'x', bin: path.join('sub', 'llama-server') }));
  assert.equal(llm.installedServer(paths, manifest, 'linux-x64-cpu'), null);
  fs.writeFileSync(path.join(dir, 'sub', 'llama-server'), '');
  assert.equal(llm.installedServer(paths, manifest, 'linux-x64-cpu'), path.join(dir, 'sub', 'llama-server'));
});

test('findChatModel rejects unknown ids', () => {
  assert.equal(llm.findChatModel(manifest, 'qwen3-4b').variant, 'mainstream');
  assert.throws(() => llm.findChatModel(manifest, 'nope'), /unknown chat model/);
});

// ---- setup prompt logic with stubbed I/O ----

function chatCtx(options = {}, { interactive = true, answers = {}, cfg = null, ramGB = 16, vramGB = 6 } = {}) {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-chat-')));
  if (cfg) saveConfig(paths, cfg);
  const asked = [];
  const machine = { ...hw('linux', 'x64', 'nvidia', { vramGB }), ramGB };
  return {
    asked, paths, options, manifest, interactive,
    hw: machine,
    plan: planForHardware(machine),
    confirm: async (q) => { asked.push(q); return typeof answers.confirm === 'function' ? answers.confirm(q) : (answers.confirm ?? false); },
    choose: async (q, labels) => { asked.push(labels); return answers.choose ?? 0; },
  };
}

test('decideChat: --yes without --chat adds no chat and asks nothing', async () => {
  const ctx = chatCtx({ yes: true });
  assert.deepEqual(await decideChat(ctx), { enabled: false });
  assert.equal(ctx.asked.length, 0);
});

test('decideChat: --chat --yes picks the default role for the machine; --no-chat turns chat off', async () => {
  // 16 GB RAM on the CPU: fast. 32 GB RAM: balanced.
  assert.equal((await decideChat(chatCtx({ chat: true, yes: true }))).model.id, 'qwen25-1b5');
  assert.equal((await decideChat(chatCtx({ chat: true, yes: true }, { ramGB: 32 }))).model.id, 'qwen3-4b');
  assert.deepEqual(await decideChat(chatCtx({ chat: false })), { enabled: false, off: true });
});

test('decideChat: --chat-model picks an exact id and rejects unknown ones', async () => {
  assert.equal((await decideChat(chatCtx({ chatModel: 'qwen3-4b-abliterated', yes: true }))).model.variant, 'uncensored');
  await assert.rejects(decideChat(chatCtx({ chatModel: 'nope' })), /unknown chat model/);
});

test('decideChat: interactive asks the chat question, the model menu, then the think question', async () => {
  const no = chatCtx({}, { answers: { confirm: false } });
  assert.equal((await decideChat(no)).enabled, false);
  assert.match(no.asked[0], /Add a chat companion\? \(1\.1 GB download\)/);

  const second = chatCtx({}, { answers: { confirm: true, choose: 1 } });
  const res = await decideChat(second);
  assert.equal(res.model.id, 'qwen25-1b5-abliterated');
  // order: chat question, model menu, think question
  assert.match(second.asked[0], /Add a chat companion\?/);
  assert.equal(second.asked[1].length, 4);
  assert.match(second.asked[1][0], /\(recommended, quick replies\)/);
  assert.match(second.asked[1][1], /quick replies/);
  assert.doesNotMatch(second.asked[1][2], /recommended/);
  assert.match(second.asked[2], /^Also add a "Think harder" model for tricky questions\? \(\+2\.4 GB\)$/);
  assert.equal(res.think.id, 'qwen3-4b-thinking-abliterated');

  const first = await decideChat(chatCtx({}, { answers: { confirm: true, choose: 0 } }));
  assert.equal(first.model.id, 'qwen25-1b5');
  assert.equal(first.think.id, 'qwen3-4b-thinking');
});

test('decideChat: declining the think question leaves thinkModel unset; roomy machines recommend balanced', async () => {
  const ctx = chatCtx({}, { answers: { confirm: (q) => /^Add a chat/.test(q), choose: 2 } });
  const res = await decideChat(ctx);
  assert.equal(res.model.id, 'qwen3-4b');
  assert.equal(res.think, null);

  const big = chatCtx({}, { ramGB: 32, answers: { confirm: true, choose: 2 } });
  const out = await decideChat(big);
  assert.equal(out.model.id, 'qwen3-4b');
  assert.match(big.asked[1][2], /\(recommended\)/);
  assert.doesNotMatch(big.asked[1][0], /recommended/);
});

test('decideChat: the menu lists only models that fit the budget', async () => {
  // 4 GB RAM: budget 1433 MB, so only the two fast models fit.
  const ctx = chatCtx({}, { ramGB: 4, answers: { confirm: true } });
  await decideChat(ctx);
  assert.equal(ctx.asked[1].length, 2);
  assert.match(ctx.asked[1][0], /Qwen2\.5 1\.5B/);
});

test('decideChat: think flags', async () => {
  const on = await decideChat(chatCtx({ chat: true, chatThink: true, yes: true }));
  assert.equal(on.think.id, 'qwen3-4b-thinking');
  const own = await decideChat(chatCtx({ chat: true, chatThinkModel: 'qwen3-4b-thinking-abliterated', yes: true }));
  assert.equal(own.think.id, 'qwen3-4b-thinking-abliterated');
  const off = await decideChat(chatCtx({ chat: true, chatThink: false, yes: true }));
  assert.deepEqual([off.think, off.thinkOff], [null, true]);
  const unc = await decideChat(chatCtx({ chatModel: 'qwen25-1b5-abliterated', chatThink: true }));
  assert.equal(unc.think.id, 'qwen3-4b-thinking-abliterated');
  await assert.rejects(decideChat(chatCtx({ chat: true, chatThinkModel: 'qwen3-4b' })), /not a think model/);
  await assert.rejects(decideChat(chatCtx({ chat: true, chatThinkModel: 'nope' })), /unknown chat model/);
});

test('decideChat: no prompt when not interactive or in dry-run', async () => {
  const a = chatCtx({}, { interactive: false });
  assert.equal((await decideChat(a)).enabled, false);
  const b = chatCtx({ dryRun: true });
  assert.equal((await decideChat(b)).enabled, false);
  assert.equal(a.asked.length + b.asked.length, 0);
});

test('decideChat: chat that is already enabled stays on without asking, even with --yes', async () => {
  const cfg = { chat: { enabled: true, model: 'qwen3-4b-abliterated' } };
  const ctx = chatCtx({ yes: true }, { cfg });
  assert.equal((await decideChat(ctx)).model.id, 'qwen3-4b-abliterated');
  assert.equal((await decideChat(chatCtx({ chat: true, yes: true }, { cfg }))).model.id, 'qwen3-4b-abliterated');
  assert.equal(ctx.asked.length, 0);
});

test('decideChat: a saved think model is kept without asking', async () => {
  const cfg = { chat: { enabled: true, model: 'qwen3-4b', thinkModel: 'qwen3-4b-thinking' } };
  const ctx = chatCtx({ yes: true }, { cfg });
  assert.equal((await decideChat(ctx)).think.id, 'qwen3-4b-thinking');
  assert.equal(ctx.asked.length, 0);
});

test('chatModelChoices: roles, default role and budget', () => {
  const { chatPlan } = require('../src/core/tiers');
  const machine = (ramGB, vramGB) => {
    const h = { ...hw('linux', 'x64', vramGB ? 'nvidia' : 'none', { vramGB }), ramGB };
    const plan = planForHardware(h);
    return llm.chatModelChoices(manifest, plan, chatPlan(h, plan));
  };
  const cpu = machine(15.5, 6);
  assert.equal(cpu.defaultRole, 'fast');
  assert.equal(cpu.mainstream.id, 'qwen25-1b5');
  assert.equal(cpu.uncensored.id, 'qwen25-1b5-abliterated');
  assert.equal(cpu.balanced.mainstream.id, 'qwen3-4b');
  assert.equal(cpu.think.mainstream.id, 'qwen3-4b-thinking');
  const tiny = machine(4, 0);
  assert.equal(tiny.balanced.mainstream, null);
  assert.equal(tiny.think.mainstream, null);
  assert.equal(tiny.fast.mainstream.id, 'qwen25-1b5');
  const gpu = machine(32, 24);
  assert.equal(gpu.defaultRole, 'balanced');
  assert.equal(gpu.mainstream.sizeClass, '12-14B');
  for (const c of [cpu, tiny, gpu]) {
    for (const m of [c.fast, c.balanced, c.think]) {
      for (const v of [m.mainstream, m.uncensored]) if (v) assert.ok(v.sizeMB > 0);
    }
  }
});
