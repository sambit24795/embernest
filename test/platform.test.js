'use strict';
const test = require('node:test');
const assert = require('node:assert');
const platform = require('../src/core/platform');

test('exe adds .exe only on Windows', () => {
  assert.strictEqual(platform.exe('uv', 'win32'), 'uv.exe');
  assert.strictEqual(platform.exe('uv', 'linux'), 'uv');
  assert.strictEqual(platform.exe('uv', 'darwin'), 'uv');
});

test('venvPython uses Scripts\\python.exe on Windows', () => {
  assert.strictEqual(
    platform.venvPython('C:\\Users\\me\\AppData\\Embernest\\venv', 'win32'),
    'C:\\Users\\me\\AppData\\Embernest\\venv\\Scripts\\python.exe',
  );
});

test('venvPython uses bin/python on POSIX', () => {
  assert.strictEqual(platform.venvPython('/home/me/venv', 'linux'), '/home/me/venv/bin/python');
  assert.strictEqual(
    platform.venvPython('/Users/me/Library/Application Support/Embernest/venv', 'darwin'),
    '/Users/me/Library/Application Support/Embernest/venv/bin/python',
  );
});

test('OS predicates match the platform argument', () => {
  assert.strictEqual(platform.isWindows('win32'), true);
  assert.strictEqual(platform.isWindows('linux'), false);
  assert.strictEqual(platform.isMac('darwin'), true);
  assert.strictEqual(platform.isLinux('linux'), true);
  assert.strictEqual(platform.isLinux('darwin'), false);
});

test('homeDir and arch return strings', () => {
  assert.strictEqual(typeof platform.homeDir(), 'string');
  assert.strictEqual(typeof platform.arch(), 'string');
});
