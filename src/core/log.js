'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;

/**
 * Rotate `file` when it is larger than `maxBytes`: `x.log` → `x.log.1`, and the
 * older backups shift up. The oldest backup beyond `keep` is deleted.
 * @param {string} filePath
 * @param {number} [maxBytes]
 * @param {number} [keep] number of rotated backups to keep
 * @returns {boolean} true when a rotation happened
 */
function rotateIfNeeded(filePath, maxBytes = MAX_BYTES, keep = KEEP) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (_) {
    return false;
  }
  if (size <= maxBytes) return false;

  fs.rmSync(`${filePath}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) {
    if (fs.existsSync(`${filePath}.${i}`)) {
      fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
  return true;
}

/**
 * Create a logger that appends `ISO-time LEVEL message` lines to `filePath`.
 * The file is rotated before a write once it is over 10 MB.
 * @param {string} filePath
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
function createLogger(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const write = (level, message) => {
    rotateIfNeeded(filePath);
    // Owner-only: logs can contain local paths and request details.
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${level} ${message}\n`, { mode: 0o600 });
  };
  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}

module.exports = { createLogger, rotateIfNeeded };
