'use strict';
const fs = require('node:fs');
const { getPaths } = require('../../core/paths');
const { loadConfig, saveConfig } = require('../../core/config');
const { readJson } = require('../../core/state');
const { planForHardware, chatPlan } = require('../../core/tiers');
const { detectHardware } = require('../../core/hardware');
const { getManifest } = require('../../install/manifest');
const llm = require('../../install/llm');
const bench = require('../../runtime/bench');
const ui = require('../ui');

const DEVICES = ['auto', 'cpu', 'gpu'];
const SIZE_ORDER = ['1-3B', '3-4B', '7-8B', '12-14B', '24B+'];
const ROLE_ORDER = ['fast', 'balanced', 'think'];
const RESTART_HINT = 'restart Embernest to apply';
/** Headroom: a model needs its file size plus about 1 GB for context and buffers. */
const OVERHEAD_GB = 1;
/** A model "fits" when it needs at most this share of the memory it runs in. */
const FIT_SHARE = 0.75;

/** Chat setup steps only: the engine and the model, nothing else. */
const CHAT_STEPS = ['detect', 'chat-runtime', 'chat-model'];
const ROLE_RANK = (m) => ROLE_ORDER.indexOf(m.role || 'balanced');

/**
 * Real dependencies, overridable in tests (stubbed setup and I/O).
 * @returns {object}
 */
function defaultDeps() {
  const { runSetup, buildSteps } = require('../../install/setup');
  const { pidAlive } = require('../../runtime/server-runner');
  return {
    paths: getPaths(),
    runSetup,
    chatSteps: () => buildSteps().filter((s) => CHAT_STEPS.includes(s.id)),
    serverRunning: (paths) => {
      const state = readJson(paths.state, null);
      return Boolean(state) && pidAlive(state.pid);
    },
    detect: detectHardware,
    manifest: getManifest(),
    serving: bench.isServing,
    servedModels: bench.servedModelIds,
    startTemp: bench.startBenchServer,
    benchModels: bench.benchModels,
    ui,
  };
}

/** Print the restart hint when the server is running. */
function restartHint(deps) {
  if (deps.serverRunning(deps.paths)) deps.ui.warn(RESTART_HINT);
}

/**
 * Run the chat-only setup steps. Setup's own detect step asks for confirmation
 * unless `yes` is set.
 * @param {object} deps
 * @param {{ chatModel?: string, chatThinkModel?: string, yes?: boolean }} opts
 */
async function installChat(deps, { chatModel, chatThinkModel, yes = false } = {}) {
  const options = { chat: true, yes };
  if (chatModel) options.chatModel = chatModel;
  if (chatThinkModel) options.chatThinkModel = chatThinkModel;
  const { ok, summary } = await deps.runSetup(options, { paths: deps.paths, steps: deps.chatSteps() });
  if (!ok) {
    if (summary.cancelled) deps.ui.info('Cancelled, nothing was changed.');
    throw new Error(summary.error || 'chat setup did not finish');
  }
}

/**
 * `chat enable [--model <id>]`: install the chat engine and model, then turn chat on.
 * @param {{ model?: string, yes?: boolean }} [opts]
 * @param {object} [deps]
 */
async function enable(opts = {}, deps = defaultDeps()) {
  if (opts.model) llm.findChatModel(deps.manifest, opts.model);
  await installChat(deps, { chatModel: opts.model, yes: opts.yes });
  const cfg = saveConfig(deps.paths, { chat: { enabled: true, ...(opts.model ? { model: opts.model } : {}) } });
  deps.ui.ok(`Chat is on (model ${cfg.chat.model || 'not set'}).`);
  restartHint(deps);
}

/**
 * `chat disable`: turn chat off. Files are kept.
 * @param {object} [deps]
 */
function disable(deps = defaultDeps()) {
  saveConfig(deps.paths, { chat: { enabled: false } });
  deps.ui.ok('Chat is off. Files are kept.');
  deps.ui.info(`  To delete them: rm -rf "${deps.paths.llm}"`);
  restartHint(deps);
}

/** @param {number} gb @returns {string} */
const gbText = (gb) => (gb / 1024).toFixed(1);

/**
 * The size class to show: this machine's class, or the next one down when the
 * pinned models have none (the same rule as chatModelChoices).
 * @param {object} manifest
 * @param {string} sizeClass
 * @returns {string}
 */
function shownClass(manifest, sizeClass) {
  const have = new Set(manifest.llm.models.map((m) => m.sizeClass));
  let idx = SIZE_ORDER.indexOf(sizeClass);
  while (idx > 0 && !have.has(SIZE_ORDER[idx])) idx -= 1;
  return SIZE_ORDER[idx];
}

/**
 * Rows for `chat models`: fast and think models, plus the balanced models of this machine's size class and the one above it.
 * @param {object} deps
 * @returns {Promise<object[]>}
 */
