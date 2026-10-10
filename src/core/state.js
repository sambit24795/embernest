'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Parse a JSON file. A missing or unreadable/corrupt file returns `fallback`.
 * @param {string} file
 * @param {*} [fallback=null]
 * @returns {*}
 */
function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Write JSON atomically: `<file>.tmp`, then rename over the target.
 * Creates the parent folder if needed.
 * @param {string} file
 * @param {*} data
 * @param {{ mode?: number }} [opts] file mode for the new file (e.g. 0o600)
 */
function writeJson(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson };
