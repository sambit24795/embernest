'use strict';
const os = require('node:os');
const path = require('node:path');

/**
 * Every helper takes an optional `platform` so tests can exercise all branches
 * on any OS. Only this file should read process.platform.
 */

/** @param {string} [platform] */
function isWindows(platform = process.platform) {
  return platform === 'win32';
}

/** @param {string} [platform] */
function isMac(platform = process.platform) {
  return platform === 'darwin';
}

/** @param {string} [platform] */
function isLinux(platform = process.platform) {
  return platform === 'linux';
}

/** @returns {string} process.arch, e.g. 'x64' or 'arm64' */
function arch() {
  return process.arch;
}

/**
 * Add the .exe suffix on Windows.
 * @param {string} name executable base name, e.g. 'uv'
 * @param {string} [platform]
 * @returns {string}
 */
function exe(name, platform = process.platform) {
  return isWindows(platform) ? `${name}.exe` : name;
}

/**
 * Path to the python executable inside a venv.
 * @param {string} venvDir
 * @param {string} [platform]
 * @returns {string}
 */
function venvPython(venvDir, platform = process.platform) {
  if (isWindows(platform)) return path.win32.join(venvDir, 'Scripts', 'python.exe');
  return path.posix.join(venvDir, 'bin', 'python');
}

/** @returns {string} the user's home directory */
function homeDir() {
  return os.homedir();
}

module.exports = { isWindows, isMac, isLinux, arch, exe, venvPython, homeDir };
