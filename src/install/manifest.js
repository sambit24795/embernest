'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_FILE = path.join(__dirname, 'manifest.json');

/** Dot-paths of every string in the manifest that still holds a VERIFY placeholder. */
function findPlaceholders(node, trail = '') {
  if (typeof node === 'string') return node.includes('VERIFY') ? [trail] : [];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => findPlaceholders(v, trail ? `${trail}.${k}` : k));
  }
  return [];
}

/**
 * Load the pinned install manifest. All outside URLs, versions and checksums
 * come from here and nowhere else.
 * @param {{ dryRun?: boolean }} [opts] dryRun allows unfilled VERIFY placeholders
 * @returns {object}
 */
function getManifest({ dryRun = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  const bad = findPlaceholders(manifest);
  if (bad.length && !dryRun) {
    throw new Error(`install manifest has unverified values (VERIFY): ${bad.join(', ')}`);
  }
  return manifest;
}

/**
 * Key into manifest.uv.assets for this machine.
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string} e.g. 'linux-x64'
 */
function assetKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

module.exports = { getManifest, assetKey, findPlaceholders };
