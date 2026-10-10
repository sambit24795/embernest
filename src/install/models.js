'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { downloadFile } = require('../core/download');

/**
 * Whether a Hugging Face token may be sent to this URL. Only huggingface.co and
 * its subdomains; the same rule as src/server/downloads.js.
 * @param {string} url
 * @returns {boolean}
 */
function isHuggingFaceUrl(url) {
  try {
    return /(^|\.)huggingface\.co$/i.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

/**
 * Request headers for one model download. The token is added only for HF hosts.
 * @param {string} url
 * @param {string|null|undefined} hfToken
 * @returns {Record<string, string>}
 */
function authHeadersFor(url, hfToken) {
  if (!hfToken || !isHuggingFaceUrl(url)) return {};
  return { Authorization: `Bearer ${hfToken}` };
}

/**
 * Models this setup needs: all required ones, plus the starter models for the tier.
 * @param {object} manifest result of getManifest()
 * @param {string} tierId e.g. 'low'
 * @param {{ includeStarter?: boolean }} [opts]
 * @returns {Array<object>} entries with `id`, `folder`, `file`, `url`, `mirrors`, `sha256`, `sizeMB`
 */
function planModels(manifest, tierId, { includeStarter = true } = {}) {
  const required = manifest.models.required;
  if (!includeStarter) return [...required];
  const ids = manifest.models.starterByTier[tierId];
  if (!ids) throw new Error(`no starter models for tier "${tierId}"`);
  const starter = ids.map((id) => {
    const entry = manifest.models.starter[id];
    if (!entry) throw new Error(`starterByTier refers to unknown model "${id}"`);
    return { id, ...entry };
  });
  return [...required, ...starter];
}

/**
 * Where one model file lives: <modelsDir>/<folder>/<file>.
 * @param {string} modelsDir
 * @param {{ folder: string, file: string }} entry
 * @returns {string}
 */
function modelPath(modelsDir, entry) {
  return path.join(modelsDir, entry.folder, entry.file);
}

/**
 * Entries whose file is not on disk yet.
 * @param {Record<string, string>} paths result of getPaths()
 * @param {Array<object>} entries from planModels()
 * @param {{ modelsDir?: string }} [opts] defaults to paths.models (external mode passes <comfyDir>/models)
 * @returns {Promise<Array<object>>}
 */
async function missingModels(paths, entries, { modelsDir = paths.models } = {}) {
  const missing = [];
  for (const entry of entries) {
    try {
      const st = await fsp.stat(modelPath(modelsDir, entry));
      if (!st.isFile()) missing.push(entry);
    } catch (_) {
      missing.push(entry);
    }
  }
  return missing;
}

/**
 * Download entries one after another. downloadFile skips files that already match
 * their sha256, so re-running is cheap and an interrupted download resumes.
 * @param {Record<string, string>} paths result of getPaths()
 * @param {Array<object>} entries from planModels()
 * @param {{ onProgress?: ((entry: object, p: object) => void)|null, hfToken?: string|null,
 *   modelsDir?: string }} [opts]
 * @returns {Promise<void>}
 */
async function installModels(paths, entries, { onProgress = null, hfToken = null, modelsDir = paths.models } = {}) {
  for (const entry of entries) {
    await downloadFile({
      url: entry.url,
      dest: modelPath(modelsDir, entry),
      sha256: entry.sha256,
      mirrors: entry.mirrors || [],
      headers: authHeadersFor(entry.url, hfToken),
      onProgress: onProgress ? (p) => onProgress(entry, p) : null,
    });
  }
}

module.exports = { planModels, missingModels, installModels, authHeadersFor, isHuggingFaceUrl, modelPath };