async function modelRows(deps) {
  const cfg = loadConfig(deps.paths);
  const hw = cfg.hardware && cfg.hardware.gpu && cfg.hardware.os ? cfg.hardware : await deps.detect({ dataDir: deps.paths.home });
  const plan = planForHardware(hw);
  const device = llm.resolveDevice(cfg, plan);
  const memGB = device === 'gpu' ? plan.effectiveVramGB : (hw.ramGB || 0);
  const base = SIZE_ORDER.indexOf(shownClass(deps.manifest, plan.llm.sizeClass));
  const classes = [SIZE_ORDER[base], SIZE_ORDER[base + 1]].filter(Boolean);

  // fast and think models are small and the same for every tier; balanced ones follow the size class.
  const shown = deps.manifest.llm.models.filter((m) => (m.role || 'balanced') !== 'balanced' || classes.includes(m.sizeClass));
  const rank = (m) => ROLE_ORDER.indexOf(m.role || 'balanced');
  return [...shown].sort((a, b) => rank(a) - rank(b))
    .map((m) => {
      const needGB = m.sizeMB / 1024 + OVERHEAD_GB;
      return {
        id: m.id,
        label: m.label,
        role: m.role || 'balanced',
        variant: m.variant,
        size: `${gbText(m.sizeMB)} GB`,
        fit: needGB <= memGB * FIT_SHARE ? 'fits' : 'tight',
        installed: fs.existsSync(llm.modelFilePath(deps.paths, m)) ? 'yes' : 'no',
      };
    });
}

/**
 * `chat models`: table of models for this machine.
 * @param {object} [deps]
 */
async function models(deps = defaultDeps()) {
  const rows = await modelRows(deps);
  if (!rows.length) {
    deps.ui.info('No chat models are pinned for this machine.');
    return rows;
  }
  deps.ui.table(rows);
  return rows;
}

/**
 * `chat use <id>`: install the model when it is missing, then select it.
 * @param {string} id manifest model id
 * @param {object} [deps]
 */
async function use(id, deps = defaultDeps()) {
  const model = llm.findChatModel(deps.manifest, id);
  if (!fs.existsSync(llm.modelFilePath(deps.paths, model))) {
    await installChat(deps, { chatModel: id });
  }
  saveConfig(deps.paths, { chat: { model: id } });
  deps.ui.ok(`Chat model is ${id}.`);
  restartHint(deps);
}

/** Installed chat models, fast first, then balanced, then think. */
function installedModels(deps) {
  return deps.manifest.llm.models
    .filter((m) => fs.existsSync(llm.modelFilePath(deps.paths, m)))
    .sort((a, b) => ROLE_RANK(a) - ROLE_RANK(b));
}

/**
 * `chat bench`: time each installed model (first token on two turns, prompt and generation speed).
 * Uses the running chat engine, or starts a temporary one on a free port and always stops it.
 * @param {{ json?: boolean }} [opts]
 * @param {object} [deps]
 * @returns {Promise<object>} the result: { server, models, skipped }
 */
async function runBench(opts = {}, deps = defaultDeps()) {
  const cfg = loadConfig(deps.paths);
  const installed = installedModels(deps);
  if (!installed.length) throw new Error('no chat model is installed. Run: embernest chat enable');

  let server;
  let models = installed;
  let target;
  if (await deps.serving(cfg.chat.url)) {
    server = 'running';
    const served = await deps.servedModels(cfg.chat.url);
    if (served) models = installed.filter((m) => served.includes(m.id));
    target = { url: cfg.chat.url, stop: async () => {} };
  } else {
    server = 'temporary';
    target = await deps.startTemp(deps.paths, cfg, installed);
  }
  const skipped = installed.filter((m) => !models.includes(m)).map((m) => m.id);
  let rows;
  try {
    rows = await deps.benchModels({ url: target.url, models });
  } finally {
    await target.stop();
  }
  const result = { server, models: rows, skipped };
  if (opts.json) {
    deps.ui.info(JSON.stringify(result, null, 2));
    return result;
  }
  deps.ui.info(server === 'running'
    ? 'Benchmark against the running chat engine.'
    : 'Embernest is not running, so a temporary chat engine was started for the benchmark.');
  deps.ui.table(bench.formatBenchRows(rows));
  if (skipped.length) deps.ui.warn(`Skipped (not loaded by the running engine): ${skipped.join(', ')}. Restart Embernest to load them.`);
  deps.ui.info(`Target: first token within ${bench.TARGET.firstTokenMs / 1000} s on turn 2 and at least ${bench.TARGET.genTps} tokens/s.`);
  return result;
}

/**
 * Pick the "Think harder" model for this machine: the same variant as the chat model when it exists.
 * @param {object} deps
 * @returns {Promise<object>} manifest entry
 */
