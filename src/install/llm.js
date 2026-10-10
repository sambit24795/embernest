'use strict';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { downloadFile } = require('../core/download');
const { extract, findFile } = require('../core/archive');
const platform = require('../core/platform');
const { authHeadersFor } = require('./models');

const MARKER = '.pixelkiln-llm.json';
const CPU_MAX_VRAM_GB = 8;

/**
 * Whether chat runs on the CPU or the GPU. `auto` picks the CPU when the tier's
 * effective VRAM is 8 GB or less, so chat never fights ComfyUI over a small GPU.
 * @param {{ chat?: { device?: string } }} cfg
 * @param {{ effectiveVramGB?: number }} tierPlan result of planForHardware()
 * @returns {'cpu'|'gpu'}
 */
function resolveDevice(cfg, tierPlan) {
  const want = (cfg && cfg.chat && cfg.chat.device) || 'auto';
  if (want === 'cpu' || want === 'gpu') return want;
  return (tierPlan.effectiveVramGB || 0) > CPU_MAX_VRAM_GB ? 'gpu' : 'cpu';
}

/**
 * The llama.cpp backend wanted for a machine and device.
 * @param {{ os: string, arch: string, gpu?: { vendor?: string } }} hw
 * @param {'cpu'|'gpu'} device
 * @returns {'cpu'|'vulkan'|'cuda'|'metal'}
 */
function wantedBackend(hw, device) {
  const vendor = (hw.gpu && hw.gpu.vendor) || 'none';
  // Apple silicon only ships a metal build; with device=cpu it runs with -ngl 0.
  if (hw.os === 'darwin' && hw.arch === 'arm64') return 'metal';
  if (device !== 'gpu') return 'cpu';
  if (vendor === 'nvidia' && hw.os === 'win32') return 'cuda';
  if (['nvidia', 'amd', 'intel'].includes(vendor) && (hw.os === 'linux' || hw.os === 'win32')) return 'vulkan';
  return 'cpu';
}

/**
 * Pick the llama.cpp release asset for this machine. Falls back to the cpu build
 * (with a warning) when the pinned release has no build for the wanted backend.
 * @param {object} manifest
 * @param {{ os: string, arch: string, gpu?: { vendor?: string } }} hw
 * @param {'cpu'|'gpu'} device
 * @returns {{ key: string, backend: string, file: string, sha256: string, extra: Array<object>, warning: string|null }}
 */
function pickServerAsset(manifest, hw, device) {
  const assets = manifest.llm.server.assets;
  const base = `${hw.os}-${hw.arch}`;
  const backend = wantedBackend(hw, device);
  let key = `${base}-${backend}`;
  let warning = null;
  if (!assets[key] && backend !== 'cpu') {
    warning = `no llama.cpp ${backend} build for ${base}; using the cpu build`;
    key = `${base}-cpu`;
  }
  const asset = assets[key];
  if (!asset) throw new Error(`no llama.cpp build pinned for ${key}`);
  return {
    key, backend: key.slice(base.length + 1), file: asset.file, sha256: asset.sha256, extra: asset.extra || [], warning,
  };
}

const SIZE_ORDER = ['1-3B', '3-4B', '7-8B', '12-14B', '24B+'];

/**
 * The mainstream and uncensored model of one role. `balanced` follows the tier's
 * size class and steps down to a smaller class when nothing in it fits the budget
 * (so a 24B+ tier uses the 12-14B models). `fast` and `think` models are small and
 * do not depend on the tier. Models above the budget are never returned.
 */
function pickByRole(manifest, role, sizeClass, budgetMB) {
  const ofRole = manifest.llm.models.filter((m) => (m.role || 'balanced') === role && m.sizeMB <= budgetMB);
  const pick = (variant, pool) => pool.find((m) => m.variant === variant) || null;
  if (role !== 'balanced') return { mainstream: pick('mainstream', ofRole), uncensored: pick('uncensored', ofRole) };
  for (let idx = SIZE_ORDER.indexOf(sizeClass); idx >= 0; idx -= 1) {
    const pool = ofRole.filter((m) => m.sizeClass === SIZE_ORDER[idx]);
    const found = { mainstream: pick('mainstream', pool), uncensored: pick('uncensored', pool) };
    if (found.mainstream || found.uncensored) return found;
  }
  return { mainstream: null, uncensored: null };
}

/**
 * Chat model choices by role for a machine. `mainstream` and `uncensored` repeat the
 * default role's pair (balanced when no chat plan is given), for callers that want one.
 * @param {object} manifest
 * @param {{ llm: { sizeClass: string } }} tierPlan result of planForHardware()
 * @param {{ defaultRole: string, budgetMB: number }} [chatPlan] result of chatPlan(); omit for no budget
 * @returns {{
 *   fast: { mainstream: object|null, uncensored: object|null },
 *   balanced: { mainstream: object|null, uncensored: object|null },
 *   think: { mainstream: object|null, uncensored: object|null },
 *   mainstream: object|null, uncensored: object|null, defaultRole: string
 * }}
 */
