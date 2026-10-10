'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ProcessSupervisor } = require('./supervisor');
const { planForHardware, chatPlan } = require('../core/tiers');
const { getManifest } = require('../install/manifest');
const llm = require('../install/llm');

/**
 * Where chat will run and which files it needs, from the config. Shared by the
 * supervisor and `doctor`, so both look at the same install.
 * @param {Record<string, string>} paths
 * @param {object} cfg loaded config
 * @param {object} [manifest]
 * @returns {{ device: 'cpu'|'gpu', asset: object, model: object|null, bin: string|null, gguf: string|null }}
 */
function chatInstall(paths, cfg, manifest = getManifest()) {
  const hw = { os: process.platform, arch: process.arch, ...(cfg.hardware || {}) };
  const device = llm.resolveDevice(cfg, planForHardware(hw));
  const asset = llm.pickServerAsset(manifest, hw, device);
  const model = manifest.llm.models.find((m) => m.id === cfg.chat.model) || null;
  return {
    device,
    asset,
    model,
    bin: llm.installedServer(paths, manifest, asset.key),
    gguf: model ? llm.modelFilePath(paths, model) : null,
  };
}

const CACHE_REUSE = 256;

/**
 * Text of llama-server's presets.ini (router mode, checked against b11429). `[*]` holds
 * the keys every model shares; each model section is named by the id requests send as
 * `"model"` (llama-server uses the section name as the alias). Keys are the long flag
 * names without dashes in front. `load-on-startup` loads the default model at launch.
 * Values are written raw on purpose: the b11429 parser (common/preset.cpp) has no quote or escape
 * rules, so quotes and backslashes would reach llama-server literally, while spaces, quotes, `=`, `[`
 * and Windows backslashes are fine as they are. Only `#` and `;` (they start a comment, even
 * mid-value) and newlines cannot be written at all; those paths throw a clear error. Pure.
 * @param {{ id: string, file: string, think?: boolean, loadOnStartup?: boolean }[]} models
 * @param {{ contextSize: number, gpuLayers: number, threads?: number }} shared
 * @returns {string}
 */
