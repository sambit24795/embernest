'use strict';
const fs = require('node:fs');

/**
 * The last `lines` lines of a text file. A missing file gives [].
 * @param {string} file
 * @param {number} lines
 * @returns {string[]}
 */
function readTail(file, lines) {
  if (!(lines > 0)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-lines);
}

/**
 * Call `write` with new text as the file grows, starting at its current end.
 * Polls with fs.watchFile (no tail binary). A shrinking file (rotated or
 * truncated) is read again from the start.
 * @param {string} file
 * @param {(text: string) => void} write
 * @param {{ interval?: number }} [opts]
 * @returns {() => void} stop function
 */
function followFile(file, write, { interval = 500 } = {}) {
  let pos = fileSize(file);
  const tick = () => {
    const size = fileSize(file);
    if (size < pos) pos = 0;
    if (size === pos) return;
    const buf = Buffer.alloc(size - pos);
    const fd = fs.openSync(file, 'r');
    try {
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += got;
      write(buf.subarray(0, got).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  };
  fs.watchFile(file, { interval }, tick);
  return () => fs.unwatchFile(file, tick);
}

/** @returns {number} size in bytes, 0 when the file does not exist */
function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

module.exports = { readTail, followFile };
