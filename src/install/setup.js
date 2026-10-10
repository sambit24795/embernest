'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getPaths, ensureDirs } = require('../core/paths');
const { detectHardware } = require('../core/hardware');
const { planForHardware, chatPlan } = require('../core/tiers');
const { loadConfig, saveConfig, generateToken, migrateLegacy } = require('../core/config');
const { readJson, writeJson } = require('../core/state');
const { createLogger } = require('../core/log');
const { run } = require('../core/exec');
const ui = require('../cli/ui');
const { getManifest } = require('./manifest');
const { ensureUv, uvVersion } = require('./uv');
const { ensureVenv, venvVersion } = require('./python');
const { installTorch, probeTorch, EXPECTED_DEVICE } = require('./torch');
const { installComfy, verifyComfy, MARKER } = require('./comfyui');
const { planModels, missingModels, installModels } = require('./models');
const { warmup } = require('../server/safety');
const llm = require('./llm');

const MB = 1024 * 1024;
const GPU_VENDORS = ['nvidia', 'amd', 'apple', 'intel', 'cpu'];

/** Thrown when the user answers "no" at the confirmation prompt. */
class SetupCancelled extends Error {}

/** @param {object} ctx */
const isExternal = (ctx) => Boolean(ctx.options.comfyDir || ctx.options.comfyUrl);

/** @param {object} ctx @returns {string} ComfyUI folder this setup uses */
function comfyDirOf(ctx) {
  return isExternal(ctx)
    ? (ctx.options.comfyDir ? path.resolve(ctx.options.comfyDir) : '')
    : path.join(ctx.paths.comfyRoot, ctx.manifest.comfyui.tag);
}

/** @param {object} ctx @returns {string|null} models folder, or null when there is none to fill */
function modelsDirOf(ctx) {
  if (!isExternal(ctx)) return ctx.paths.models;
  const dir = comfyDirOf(ctx);
  return dir ? path.join(dir, 'models') : null;
}

/** @param {object} ctx @returns {string} python that runs the safety worker ('' when unknown) */
function safetyPythonOf(ctx) {
  if (!isExternal(ctx)) return ctx.paths.venvPython;
  return ctx.options.comfyPython ? path.resolve(ctx.options.comfyPython) : loadConfig(ctx.paths).comfy.python;
}

/** Port ComfyUI listens on: from --comfy-url, else the saved config, else 8188. */
function comfyPortOf(ctx) {
  if (ctx.options.comfyUrl) {
    try {
      const u = new URL(ctx.options.comfyUrl);
      return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch (_) {
      throw new Error(`--comfy-url is not a valid URL: ${ctx.options.comfyUrl}`);
    }
  }
  return loadConfig(ctx.paths).comfy.port || 8188;
}

/** @returns {string} the URL the Embernest server will use for ComfyUI */
function comfyUrlOf(ctx) {
  return ctx.options.comfyUrl ? ctx.options.comfyUrl.replace(/\/+$/, '') : `http://127.0.0.1:${comfyPortOf(ctx)}`;
}

/** Recorded step results from run/setup.json. */
function readRecords(paths) {
  return (readJson(paths.setupState, {}) || {}).steps || {};
}

/** @param {object} ctx @param {string} id @param {string} [version] */
function record(ctx, id, version = '') {
  const steps = readRecords(ctx.paths);
  steps[id] = { id, doneAt: new Date().toISOString(), version: version || '' };
  writeJson(ctx.paths.setupState, { steps });
}

/** Progress callback factory: one bar per label, finished when the download ends. */
function makeProgress(label, fallbackTotal = 0) {
  let bar = null;
  return {
    onProgress(p) {
      const total = p.total || fallbackTotal;
      if (!bar) bar = ui.progressBar({ label, total });
      bar.update(p.received);
    },
    finish() {
      if (bar) bar.done();
      bar = null;
    },
  };
}

/** Check that a user-supplied ComfyUI folder/python looks right (read-only). */
async function validateExternal(ctx) {
  const dir = comfyDirOf(ctx);
  if (dir && !fs.existsSync(path.join(dir, 'main.py'))) {
    throw new Error(`--comfy-dir ${dir} has no main.py, is it a ComfyUI folder?`);
  }
  if (ctx.options.comfyPython) {
    try {
      await run(ctx.options.comfyPython, ['-c', 'import torch'], { timeoutMs: 120000 });
    } catch (_) {
      throw new Error(`${ctx.options.comfyPython} cannot import torch, pass the python that runs your ComfyUI`);
    }
  }
}

const gbOf = (mb) => (mb / 1024).toFixed(1);

/** The chat model files this run installs: the default model, plus the think model if any. */
const chatModelsOf = (ctx) => [ctx.chat.model, ctx.chat.think].filter(Boolean);

/** Menu text for one model: its size, plus a tag for the role and for the recommendation. */
function modelOption(model, recommended) {
  const tags = [recommended && 'recommended', model.role === 'fast' && 'quick replies'].filter(Boolean);
  return `${model.label} (${gbOf(model.sizeMB)} GB)${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

/**
 * The "Think harder" model for this run, or none. Flags win, then a think model already
 * in the config. Only a fresh interactive choice asks.
 * @returns {Promise<{ think: object|null, thinkOff?: boolean }>}
 */
async function decideThink(ctx, model, choices, { ask }) {
  const { options, manifest } = ctx;
  if (options.chatThink === false) return { think: null, thinkOff: true };
  if (options.chatThinkModel) {
    const picked = llm.findChatModel(manifest, options.chatThinkModel);
    if (picked.role !== 'think') throw new Error(`"${picked.id}" is not a think model (role ${picked.role})`);
    return { think: picked };
  }
  const variant = model.variant === 'uncensored' ? 'uncensored' : 'mainstream';
  const suggested = choices.think[variant] || choices.think.mainstream || choices.think.uncensored;
  if (options.chatThink === true) {
    if (!suggested) throw new Error('no think model fits this machine');
    return { think: suggested };
  }
  const have = manifest.llm.models.find((m) => m.id === loadConfig(ctx.paths).chat.thinkModel);
  if (have) return { think: have };
  if (!ask || !suggested) return { think: null };
  const question = `Also add a "Think harder" model for tricky questions? (+${gbOf(suggested.sizeMB)} GB)`;
  return { think: (await ctx.confirm(question, { yes: false })) ? suggested : null };
}

/**
 * Decide whether this run installs the chat companion, which model, and an optional
 * "Think harder" model. Flags win; otherwise a chat that is already enabled stays on;
 * otherwise an interactive run is asked, and a non-interactive one (--yes, no TTY,
 * dry-run) adds none. Models are fitted to the machine's chat budget (chatPlan).
 * @param {object} ctx needs options, manifest, hw, plan, paths, interactive, confirm, choose
 * @returns {Promise<{ enabled: boolean, off?: boolean, model?: object, think?: object|null, thinkOff?: boolean }>}
 */
async function decideChat(ctx) {
  const { options, manifest } = ctx;
  if (options.chat === false) return { enabled: false, off: true };
  const cfg = loadConfig(ctx.paths);
  const known = cfg.chat.enabled && manifest.llm.models.find((m) => m.id === cfg.chat.model);
  ctx.chatPlan = chatPlan(ctx.hw, ctx.plan, cfg.chat.device);
  const choices = llm.chatModelChoices(manifest, ctx.plan, ctx.chatPlan);
  const withThink = async (model, ask) => ({ enabled: true, model, ...(await decideThink(ctx, model, choices, { ask })) });
  if (options.chatModel) return withThink(llm.findChatModel(manifest, options.chatModel), false);

  const interactive = ctx.interactive && !options.yes && !options.dryRun;
  const pick = async () => {
    if (!choices.mainstream) throw new Error('no chat model fits this machine');
    if (!interactive) return choices.mainstream;
    const list = [choices.fast.mainstream, choices.fast.uncensored, choices.balanced.mainstream, choices.balanced.uncensored]
      .filter((m, i, all) => m && all.indexOf(m) === i);
    if (list.length < 2) return list[0];
    const labels = list.map((m) => modelOption(m, m === choices.mainstream));
    return list[await ctx.choose('Model:', labels, { defaultIndex: Math.max(0, list.indexOf(choices.mainstream)) })];
  };
  if (options.chat === true) return known ? withThink(known, false) : withThink(await pick(), interactive);
  if (known) return withThink(known, false);
  if (!interactive || !choices.mainstream) return { enabled: false };
  const question = `Add a chat companion? (${gbOf(choices.mainstream.sizeMB)} GB download)`;
  return (await ctx.confirm(question, { yes: false })) ? withThink(await pick(), true) : { enabled: false };
}

/** Rows for the plan summary table. */
function summaryRows(ctx) {
  const { hw, plan } = ctx;
  const gpu = hw.gpu.vendor === 'none' ? 'none found' : `${hw.gpu.name} (${hw.gpu.vendor})`;
  const todo = ctx.missing || [];
  const gb = todo.reduce((n, m) => n + m.sizeMB, 0) / 1024;
  const rows = [
    ['OS', `${hw.distro || hw.os} ${hw.arch}`],
    ['GPU', gpu],
    ['VRAM', hw.gpu.vramGB ? `${hw.gpu.vramGB} GB (effective ${plan.effectiveVramGB} GB)` : 'n/a'],
    ['RAM', `${hw.ramGB} GB`],
    ['Free disk', `${hw.freeDiskGB} GB`],
    ['Tier', `${plan.id} (${plan.image.baseModel}, max ${plan.image.maxSize}px)`],
    ['Engine', isExternal(ctx) ? `external ComfyUI ${ctx.options.comfyDir || ctx.options.comfyUrl}` : `managed ComfyUI ${ctx.manifest.comfyui.tag}`],
  ];
  if (!isExternal(ctx)) rows.push(['PyTorch', plan.torch.backend]);
  rows.push(['ComfyUI args', plan.comfyArgs.join(' ') || '(none)']);
  if (ctx.chat && ctx.chat.enabled) {
    const { model, asset, device } = ctx.chat;
    rows.push(['Chat', `${model.label} (${gbOf(model.sizeMB)} GB), ${device}, llama.cpp ${asset.backend} build`]);
    if (ctx.chat.think) rows.push(['Think harder', `${ctx.chat.think.label} (${gbOf(ctx.chat.think.sizeMB)} GB)`]);
  } else {
    rows.push(['Chat', 'not added (embernest setup --chat adds it)']);
  }
  rows.push(['Models to download', todo.length ? `${todo.length} files, ${gb.toFixed(1)} GB: ${todo.map((m) => m.id).join(', ')}` : 'none']);
  if (ctx.options.models !== false && !ctx.options.starter) {
    rows.push(['First model', 'Pick your first model in the app (Models → Suggested)']);
  }
  return rows.map(([item, value]) => ({ item, value }));
}

/**
 * The setup steps, in order. Each has `isDone(ctx)` (looks at real state),
 * `run(ctx)` (returns an optional version string to record) and optionally
 * `skip(ctx)` returning a reason string when the step does not apply.
 * @returns {Array<object>}
 */
function buildSteps() {
  return [
    {
      id: 'detect',
      readOnly: true,
      title: () => 'Check hardware',
      isDone: () => false,
      async run(ctx) {
        if (isExternal(ctx)) await validateExternal(ctx);
        const hw = await ctx.detect({ dataDir: ctx.paths.home });
        if (ctx.options.gpu) hw.gpu = { ...hw.gpu, vendor: ctx.options.gpu === 'cpu' ? 'none' : ctx.options.gpu };
        ctx.hw = hw;
        ctx.plan = planForHardware(hw);
        const entries = ctx.options.models === false || !modelsDirOf(ctx)
          ? [] : planModels(ctx.manifest, ctx.plan.id, { includeStarter: ctx.options.starter === true });
        ctx.entries = entries;
        ctx.missing = entries.length ? await missingModels(ctx.paths, entries, { modelsDir: modelsDirOf(ctx) }) : [];
        ctx.chat = await decideChat(ctx);
        if (ctx.chat.enabled) {
          ctx.chat.device = llm.resolveDevice(loadConfig(ctx.paths), ctx.plan);
          ctx.chat.asset = llm.pickServerAsset(ctx.manifest, ctx.hw, ctx.chat.device);
          if (ctx.chat.asset.warning) ctx.plan.warnings.push(ctx.chat.asset.warning);
          ctx.plan.warnings.push(...ctx.chatPlan.warnings);
        }
        ui.table(summaryRows(ctx));
        for (const w of ctx.plan.warnings) ui.warn(w);
        if (isExternal(ctx) && ctx.options.models !== false && !modelsDirOf(ctx)) {
          ui.warn('--comfy-url only: models are not checked or downloaded, install them in that ComfyUI yourself');
        }
        if (!ctx.options.dryRun && !(await ctx.confirm('Continue?', { yes: ctx.options.yes }))) {
          throw new SetupCancelled('cancelled');
        }
      },
    },
    {
      id: 'uv',
      title: () => 'Install uv (Python manager)',
      skip: (ctx) => isExternal(ctx) && 'external engine',
      isDone: async (ctx) => (await uvVersion(ctx.paths.uv)) === ctx.manifest.uv.version,
      async run(ctx) {
        const p = makeProgress('uv');
        try {
          await ensureUv(ctx.paths, { onProgress: p.onProgress, manifest: ctx.manifest });
        } finally { p.finish(); }
        return ctx.manifest.uv.version;
      },
    },
    {
      id: 'python',
      title: () => 'Create Python 3.12 environment',
      skip: (ctx) => isExternal(ctx) && 'external engine',
      isDone: async (ctx) => {
        const have = await venvVersion(ctx.paths);
        const want = ctx.manifest.python.version;
        return Boolean(have && (have === want || have.startsWith(`${want}.`)));
      },
      async run(ctx) {
        return ensureVenv(ctx.paths, ctx.paths.uv, { onLine: ctx.onLine, version: ctx.manifest.python.version })
          .then(() => ctx.manifest.python.version);
      },
    },
    {
      id: 'torch',
      title: (ctx) => `Install PyTorch for ${ctx.plan ? ctx.plan.torch.backend : 'this machine'}`,
      skip: (ctx) => isExternal(ctx) && 'external engine',
      isDone: async (ctx) => {
        if (!fs.existsSync(ctx.paths.venvPython)) return false;
        try {
          return (await probeTorch(ctx.paths)).device === EXPECTED_DEVICE[ctx.plan.torch.backend];
        } catch (_) {
          return false;
        }
      },
      async run(ctx) {
        await installTorch(ctx.paths, ctx.paths.uv, ctx.plan, { onLine: ctx.onLine, manifest: ctx.manifest });
        return (await probeTorch(ctx.paths)).torch;
      },
    },
    {
      id: 'comfyui',
      title: (ctx) => `Install ComfyUI ${ctx.manifest.comfyui.tag}`,
      skip: (ctx) => isExternal(ctx) && 'external engine',
      isDone: (ctx) => {
        const dir = comfyDirOf(ctx);
        return fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, MARKER));
      },
      async run(ctx) {
        const p = makeProgress('ComfyUI');
        try {
          await installComfy(ctx.paths, ctx.paths.uv, { onProgress: p.onProgress, onLine: ctx.onLine, manifest: ctx.manifest });
        } finally { p.finish(); }
        return ctx.manifest.comfyui.tag;
      },
    },
    {
      id: 'models',
      title: (ctx) => {
        const todo = ctx.missing || [];
        const gb = (todo.reduce((n, m) => n + m.sizeMB, 0) / 1024).toFixed(1);
        return `Download models (${todo.length} files, ${gb} GB)`;
      },
      skip: (ctx) => (ctx.options.models === false && '--no-models') || (!modelsDirOf(ctx) && 'no ComfyUI folder'),
      isDone: async (ctx) => (await missingModels(ctx.paths, ctx.entries || [], { modelsDir: modelsDirOf(ctx) })).length === 0,
      async run(ctx) {
        const todo = await missingModels(ctx.paths, ctx.entries, { modelsDir: modelsDirOf(ctx) });
        const bars = new Map();
        let lastId = null;
        const finish = () => { if (lastId && bars.has(lastId)) bars.get(lastId).finish(); };
        try {
          await installModels(ctx.paths, todo, {
            modelsDir: modelsDirOf(ctx),
            hfToken: ctx.hfToken,
            onProgress: (entry, p) => {
              if (lastId !== entry.id) { finish(); lastId = entry.id; }
              if (!bars.has(entry.id)) bars.set(entry.id, makeProgress(entry.id, entry.sizeMB * MB));
              bars.get(entry.id).onProgress(p);
            },
          });
        } finally { finish(); }
        return `${todo.length} files`;
      },
    },
    {
      id: 'safety',
      title: (ctx) => `Download the photo-edit safety model (${ctx.manifest.safety.sizeMB} MB)`,
      skip: (ctx) => !safetyPythonOf(ctx) && 'no Python for the external engine (pass --comfy-python)',
      isDone: (ctx) => readRecords(ctx.paths).safety?.version === ctx.manifest.safety.revision,
      async run(ctx) {
        await warmup(ctx.paths, safetyPythonOf(ctx), ctx.manifest.safety, { onLine: ctx.onLine });
        return ctx.manifest.safety.revision;
      },
    },
    {
      id: 'chat-runtime',
      title: (ctx) => `Install chat engine (llama.cpp ${ctx.manifest.llm.server.tag})`,
      skip: (ctx) => !(ctx.chat && ctx.chat.enabled) && 'chat not enabled',
      isDone: (ctx) => Boolean(llm.installedServer(ctx.paths, ctx.manifest, ctx.chat.asset.key)),
      async run(ctx) {
        const p = makeProgress('llama.cpp');
        try {
          await llm.ensureLlamaServer(ctx.paths, ctx.manifest, ctx.chat.asset.key, { onProgress: p.onProgress });
        } finally { p.finish(); }
        return ctx.manifest.llm.server.tag;
      },
    },
    {
      id: 'chat-model',
      title: (ctx) => (ctx.chat && ctx.chat.model
        ? `Download chat model ${ctx.chat.model.label} (${gbOf(ctx.chat.model.sizeMB)} GB)${ctx.chat.think ? ' and Think harder model' : ''}`
        : 'Download chat model'),
      skip: (ctx) => !(ctx.chat && ctx.chat.enabled) && 'chat not enabled',
      isDone: (ctx) => chatModelsOf(ctx).every((m) => fs.existsSync(llm.modelFilePath(ctx.paths, m))),
      async run(ctx) {
        for (const model of chatModelsOf(ctx)) {
          if (fs.existsSync(llm.modelFilePath(ctx.paths, model))) continue;
          const p = makeProgress(model.id, model.sizeMB * MB);
          try {
            await llm.installChatModel(ctx.paths, model, { onProgress: p.onProgress, hfToken: ctx.hfToken });
          } finally { p.finish(); }
        }
        return chatModelsOf(ctx).map((m) => m.id).join('+');
      },
    },
    {
      id: 'config',
      title: () => 'Write config + access token',
      isDone: (ctx) => {
        if (!fs.existsSync(ctx.paths.config)) return false;
        const cfg = loadConfig(ctx.paths);
        const want = configPatch(ctx).comfy;
        const same = ['mode', 'url', 'port', 'dir', 'python', 'version'].every((k) => cfg.comfy[k] === want[k])
          && JSON.stringify(cfg.comfy.args) === JSON.stringify(want.args);
        const imported = !ctx.options.importConfig
          || readRecords(ctx.paths).config?.version === `import:${path.resolve(ctx.options.importConfig)}`;
        const wantChat = configPatch(ctx).chat;
        const chatSame = !wantChat || Object.keys(wantChat).every((k) => cfg.chat[k] === wantChat[k]);
        return Boolean(cfg.authToken) && same && chatSame && cfg.hardware.tier === ctx.plan.id && imported
          && (!ctx.options.port || cfg.port === Number(ctx.options.port))
          && (ctx.options.lan !== false || cfg.listenOnLan === false);
      },
      run(ctx) {
        if (ctx.imported) {
          const legacy = { ...ctx.imported };
          delete legacy.comfy; // engine settings are set from this run, not the old url
          if (!legacy.authToken) delete legacy.authToken;
          saveConfig(ctx.paths, legacy);
        }
        const patch = configPatch(ctx);
        if (!loadConfig(ctx.paths).authToken) patch.authToken = generateToken();
        saveConfig(ctx.paths, patch);
        return ctx.options.importConfig ? `import:${path.resolve(ctx.options.importConfig)}` : '';
      },
    },
    {
      id: 'verify',
      title: () => 'Verify engine starts',
      isDone: (ctx) => {
        if (isExternal(ctx)) return false; // cheap, and the engine may have been started or stopped since
        const rec = readRecords(ctx.paths).verify;
        return Boolean(rec && rec.version === verifyFingerprint(ctx) && loadConfig(ctx.paths).comfy.dataMode);
      },
      async run(ctx) {
        if (isExternal(ctx)) return verifyExternal(ctx);
        const { dataMode } = await verifyComfy(ctx.paths, comfyDirOf(ctx), ctx.plan.comfyArgs,
          { onLine: ctx.onLine, port: comfyPortOf(ctx) });
        saveConfig(ctx.paths, { comfy: { dataMode } });
        return verifyFingerprint(ctx);
      },
    },
  ];
}

/** What a verify result is valid for: the ComfyUI version and the flags it was tested with. */
function verifyFingerprint(ctx) {
  return `${ctx.manifest.comfyui.tag} ${ctx.plan.comfyArgs.join(' ')}`.trim();
}

/** External engine check: GET /system_stats. A stopped local engine is only a warning. */
async function verifyExternal(ctx) {
  const url = comfyUrlOf(ctx);
  try {
    const res = await ctx.fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'reachable';
  } catch (err) {
    if (!ctx.options.comfyUrl) {
      ui.warn(`ComfyUI is not running at ${url} (${err.message}); \`embernest start\` will start it`);
      return 'not running';
    }
    throw new Error(`cannot reach ComfyUI at ${url}: ${err.message}`);
  }
}