function presetsText(models, { contextSize, gpuLayers, threads = 0 }) {
  for (const m of models) {
    if (/[#;\r\n]/.test(m.file)) {
      throw new Error(`the chat model path "${m.file}" contains "#", ";" or a line break, which llama-server's preset file cannot hold. Move EMBERNEST_HOME to a folder without them.`);
    }
  }
  const lines = ['version = 1', '', '[*]', `ctx-size = ${contextSize}`, 'jinja = true', `n-gpu-layers = ${gpuLayers}`];
  if (threads > 0) lines.push(`threads = ${threads}`);
  for (const m of models) {
    lines.push('', `[${m.id}]`, `model = ${m.file}`);
    if (m.think) lines.push('reasoning-format = deepseek');
    if (m.loadOnStartup) lines.push('load-on-startup = true');
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the presets file and returns the flags every router-mode llama-server shares. */
function writePresets(file, entries, cfg, device) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, presetsText(entries, {
    contextSize: cfg.chat.contextSize, gpuLayers: device === 'gpu' ? 99 : 0, threads: cfg.chat.threads,
  }));
}

/** Model files take roughly this much more memory once loaded (KV cache, buffers). */
const LOADED_OVERHEAD = 1.3;

/**
 * How many models the router keeps loaded: both (default + think) when together they fit in the
 * chat memory budget, so switching to Think harder doesn't unload the default model and lose its
 * prompt cache; otherwise one.
 * @param {object} cfg
 * @param {Array<{ sizeMB: number }>} models manifest entries the router serves
 * @returns {1|2}
 */
function modelsMax(cfg, models) {
  if (models.length < 2) return 1;
  const hw = cfg.hardware || {};
  if (!hw.gpu) return 1; // no hardware info cached: stay conservative
  const { budgetMB } = chatPlan(hw, planForHardware(hw), cfg.chat.device);
  const needMB = models.reduce((sum, m) => sum + (m.sizeMB || 0), 0) * LOADED_OVERHEAD;
  return needMB <= budgetMB ? 2 : 1;
}

/**
 * The llama-server command line (flags checked against llama.cpp b11429 --help). Runs in router
 * mode: it writes `<home>/llm/presets.ini` for the default model (`chat.model`) and, when its file
 * is installed, the think model (`chat.thinkModel`).
 * @param {Record<string, string>} paths
 * @param {object} cfg
 * @param {object} [manifest]
 * @returns {{ cmd: string, args: string[], cwd: string }}
 */
function llamaCommand(paths, cfg, manifest = getManifest()) {
  const { device, model, bin, gguf } = chatInstall(paths, cfg, manifest);
  if (!cfg.chat.model || !model) throw new Error(`chat model "${cfg.chat.model}" is not a known model. Run: embernest setup --chat`);
  if (!bin) throw new Error('the chat engine is not installed. Run: embernest setup --chat');
  if (!fs.existsSync(gguf)) throw new Error(`chat model file is missing (${gguf}). Run: embernest setup --chat`);
  const { chat } = cfg;
  const entries = [{ id: model.id, file: gguf, think: Boolean(model.thinking), loadOnStartup: true }];
  const served = [model];
  const thinkModel = chat.thinkModel && chat.thinkModel !== model.id
    ? manifest.llm.models.find((m) => m.id === chat.thinkModel) : null;
  if (thinkModel && fs.existsSync(llm.modelFilePath(paths, thinkModel))) {
    entries.push({ id: thinkModel.id, file: llm.modelFilePath(paths, thinkModel), think: Boolean(thinkModel.thinking) });
    served.push(thinkModel);
  }
  writePresets(paths.llmPresets, entries, cfg, device);
  const args = [
    '--models-preset', paths.llmPresets, '--models-max', String(modelsMax(cfg, served)),
    '--host', '127.0.0.1', '--port', String(chat.port), '--no-webui', '--cache-reuse', String(CACHE_REUSE),
  ];
  return { cmd: bin, args, cwd: path.dirname(bin) };
}

/**
 * Command line for a temporary router-mode llama-server that serves every installed chat model
 * (`chat bench` uses it when Embernest is not running). It writes its own presets file, so a
 * running server's presets are never touched, and it keeps one model loaded at a time.
 * @param {Record<string, string>} paths
 * @param {object} cfg
 * @param {{ port: number, models: object[], manifest?: object }} o models are manifest entries
 * @returns {{ cmd: string, args: string[], cwd: string }}
 */
function benchCommand(paths, cfg, { port, models, manifest = getManifest() }) {
  const { device, bin } = chatInstall(paths, cfg, manifest);
  if (!bin) throw new Error('the chat engine is not installed. Run: embernest chat enable');
  const entries = models.map((m) => ({ id: m.id, file: llm.modelFilePath(paths, m), think: Boolean(m.thinking) }));
  writePresets(paths.llmBenchPresets, entries, cfg, device);
  const args = [
    '--models-preset', paths.llmBenchPresets, '--models-max', '1',
    '--host', '127.0.0.1', '--port', String(port), '--no-webui', '--cache-reuse', String(CACHE_REUSE),
  ];
  return { cmd: bin, args, cwd: path.dirname(bin) };
}

/** Supervises llama-server (the chat engine) next to ComfyUI. */
class LlmSupervisor extends ProcessSupervisor {
  /** @param {object} o same as ProcessSupervisor, minus name/logFile/healthUrl/portCheck */
  constructor({ paths, ...rest }) {
    super({
      ...rest,
      name: 'llama-server',
      paths,
      logFile: paths.chatLog,
      healthUrl: (cfg) => `${cfg.chat.url}/health`,
      portCheck: (cfg) => ({ port: cfg.chat.port, url: cfg.chat.url, setting: 'chat.port' }),
    });
  }

  /**
   * Ready means the router answers /health (it does at once) and the default model is
   * loaded (GET /models, status.value "loaded"). A server without /models (a plain
   * llama-server, test stand-ins) counts as ready on /health alone.
   */
  async probe(url) {
    if (!(await super.probe(url))) return false;
    try {
      const cfg = this.getConfig();
      const res = await fetch(`${cfg.chat.url}/models`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return true;
      const entry = ((await res.json()).data || []).find((m) => m.id === cfg.chat.model);
      if (entry && entry.status && entry.status.failed) throw new Error('the chat model failed to load. See: embernest logs chat');
      return !entry || !entry.status || entry.status.value === 'loaded';
    } catch (err) {
      if (/failed to load/.test(err.message)) throw err;
      return true;
    }
  }

  describe(cfg) {
    return { model: cfg.chat.model, device: cfg.chat.device };
  }

  buildCommand(cfg) {
    if (this.command) return this.command(cfg);
    return llamaCommand(this.paths, cfg);
  }
}

module.exports = { LlmSupervisor, llamaCommand, benchCommand, chatInstall, presetsText, modelsMax };
