'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { getPaths, localModelsDir } = require('../../core/paths');
const { loadConfig } = require('../../core/config');
const { downloadFile } = require('../../core/download');
const { authHeadersFor } = require('../../install/models');
const downloads = require('../../server/downloads');
const ui = require('../ui');

const { FOLDER_BY_TYPE, isPlainFileName } = downloads;
const TYPES = Object.keys(FOLDER_BY_TYPE);

/**
 * Headers that carry a provider token, only to that provider's own host
 * (the same rule as src/server/downloads.js).
 * @param {string} url
 * @param {Record<string, string>} [tokens]
 * @returns {Record<string, string>}
 */
function tokenHeadersFor(url, tokens = {}) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { return {}; }
  if (tokens.civitai && /(^|\.)civitai\.com$/i.test(host)) {
    return { Authorization: `Bearer ${tokens.civitai}` };
  }
  return authHeadersFor(url, tokens.hf);
}

/**
 * The local models folder, or throw when external mode has no ComfyUI folder.
 * @param {Record<string, string>} paths
 * @param {object} cfg
 * @returns {string}
 */
function modelsDirOrThrow(paths, cfg) {
  const dir = localModelsDir(paths, cfg);
  if (!dir) throw new Error('The external ComfyUI has no folder set (run embernest setup --comfy-dir <dir>)');
  return dir;
}

/**
 * Parse `<folder>/<file>` into its parts. Only known folders and plain file names pass.
 * @param {string} target
 * @returns {{ folder: string, file: string }}
 */
function parseModelTarget(target) {
  const m = /^([^/\\]+)[/\\](.+)$/.exec(String(target || ''));
  if (!m) throw new Error('Use <folder>/<file>, for example checkpoints/model.safetensors');
  const [, folder, file] = m;
  if (!TYPES.some((t) => FOLDER_BY_TYPE[t] === folder)) {
    throw new Error(`Unsupported model folder "${folder}" (use one of: ${Object.values(FOLDER_BY_TYPE).join(', ')})`);
  }
  if (!isPlainFileName(file)) throw new Error('Invalid model file name');
  return { folder, file };
}

/**
 * Download one model into <models>/<folder>/. Existing files are left alone.
 * @param {{ paths: object, cfg: object, url: string, type: string, name?: string }} o
 * @returns {Promise<{ dest: string, existed: boolean }>}
 */
async function pullModel({ paths, cfg, url, type, name }) {
  const folder = FOLDER_BY_TYPE[type];
  if (!folder) throw new Error(`Unknown --type "${type}" (use one of: ${TYPES.join(', ')})`);
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error(`Not a valid URL: ${url}`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('The URL must start with http:// or https://');
  const file = name || decodeURIComponent(path.basename(parsed.pathname));
  if (!isPlainFileName(file)) throw new Error('Could not work out a file name; pass --name <file>');

  const dest = path.join(modelsDirOrThrow(paths, cfg), folder, file);
  if (fs.existsSync(dest)) return { dest, existed: true };

  let bar = null;
  await downloadFile({
    url,
    dest,
    headers: tokenHeadersFor(url, cfg.tokens),
    onProgress: ({ received, total }) => {
      if (!bar) bar = ui.progressBar({ label: file, total: total || 0 });
      bar.update(received);
    },
  });
  if (bar) bar.done();
  return { dest, existed: false };
}

/**
 * Resolve `<folder>/<file>` to an absolute path inside the models folder.
 * @param {{ paths: object, cfg: object, target: string }} o
 * @returns {string}
 */
function modelPathFor({ paths, cfg, target }) {
  const { folder, file } = parseModelTarget(target);
  const root = path.resolve(modelsDirOrThrow(paths, cfg), folder) + path.sep;
  const full = path.resolve(root, file);
  if (!full.startsWith(root)) throw new Error('Invalid model path');
  return full;
}

/**
 * Register `embernest models list|pull|rm`.
 * @param {import('commander').Command} program
 */
function register(program) {
  const models = program.command('models').description('List, download and remove model files');

  models
    .command('list')
    .description('List the model files in the local models folder')
    .action(() => {
      const paths = getPaths();
      const dir = modelsDirOrThrow(paths, loadConfig(paths));
      return downloads.listInstalled({ modelsDir: dir }).then((installed) => {
        const rows = Object.entries(installed).flatMap(([folder, files]) => files.map((f) => ({
          folder, file: f.name, sizeMB: f.sizeMB.toFixed(1),
        })));
        ui.info(`Models folder: ${dir}`);
        if (!rows.length) ui.info('  No model files found.');
        else ui.table(rows);
      });
    });

  models
    .command('pull <url>')
    .description('Download a model file into the matching models folder')
    .requiredOption('--type <type>', `model type: ${TYPES.join(', ')}`)
    .option('--name <file>', 'file name to save as (default: the last part of the URL)')
    .action(async (url, options) => {
      const paths = getPaths();
      const { dest, existed } = await pullModel({ paths, cfg: loadConfig(paths), url, type: options.type, name: options.name });
      if (existed) ui.info(`Already installed: ${dest}`);
      else ui.ok(`Saved ${dest}`);
      ui.info('  ComfyUI may cache its model list: restart the engine if the model does not show up.');
    });

  models
    .command('rm <target>')
    .description('Delete one model file, given as <folder>/<file>')
    .option('--yes', 'do not ask for confirmation')
    .action(async (target, options) => {
      const paths = getPaths();
      const full = modelPathFor({ paths, cfg: loadConfig(paths), target });
      if (!fs.existsSync(full)) throw new Error(`File not found: ${target}`);
      if (!options.yes && !process.stdin.isTTY) throw new Error('Pass --yes to delete without a terminal');
      const ok = await ui.confirm(`Delete ${target}?`, { yes: options.yes });
      if (!ok) {
        ui.info('Cancelled, nothing was deleted.');
        return;
      }
      await fs.promises.unlink(full);
      ui.ok(`Deleted ${target}`);
    });
}

module.exports = { register, pullModel, modelPathFor, parseModelTarget, tokenHeadersFor };
