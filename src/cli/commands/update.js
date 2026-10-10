'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getPaths } = require('../../core/paths');
const { loadConfig, saveConfig } = require('../../core/config');
const { readJson } = require('../../core/state');
const { getManifest } = require('../../install/manifest');
const { installComfy, verifyComfy } = require('../../install/comfyui');
const status = require('../../runtime/status');
const ui = require('../ui');

/**
 * How to update the CLI itself. A private Node runtime means the install
 * script put us here; otherwise npm did.
 * @param {Record<string, string>} paths
 * @returns {string}
 */
function cliUpdateHint(paths) {
  if (fs.existsSync(paths.node)) return 'Update the CLI by re-running the install script (install.sh, or install.ps1 on Windows).';
  return 'Update the CLI with: npm i -g embernest@latest';
}

/**
 * Install the manifest's ComfyUI tag and switch the config to it. On any
 * failure the old folder and the config stay as they were.
 * @param {Record<string, string>} paths
 * @param {{ manifest?: object, install?: Function, verify?: Function, confirmStop?: () => Promise<boolean>,
 *           stop?: Function, running?: Function, onLine?: Function }} [deps] injectable for tests
 * @returns {Promise<{ status: 'up-to-date'|'updated'|'cancelled'|'external', from?: string, to?: string }>}
 */
async function updateEngine(paths, deps = {}) {
  const {
    manifest = getManifest(), install = installComfy, verify = verifyComfy,
    stop = status.stopServer, running = status.isRunning,
    confirmStop = () => ui.confirm('The server is running and must be stopped to update. Stop it now?'),
    onLine,
  } = deps;
  const cfg = loadConfig(paths);
  if (cfg.comfy.mode !== 'managed') return { status: 'external' };
  const tag = manifest.comfyui.tag;
  const from = cfg.comfy.version;
  if (tag === from) return { status: 'up-to-date', from, to: tag };

  if (await running(readJson(paths.state, null))) {
    if (!(await confirmStop())) return { status: 'cancelled', from, to: tag };
    const res = await stop(paths);
    if (res.status === 'timeout') throw new Error(`The server (pid ${res.pid}) did not stop; update cancelled`);
  }

  const dir = await install(paths, paths.uv, { tag, manifest, onLine });
  await verify(paths, dir, cfg.comfy.args, { port: cfg.comfy.port, onLine });
  const oldDir = cfg.comfy.dir;
  saveConfig(paths, { comfy: { dir, version: tag } });
  // Only ever delete a version folder that lives directly under comfyui/.
  if (oldDir && path.resolve(oldDir) !== path.resolve(dir)
    && path.dirname(path.resolve(oldDir)) === path.resolve(paths.comfyRoot)) {
    fs.rmSync(oldDir, { recursive: true, force: true });
  }
  return { status: 'updated', from, to: tag };
}

/**
 * Register `embernest update [engine]`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('update [what]')
    .description('Show how to update the CLI, then update the engine ("update engine" does only the engine)')
    .action(async (what) => {
      const paths = getPaths();
      if (what && what !== 'engine') throw new Error('Use: embernest update   or   embernest update engine');
      if (!what) ui.info(cliUpdateHint(paths));
      const res = await updateEngine(paths);
      if (res.status === 'up-to-date') ui.ok(`ComfyUI is already up to date (${res.to})`);
      else if (res.status === 'updated') ui.ok(`ComfyUI updated: ${res.from || '(none)'} -> ${res.to}. Start it with: embernest start`);
      else if (res.status === 'cancelled') ui.info('Cancelled, nothing was changed.');
      else ui.info('The engine is external (your own ComfyUI): update it yourself.');
    });
}

module.exports = { register, updateEngine, cliUpdateHint };