/** Config values this run wants. authToken is added separately, only if empty. */
function configPatch(ctx) {
  const external = isExternal(ctx);
  const port = comfyPortOf(ctx);
  const patch = {
    comfy: {
      mode: external ? 'external' : 'managed',
      url: comfyUrlOf(ctx),
      port,
      dir: comfyDirOf(ctx),
      python: external ? (ctx.options.comfyPython ? path.resolve(ctx.options.comfyPython) : '') : ctx.paths.venvPython,
      args: ctx.plan.comfyArgs,
      version: external ? '' : ctx.manifest.comfyui.tag,
    },
    hardware: { ...ctx.hw, tier: ctx.plan.id },
  };
  if (ctx.chat && ctx.chat.enabled) {
    patch.chat = { enabled: true, model: ctx.chat.model.id };
    if (ctx.chat.think) patch.chat.thinkModel = ctx.chat.think.id;
    else if (ctx.chat.thinkOff) patch.chat.thinkModel = '';
  }
  else if (ctx.chat && ctx.chat.off) patch.chat = { enabled: false };
  if (ctx.options.port) patch.port = Number(ctx.options.port);
  if (ctx.options.lan === false) patch.listenOnLan = false;
  return patch;
}

/**
 * Run steps in order. In dry-run, only `readOnly` steps run; the rest are
 * reported as "would run" / "already done".
 * @param {Array<object>} steps
 * @param {object} ctx
 * @returns {Promise<{ ok: boolean, summary: object }>}
 */