async function suggestThink(deps) {
  const cfg = loadConfig(deps.paths);
  const hw = cfg.hardware && cfg.hardware.gpu && cfg.hardware.os ? cfg.hardware : await deps.detect({ dataDir: deps.paths.home });
  const plan = planForHardware(hw);
  const choices = llm.chatModelChoices(deps.manifest, plan, chatPlan(hw, plan, cfg.chat.device));
  const main = deps.manifest.llm.models.find((m) => m.id === cfg.chat.model);
  const variant = main && main.variant === 'uncensored' ? 'uncensored' : 'mainstream';
  const pick = choices.think[variant] || choices.think.mainstream || choices.think.uncensored;
  if (!pick) throw new Error('no think model fits this machine');
  return pick;
}

/**
 * Install (when missing) and select the "Think harder" model. Needs the chat model set up first.
 * @param {string} id manifest model id with role think
 * @param {object} deps
 * @param {{ yes?: boolean }} [opts]
 */
async function setThink(id, deps, { yes = false } = {}) {
  const model = llm.findChatModel(deps.manifest, id);
  if (model.role !== 'think') throw new Error(`"${id}" is not a think model (role ${model.role})`);
  const cfg = loadConfig(deps.paths);
  if (!cfg.chat.model) throw new Error('chat is not set up yet. Run: embernest chat enable');
  if (!fs.existsSync(llm.modelFilePath(deps.paths, model))) {
    await installChat(deps, { chatModel: cfg.chat.model, chatThinkModel: id, yes });
  }
  saveConfig(deps.paths, { chat: { thinkModel: id } });
  deps.ui.ok(`Think harder model is ${id}.`);
  restartHint(deps);
}

/**
 * `chat think enable [--model <id>]`: pick (or take) the think model, install it and select it.
 * @param {{ model?: string, yes?: boolean }} [opts]
 * @param {object} [deps]
 */
async function thinkEnable(opts = {}, deps = defaultDeps()) {
  const id = opts.model || (await suggestThink(deps)).id;
  await setThink(id, deps, { yes: opts.yes });
}

/**
 * `chat think use <id>`: same as enable with an explicit id.
 * @param {string} id
 * @param {object} [deps]
 */
async function thinkUse(id, deps = defaultDeps()) {
  await setThink(id, deps);
}

/**
 * `chat think disable`: Think harder off. Files are kept.
 * @param {object} [deps]
 */
function thinkDisable(deps = defaultDeps()) {
  saveConfig(deps.paths, { chat: { thinkModel: '' } });
  deps.ui.ok('Think harder is off. Files are kept.');
  restartHint(deps);
}

/**
 * `chat device <auto|cpu|gpu>`.
 * @param {string} value
 * @param {object} [deps]
 */
function device(value, deps = defaultDeps()) {
  if (!DEVICES.includes(value)) throw new Error(`device must be one of ${DEVICES.join(', ')}`);
  saveConfig(deps.paths, { chat: { device: value } });
  deps.ui.ok(`Chat device is ${value}.`);
  restartHint(deps);
}

/**
 * Register `embernest chat ...`.
 * @param {import('commander').Command} program
 */
function register(program) {
  const chat = program.command('chat').description('Local chat companion (llama.cpp)');

  chat.command('enable')
    .description('Install the chat engine and model, then turn chat on')
    .option('--model <id>', 'chat model id from the manifest')
    .option('--yes', 'do not ask for confirmation')
    .action((opts) => enable(opts));

  chat.command('disable')
    .description('Turn chat off (keeps the downloaded files)')
    .action(() => disable());

  chat.command('models')
    .description('List chat models for this machine')
    .action(() => models());

  chat.command('use <id>')
    .description('Select a chat model (installs it when missing)')
    .action((id) => use(id));

  chat.command('device <value>')
    .description('Run chat on: auto, cpu or gpu')
    .action((value) => device(value));

  chat.command('bench')
    .description('Time each installed chat model: first token, prompt and generation speed')
    .option('--json', 'print the results as JSON')
    .action((opts) => runBench(opts));

  const think = chat.command('think').description('"Think harder" model for tricky questions (per message)');
  think.command('enable')
    .description('Install a think model (or --model) and turn Think harder on')
    .option('--model <id>', 'think model id from the manifest')
    .option('--yes', 'do not ask for confirmation')
    .action((opts) => thinkEnable(opts));
  think.command('use <id>')
    .description('Select a think model (installs it when missing)')
    .action((id) => thinkUse(id));
  think.command('disable')
    .description('Turn Think harder off (keeps the downloaded files)')
    .action(() => thinkDisable());
}

module.exports = {
  register, enable, disable, models, use, device, modelRows, shownClass, DEVICES,
  runBench, thinkEnable, thinkUse, thinkDisable, suggestThink,
};
