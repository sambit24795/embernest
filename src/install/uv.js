'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getManifest, assetKey } = require('./manifest');
const { downloadFile } = require('../core/download');
const { extract, findFile } = require('../core/archive');
const { run } = require('../core/exec');
const platform = require('../core/platform');

/**
 * Pick the uv release asset for a platform/arch from the manifest.
 * @param {object} manifest
 * @param {string} [plat]
 * @param {string} [arch]
 * @returns {{ key: string, file: string, url: string, sha256: string }}
 */
function selectUvAsset(manifest, plat = process.platform, arch = process.arch) {
  const key = assetKey(plat, arch);
  const asset = manifest.uv.assets[key];
  if (!asset) throw new Error(`no uv build pinned for ${key}`);
  const url = manifest.uv.urlTemplate
    .replace('{version}', manifest.uv.version)
    .replace('{file}', asset.file);
  return { key, file: asset.file, url, sha256: asset.sha256 };
}

/** Version reported by a uv binary ("uv 0.12.23 (abc 2026-10-03)" gives "0.12.23"), or null. */
async function uvVersion(bin) {
  try {
    const { stdout } = await run(bin, ['--version'], { timeoutMs: 20000 });
    const m = /^uv\s+(\S+)/.exec(stdout.trim());
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * Environment for every uv call: keeps caches and Pythons inside the data folder.
 * @param {Record<string, string>} paths
 * @returns {object}
 */
function uvEnv(paths) {
  return {
    ...process.env,
    UV_CACHE_DIR: paths.uvCache,
    UV_PYTHON_INSTALL_DIR: paths.python,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_CONFIG: '1',
  };
}

/**
 * Make sure the pinned uv binary is at paths.uv. Downloads it when missing or
 * of another version.
 * @param {Record<string, string>} paths
 * @param {{ onProgress?: Function, dryRun?: boolean, manifest?: object }} [opts]
 * @returns {Promise<string>} path to the uv binary
 */
async function ensureUv(paths, { onProgress = null, dryRun = false, manifest = getManifest({ dryRun }) } = {}) {
  if ((await uvVersion(paths.uv)) === manifest.uv.version) return paths.uv;
  if (dryRun) return paths.uv;

  const asset = selectUvAsset(manifest);
  await fsp.mkdir(paths.tmp, { recursive: true });
  const archive = path.join(paths.tmp, asset.file);
  await downloadFile({ url: asset.url, dest: archive, sha256: asset.sha256, onProgress });

  const work = await fsp.mkdtemp(path.join(paths.tmp, 'uv-'));
  try {
    await extract(archive, work);
    const found = await findFile(work, [platform.exe('uv')]);
    if (!found) throw new Error(`uv binary not found inside ${asset.file}`);
    await fsp.mkdir(path.dirname(paths.uv), { recursive: true });
    await fsp.rm(paths.uv, { force: true });
    await fsp.copyFile(found, paths.uv);
    if (!platform.isWindows()) await fsp.chmod(paths.uv, 0o755);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
  await fsp.rm(archive, { force: true });

  const got = await uvVersion(paths.uv);
  if (got !== manifest.uv.version) {
    throw new Error(`installed uv reports ${got}, expected ${manifest.uv.version}`);
  }
  return paths.uv;
}

module.exports = { ensureUv, uvEnv, selectUvAsset, uvVersion };
