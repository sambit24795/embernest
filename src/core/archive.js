'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const tar = require('tar');
const yauzl = require('yauzl');

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/**
 * Unzip into `dir`. Refuses entries that are symlinks, absolute paths or that
 * climb out of `dir` (zip-slip), so a hostile archive can't write elsewhere.
 * @param {string} archivePath
 * @param {string} dir existing, empty destination folder
 * @returns {Promise<void>}
 */
function unzipTo(archivePath, dir) {
  const root = path.resolve(dir) + path.sep;
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, strictFileNames: true }, (openErr, zip) => {
      if (openErr) return reject(openErr);
      const fail = (err) => { zip.close(); reject(err); };
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & S_IFMT) === S_IFLNK) return fail(new Error(`zip contains a symlink: ${name}`));
        const target = path.resolve(dir, name);
        if (path.isAbsolute(name) || !(target + path.sep).startsWith(root)) {
          return fail(new Error(`zip entry escapes the destination: ${name}`));
        }
        if (name.endsWith('/')) {
          fsp.mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
          return undefined;
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail(streamErr);
          fsp.mkdir(path.dirname(target), { recursive: true })
            .then(() => pipeline(stream, fs.createWriteStream(target, { mode: (mode & 0o777) || 0o644 })))
            .then(() => zip.readEntry(), fail);
          return undefined;
        });
        return undefined;
      });
      zip.readEntry();
    });
  });
}

/**
 * Move the contents of `from` (after descending `levels` single top folders)
 * into `to`. Used for zip archives, which have no built-in strip option.
 * @param {string} from scratch folder the zip was extracted into
 * @param {string} to destination folder
 * @param {number} levels
 */
async function moveUp(from, to, levels) {
  let source = from;
  for (let i = 0; i < levels; i++) {
    const entries = await fsp.readdir(source, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) {
      throw new Error(`cannot strip ${levels} level(s): ${source} has no single top folder`);
    }
    source = path.join(source, entries[0].name);
  }
  for (const name of await fsp.readdir(source)) {
    await fsp.rename(path.join(source, name), path.join(to, name));
  }
}

/**
 * Extract a .tar.gz / .tgz / .zip archive into destDir.
 * @param {string} archivePath
 * @param {string} destDir created if missing
 * @param {{ strip?: number }} [options] leading path levels to drop
 * @returns {Promise<void>}
 */
async function extract(archivePath, destDir, { strip = 0 } = {}) {
  const dest = path.resolve(destDir);
  await fsp.mkdir(dest, { recursive: true });
  const lower = archivePath.toLowerCase();

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await tar.x({ file: archivePath, cwd: dest, strip });
    return;
  }
  if (lower.endsWith('.zip')) {
    // Extract into a scratch folder first, then move the wanted level up.
    const tmp = await fsp.mkdtemp(path.join(dest, '.extract-'));
    try {
      await unzipTo(path.resolve(archivePath), tmp);
      await moveUp(tmp, dest, strip);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
    return;
  }
  throw new Error(`unsupported archive type: ${archivePath}`);
}

/**
 * Breadth-first search for the first file whose basename is in `names`
 * (shallowest match first; entries are sorted so the result is stable).
 * @param {string} dir
 * @param {string[]} names
 * @returns {Promise<string|null>} absolute path, or null when nothing matches
 */
async function findFile(dir, names) {
  const wanted = new Set(names);
  let level = [dir];
  while (level.length) {
    const next = [];
    for (const folder of level) {
      const entries = (await fsp.readdir(folder, { withFileTypes: true }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) next.push(full);
        else if (wanted.has(entry.name)) return full;
      }
    }
    level = next;
  }
  return null;
}

module.exports = { extract, findFile };
