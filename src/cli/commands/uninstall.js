'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { getPaths } = require('../../core/paths');
const status = require('../../runtime/status');
const ui = require('../ui');

/** @param {number} n bytes */
const fmtSize = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/**
 * Size of each top-level entry of <home>.
 * @param {Record<string, string>} paths
 * @returns {{ name: string, bytes: number }[]}
 */
function homeSizes(paths) {
  let entries = [];
  try { entries = fs.readdirSync(paths.home, { withFileTypes: true }); } catch (_) { /* no home */ }
  return entries.map((e) => {
    const p = path.join(paths.home, e.name);
    return { name: e.name, bytes: e.isDirectory() ? status.dirSize(p) : fs.statSync(p).size };
  });
}

/**
 * Delete everything under `dir` except the `keep` paths (and the folders that
 * lead to them).
 * @param {string} dir
 * @param {string[]} keep absolute paths
 * @returns {boolean} true when something inside was kept
 */
function removeExcept(dir, keep) {
  let kept = false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (keep.includes(p)) {
      kept = true;
    } else if (entry.isDirectory() && keep.some((k) => k.startsWith(p + path.sep))) {
      removeExcept(p, keep);
      kept = true;
    } else {
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
  return kept;
}

/**
 * Remove the data folder, optionally keeping models and/or outputs.
 * @param {Record<string, string>} paths
 * @param {{ keepModels?: boolean, keepOutputs?: boolean }} [opts]
 */
function removeHome(paths, { keepModels = false, keepOutputs = false } = {}) {
  const home = path.resolve(paths.home);
  if (home === path.parse(home).root || home === os.homedir()) throw new Error(`Refusing to delete ${home}`);
  if (!fs.existsSync(home)) return;
  const keep = [];
  if (keepModels) keep.push(path.resolve(paths.models));
  if (keepOutputs) keep.push(path.resolve(paths.output));
  if (!removeExcept(home, keep.filter((k) => fs.existsSync(k)))) fs.rmSync(home, { recursive: true, force: true });
}

/**
 * Ask the user to type `delete`.
 * @returns {Promise<boolean>}
 */
function typedDelete() {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Type "delete" to remove these files for good: ', (a) => { rl.close(); resolve(a.trim() === 'delete'); });
  });
}

/**
 * Whole uninstall flow. `confirm` and `stop` are replaceable in tests.
 * @param {Record<string, string>} paths
 * @param {{ keepModels?: boolean, keepOutputs?: boolean }} opts
 * @param {{ confirm?: () => Promise<boolean>, stop?: Function }} [deps]
 * @returns {Promise<boolean>} true when something was deleted
 */
async function uninstall(paths, opts, { confirm = typedDelete, stop = status.stopServer } = {}) {
  if (!fs.existsSync(paths.home)) {
    ui.info(`Nothing to remove: ${paths.home} does not exist`);
    return false;
  }
  ui.info(`Embernest data folder: ${paths.home}`);
  ui.table(homeSizes(paths).map((s) => ({ folder: s.name, size: fmtSize(s.bytes) })));
  if (opts.keepModels) ui.info('Keeping: data/models');
  if (opts.keepOutputs) ui.info('Keeping: data/output');
  if (!(await confirm())) {
    ui.info('Cancelled, nothing was deleted.');
    return false;
  }
  const res = await stop(paths);
  if (res.status === 'timeout') throw new Error(`The server (pid ${res.pid}) did not stop; nothing was deleted`);
  removeHome(paths, opts);
  ui.ok('Embernest data removed');
  return true;
}

/**
 * Register `embernest uninstall`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('uninstall')
    .description('Delete the Embernest data folder (asks you to type "delete")')
    .option('--keep-models', 'keep data/models')
    .option('--keep-outputs', 'keep data/output')
    .action(async (options) => {
      const paths = getPaths();
      if (!process.stdin.isTTY) throw new Error('uninstall asks you to type "delete": run it in a terminal');
      const viaScript = fs.existsSync(paths.node); // checked before the folder is deleted
      const done = await uninstall(paths, { keepModels: options.keepModels, keepOutputs: options.keepOutputs });
      if (!done) return;
      ui.info(viaScript
        ? 'The CLI came from the install script: delete the embernest launcher it added to your PATH (see install.sh / install.ps1).'
        : 'To remove the CLI itself, run: npm rm -g embernest');
    });
}

module.exports = { register, uninstall, removeHome, homeSizes };
