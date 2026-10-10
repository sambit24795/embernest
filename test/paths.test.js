'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveHome, getPaths, ensureDirs } = require('../src/core/paths');

const none = () => false;

test('default home on Linux uses ~/.local/share/embernest', () => {
  assert.strictEqual(
    resolveHome({ env: {}, platform: 'linux', home: '/home/me', exists: none }),
    path.join('/home/me', '.local', 'share', 'embernest'),
  );
});

test('XDG_DATA_HOME is respected on Linux', () => {
  assert.strictEqual(
    resolveHome({ env: { XDG_DATA_HOME: '/data/xdg' }, platform: 'linux', home: '/home/me', exists: none }),
    path.join('/data/xdg', 'embernest'),
  );
});

test('default home on macOS is Application Support/Embernest', () => {
  assert.strictEqual(
    resolveHome({ env: {}, platform: 'darwin', home: '/Users/me', exists: none }),
    path.join('/Users/me', 'Library', 'Application Support', 'Embernest'),
  );
});

test('default home on Windows is %LOCALAPPDATA%\\Embernest', () => {
  assert.strictEqual(
    resolveHome({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\me', exists: none }),
    'C:\\Users\\me\\AppData\\Local\\Embernest',
  );
});

test('EMBERNEST_HOME overrides the OS default on every platform', () => {
  for (const plat of ['linux', 'darwin', 'win32']) {
    assert.strictEqual(
      resolveHome({ env: { EMBERNEST_HOME: '/custom/home' }, platform: plat, home: '/home/me', exists: () => true }),
      '/custom/home',
    );
  }
});

test('PIXELKILN_HOME still works, and EMBERNEST_HOME wins over it', () => {
  assert.strictEqual(resolveHome({ env: { PIXELKILN_HOME: '/old/home' }, platform: 'linux', home: '/h', exists: none }), '/old/home');
  assert.strictEqual(
    resolveHome({ env: { PIXELKILN_HOME: '/old/home', EMBERNEST_HOME: '/new/home' }, platform: 'linux', home: '/h', exists: none }),
    '/new/home',
  );
});

test('an existing PixelKiln folder is used when no Embernest folder exists (all OSes)', () => {
  const cases = [
    { platform: 'linux', home: '/home/me', env: {}, old: path.join('/home/me', '.local', 'share', 'pixelkiln') },
    { platform: 'darwin', home: '/Users/me', env: {}, old: path.join('/Users/me', 'Library', 'Application Support', 'PixelKiln') },
    { platform: 'win32', home: 'C:\\Users\\me', env: { LOCALAPPDATA: 'C:\\L' }, old: 'C:\\L\\PixelKiln' },
  ];
  for (const c of cases) {
    const got = resolveHome({ env: c.env, platform: c.platform, home: c.home, exists: (p) => p === c.old });
    assert.strictEqual(got, c.old, c.platform);
  }
});

test('the Embernest folder wins when both folders exist', () => {
  const got = resolveHome({ env: {}, platform: 'linux', home: '/home/me', exists: () => true });
  assert.strictEqual(got, path.join('/home/me', '.local', 'share', 'embernest'));
});

test('resolveHome checks the real filesystem by default and moves nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embernest-home-'));
  const old = path.join(root, '.local', 'share', 'pixelkiln');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'marker'), 'x');
  assert.strictEqual(resolveHome({ env: {}, platform: 'linux', home: root }), old);
  assert.ok(!fs.existsSync(path.join(root, '.local', 'share', 'embernest')));
  fs.mkdirSync(path.join(root, '.local', 'share', 'embernest'));
  assert.strictEqual(resolveHome({ env: {}, platform: 'linux', home: root }), path.join(root, '.local', 'share', 'embernest'));
  assert.ok(fs.existsSync(path.join(old, 'marker')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('getPaths builds the standard layout under the given home', () => {
  const p = getPaths(path.join('/h', 'pk'));
  assert.strictEqual(p.config, path.join('/h', 'pk', 'config.json'));
  assert.strictEqual(p.state, path.join('/h', 'pk', 'run', 'state.json'));
  assert.strictEqual(p.setupState, path.join('/h', 'pk', 'run', 'setup.json'));
  assert.strictEqual(p.comfyRoot, path.join('/h', 'pk', 'comfyui'));
  assert.strictEqual(p.models, path.join('/h', 'pk', 'data', 'models'));
  assert.strictEqual(p.input, path.join('/h', 'pk', 'data', 'input'));
  assert.strictEqual(p.output, path.join('/h', 'pk', 'data', 'output'));
  assert.strictEqual(p.uvCache, path.join('/h', 'pk', 'cache', 'uv'));
  assert.strictEqual(p.hfCache, path.join('/h', 'pk', 'cache', 'hf'));
  assert.strictEqual(p.tmp, path.join('/h', 'pk', 'cache', 'tmp'));
});

test('getPaths creates nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-paths-'));
  const target = path.join(dir, 'nested');
  getPaths(target);
  assert.strictEqual(fs.existsSync(target), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureDirs creates every directory but no files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-ensure-'));
  try {
    const p = getPaths(path.join(dir, 'home'));
    await ensureDirs(p);
    for (const key of ['run', 'logs', 'tools', 'venv', 'data', 'models', 'output', 'uvCache', 'hfCache', 'tmp', 'node']) {
      assert.ok(fs.statSync(p[key]).isDirectory(), `${key} should be a directory`);
    }
    assert.strictEqual(fs.existsSync(p.config), false);
    assert.strictEqual(fs.existsSync(p.state), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
