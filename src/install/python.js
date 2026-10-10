'use strict';
const fs = require('node:fs');
const { run } = require('../core/exec');
const { uvEnv } = require('./uv');
const { getManifest } = require('./manifest');

/** Python version (e.g. "3.12.9") that the venv's interpreter reports, or null. */
async function venvVersion(paths) {
  if (!fs.existsSync(paths.venvPython)) return null;
  try {
    const { stdout } = await run(paths.venvPython, ['-c', 'import platform;print(platform.python_version())'],
      { timeoutMs: 30000 });
    return stdout.trim();
  } catch (_) {
    return null;
  }
}

/**
 * Install the managed Python and create the venv. Skips when the venv already
 * runs the wanted Python (matched on major.minor).
 * @param {Record<string, string>} paths
 * @param {string} uv path to the uv binary
 * @param {{ onLine?: Function, version?: string }} [opts]
 * @returns {Promise<string>} path to the venv python
 */
async function ensureVenv(paths, uv, { onLine, version = getManifest().python.version } = {}) {
  const have = await venvVersion(paths);
  if (have && (have === version || have.startsWith(`${version}.`))) return paths.venvPython;

  const env = uvEnv(paths);
  await run(uv, ['python', 'install', version], { env, onLine });
  // --clear replaces a broken or wrong-version venv in place.
  await run(uv, ['venv', '--python', version, '--clear', paths.venv], { env, onLine });
  return paths.venvPython;
}

/**
 * `uv pip install` into the managed venv.
 * @param {Record<string, string>} paths
 * @param {string} uv
 * @param {string[]} args pip arguments (packages, -r file, --index-url, ...)
 * @param {{ onLine?: Function, cwd?: string }} [opts]
 * @returns {Promise<void>}
 */
async function pipInstall(paths, uv, args, { onLine, cwd } = {}) {
  await run(uv, ['pip', 'install', '--python', paths.venvPython, ...args], { env: uvEnv(paths), onLine, cwd });
}

/**
 * Run python code in the venv.
 * @param {Record<string, string>} paths
 * @param {string} code
 * @returns {Promise<string>} trimmed stdout
 */
async function pyEval(paths, code) {
  const { stdout } = await run(paths.venvPython, ['-c', code], { env: uvEnv(paths), timeoutMs: 120000 });
  return stdout.trim();
}

module.exports = { ensureVenv, pipInstall, pyEval, venvVersion };
