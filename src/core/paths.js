'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
const brand = require('../brand');

/**
 * Default data folder for an OS. Pure: no filesystem access.
 * @param {{ env?: object, platform?: string, home?: string, legacy?: boolean }} [opts]
 *   legacy: use the pre-rename (PixelKiln) folder name
 * @returns {string}
 */
function defaultHome({ env = process.env, platform: plat = process.platform, home = os.homedir(), legacy = false } = {}) {
  const names = legacy ? brand.legacy.dataDirName : brand.dataDirName;
  if (plat === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, names.win);
  }
  if (plat === 'darwin') return path.join(home, 'Library', 'Application Support', names.mac);
  const xdg = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdg, names.linux);
}

/**
 * Resolve the data folder. Order: EMBERNEST_HOME, PIXELKILN_HOME, the new OS
 * default if it exists, the legacy OS default if it exists, else the new default.
 * Never moves or copies data.
 * @param {{ env?: object, platform?: string, home?: string, exists?: (p: string) => boolean }} [opts]
 * @returns {string}
 */
function resolveHome({ env = process.env, platform: plat = process.platform, home = os.homedir(), exists = fsSync.existsSync } = {}) {
  const fromEnv = brand.getEnv('HOME', env);
  if (fromEnv) return fromEnv;
  const fresh = defaultHome({ env, platform: plat, home });
  if (exists(fresh)) return fresh;
  const old = defaultHome({ env, platform: plat, home, legacy: true });
  if (exists(old)) return old;
  return fresh;
}

/**
 * All paths under the home folder. Pure: creates nothing.
 * @param {string} [homeDir]
 * @returns {Record<string, string>}
 */
function getPaths(homeDir = resolveHome()) {
  const h = homeDir;
  const run = path.join(h, 'run');
  const logs = path.join(h, 'logs');
  const tools = path.join(h, 'tools');
  const data = path.join(h, 'data');
  const cache = path.join(h, 'cache');
  const venv = path.join(h, 'venv');
  return {
    home: h,
    config: path.join(h, 'config.json'),
    run,
    state: path.join(run, 'state.json'),
    setupState: path.join(run, 'setup.json'),
    logs,
    serverLog: path.join(logs, `${brand.cli}.log`),
    comfyLog: path.join(logs, 'comfyui.log'),
    chatLog: path.join(logs, 'chat.log'),
    tools,
    uv: path.join(tools, platform.exe('uv')),
    python: path.join(h, 'python'),
    venv,
    venvPython: platform.venvPython(venv),
    comfyRoot: path.join(h, 'comfyui'),
    data,
    models: path.join(data, 'models'),
    input: path.join(data, 'input'),
    output: path.join(data, 'output'),
    cache,
    uvCache: path.join(cache, 'uv'),
    hfCache: path.join(cache, 'hf'),
    tmp: path.join(cache, 'tmp'),
    node: path.join(h, 'node'),
    llm: path.join(h, 'llm'),
    llmPresets: path.join(h, 'llm', 'presets.ini'),
    llmBenchPresets: path.join(h, 'llm', 'bench-presets.ini'),
    chat: path.join(h, 'chat'),
    chatConversations: path.join(h, 'chat', 'conversations'),
    chatPersonas: path.join(h, 'chat', 'personas'),
    chatAvatars: path.join(h, 'chat', 'avatars'),
    chatMemory: path.join(h, 'chat', 'memory'),
  };
}

/** Keys of getPaths() that are directories (files are excluded). */
const DIR_KEYS = [
  'home', 'run', 'logs', 'tools', 'python', 'venv', 'comfyRoot', 'data', 'models',
  'input', 'output', 'cache', 'uvCache', 'hfCache', 'tmp', 'node', 'llm',
];

/**
 * mkdir -p every directory in getPaths (not files).
 * @param {Record<string, string>} paths result of getPaths()
 * @returns {Promise<void>}
 */
async function ensureDirs(paths) {
  await Promise.all(DIR_KEYS.map((key) => fs.mkdir(paths[key], { recursive: true })));
}

/**
 * Models folder the CLI manages: <home>/data/models in managed mode, or
 * <comfy.dir>/models for the user's own ComfyUI (external mode).
 * @param {Record<string, string>} paths result of getPaths()
 * @param {{ comfy: { mode: string, dir: string } }} cfg
 * @returns {string|null} null when external mode has no ComfyUI folder
 */
function localModelsDir(paths, cfg) {
  if (cfg.comfy.mode !== 'external') return paths.models;
  return cfg.comfy.dir ? path.join(cfg.comfy.dir, 'models') : null;
}

module.exports = { resolveHome, getPaths, ensureDirs, DIR_KEYS, localModelsDir };