async function runSteps(steps, ctx) {
  const out = ctx.ui;
  const results = [];
  const summary = { dryRun: Boolean(ctx.options.dryRun), steps: results };
  const total = steps.length;

  for (let i = 0; i < total; i += 1) {
    const s = steps[i];
    const title = s.title(ctx);
    try {
      if (s.readOnly) {
        out.step(i + 1, total, title);
        await s.run(ctx);
        results.push({ id: s.id, status: 'ran' });
        continue;
      }
      const reason = s.skip ? s.skip(ctx) : null;
      if (reason) {
        out.info(`[${i + 1}/${total}] ${title}: skipped (${reason})`);
        results.push({ id: s.id, status: 'skipped' });
        continue;
      }
      const done = await s.isDone(ctx);
      if (ctx.options.dryRun) {
        out.info(`[${i + 1}/${total}] ${title}: ${done ? 'already done' : 'would run'}`);
        results.push({ id: s.id, status: done ? 'done' : 'would-run' });
        continue;
      }
      if (done) {
        out.info(`[${i + 1}/${total}] ${title}: already done`);
        results.push({ id: s.id, status: 'done' });
        continue;
      }
      out.step(i + 1, total, title);
      const version = await s.run(ctx);
      record(ctx, s.id, typeof version === 'string' ? version : '');
      results.push({ id: s.id, status: 'ran' });
    } catch (err) {
      if (err instanceof SetupCancelled) return { ok: false, summary: { ...summary, cancelled: true } };
      results.push({ id: s.id, status: 'failed' });
      summary.failedStep = s.id;
      summary.error = err.message;
      if (ctx.log) ctx.log.error(`step ${s.id} failed: ${err.stack || err.message}`);
      out.fail(`Step "${title}" failed: ${err.message}`);
      out.info(`Log: ${ctx.paths.logs}${path.sep}setup.log`);
      out.info('Fix the problem and re-run `embernest setup` to resume.');
      return { ok: false, summary };
    }
  }
  return { ok: true, summary };
}