function chatModelChoices(manifest, tierPlan, chatPlan = null) {
  const budget = chatPlan ? chatPlan.budgetMB : Infinity;
  const byRole = (role) => pickByRole(manifest, role, tierPlan.llm.sizeClass, budget);
  const fast = byRole('fast');
  const balanced = byRole('balanced');
  const think = byRole('think');
  const defaultRole = chatPlan ? chatPlan.defaultRole : 'balanced';
  const main = defaultRole === 'fast' && (fast.mainstream || fast.uncensored) ? fast : balanced;
  return { fast, balanced, think, mainstream: main.mainstream, uncensored: main.uncensored, defaultRole };
}

/** @param {object} manifest @param {string} id @returns {object} */
function findChatModel(manifest, id) {
  const model = manifest.llm.models.find((m) => m.id === id);
  if (!model) {
    throw new Error(`unknown chat model "${id}". Known: ${manifest.llm.models.map((m) => m.id).join(', ')}`);
  }
  return model;
}

/** Folder one asset is extracted into: <llm>/server/<tag>/<key>. */
function serverDir(paths, manifest, key) {
  return path.join(paths.llm, 'server', manifest.llm.server.tag, key);
}

/**
 * Path to an installed llama-server, or null. Reads the marker written by
 * ensureLlamaServer, so it is cheap and synchronous.
 * @param {Record<string, string>} paths
 * @param {object} manifest
 * @param {string} key asset key from pickServerAsset()
 * @returns {string|null}
 */
function installedServer(paths, manifest, key) {
  const dir = serverDir(paths, manifest, key);
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    const bin = path.join(dir, rec.bin);
    return rec.file && fs.existsSync(bin) ? bin : null;
  } catch (_) {
    return null;
  }
}

/** Download one archive, extract it into dir, delete the archive. */
async function fetchAndExtract(paths, manifest, asset, dir, onProgress) {
  const url = manifest.llm.server.urlTemplate.replace('{tag}', manifest.llm.server.tag).replace('{file}', asset.file);
  await fsp.mkdir(paths.tmp, { recursive: true });
  const archive = path.join(paths.tmp, asset.file);
  await downloadFile({ url, dest: archive, sha256: asset.sha256, onProgress });
  await extract(archive, dir);
  await fsp.rm(archive, { force: true });
}

/**
 * Install the pinned llama.cpp build for `key` under <llm>/server/<tag>/<key>/.
 * The whole extracted folder is kept: llama-server loads shared libraries next to it.
 * @param {Record<string, string>} paths
 * @param {object} manifest
 * @param {string} assetKey e.g. 'linux-x64-cpu'
 * @param {{ onProgress?: Function }} [opts]
 * @returns {Promise<string>} path to llama-server(.exe)
 */
async function ensureLlamaServer(paths, manifest, assetKey, { onProgress = null } = {}) {
  const have = installedServer(paths, manifest, assetKey);
  if (have) return have;
  const asset = manifest.llm.server.assets[assetKey];
  if (!asset) throw new Error(`no llama.cpp build pinned for ${assetKey}`);

  const dir = serverDir(paths, manifest, assetKey);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const part of [asset, ...(asset.extra || [])]) await fetchAndExtract(paths, manifest, part, dir, onProgress);

  const bin = await findFile(dir, [platform.exe('llama-server')]);
  if (!bin) throw new Error(`llama-server not found inside ${asset.file}`);
  if (!platform.isWindows()) await fsp.chmod(bin, 0o755);
  await fsp.writeFile(path.join(dir, MARKER), JSON.stringify({
    tag: manifest.llm.server.tag, key: assetKey, file: asset.file, bin: path.relative(dir, bin),
  }));
  return bin;
}

/** Where a chat model file lives: <llm>/models/<file>. */
function modelFilePath(paths, model) {
  return path.join(paths.llm, 'models', model.file);
}

/**
 * Download a chat model (resumable, sha256 checked).
 * @param {Record<string, string>} paths
 * @param {{ file: string, url: string, sha256: string }} model manifest entry
 * @param {{ onProgress?: Function, hfToken?: string|null }} [opts]
 * @returns {Promise<string>} path to the .gguf
 */
async function installChatModel(paths, model, { onProgress = null, hfToken = null } = {}) {
  const dest = modelFilePath(paths, model);
  await downloadFile({
    url: model.url, dest, sha256: model.sha256, onProgress, headers: authHeadersFor(model.url, hfToken),
  });
  return dest;
}

module.exports = {
  pickServerAsset, chatModelChoices, resolveDevice, ensureLlamaServer, installChatModel,
  installedServer, modelFilePath, findChatModel, wantedBackend, MARKER,
};