/**
 * Run the whole setup.
 * @param {{ yes?: boolean, dryRun?: boolean, gpu?: string, models?: boolean, starter?: boolean,
 *   port?: number|string, lan?: boolean, comfyDir?: string, comfyPython?: string,
 *   comfyUrl?: string, importConfig?: string, chat?: boolean, chatModel?: string,
 *   chatThink?: boolean, chatThinkModel?: string }} [options]
 * @param {{ paths?: object, steps?: Array<object>, detect?: Function, confirm?: Function,
 *   choose?: Function, interactive?: boolean, ui?: object, fetch?: Function }} [deps] injectable for tests
 * @returns {Promise<{ ok: boolean, summary: object }>}
 */
async function runSetup(options = {}, deps = {}) {
  if (options.gpu && !GPU_VENDORS.includes(options.gpu)) {
    throw new Error(`--gpu must be one of ${GPU_VENDORS.join(', ')}`);
  }
  const paths = deps.paths || getPaths();
  const ctx = {
    options, paths,
    ui: deps.ui || ui,
    detect: deps.detect || detectHardware,
    confirm: deps.confirm || ui.confirm,
    choose: deps.choose || ui.choose,
    interactive: deps.interactive === undefined ? Boolean(process.stdin.isTTY) : deps.interactive,
    fetch: deps.fetch || fetch,
    manifest: getManifest({ dryRun: Boolean(options.dryRun) }),
    log: null,
    onLine: null,
  };
  if (options.importConfig) {
    const old = readJson(options.importConfig);
    if (!old) throw new Error(`cannot read --import-config ${options.importConfig}`);
    ctx.imported = migrateLegacy(old);
  }
  ctx.hfToken = (ctx.imported && ctx.imported.tokens.hf) || loadConfig(paths).tokens.hf || null;

  if (!options.dryRun) {
    await ensureDirs(paths);
    ctx.log = createLogger(path.join(paths.logs, 'setup.log'));
    ctx.onLine = (line) => ctx.log.info(line);
  }
  return runSteps(deps.steps || buildSteps(), ctx);
}

module.exports = { runSetup, runSteps, buildSteps, decideChat, SetupCancelled };
