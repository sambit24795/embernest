'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectUvAsset, uvEnv, ensureUv } = require('../src/install/uv');
const { getPaths } = require('../src/core/paths');
const { getManifest } = require('../src/install/manifest');

const manifest = getManifest();

test('selectUvAsset builds the url from version and file', () => {
  const a = selectUvAsset(manifest, 'linux', 'x64');
  assert.equal(a.file, 'uv-x86_64-unknown-linux-gnu.tar.gz');
  assert.equal(a.url, `https://github.com/astral-sh/uv/releases/download/${manifest.uv.version}/${a.file}`);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
});

test('selectUvAsset covers every platform and picks zip on windows', () => {
  for (const [p, a] of [['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']]) {
    assert.equal(selectUvAsset(manifest, p, a).key, `${p}-${a}`);
  }
  assert.ok(selectUvAsset(manifest, 'win32', 'x64').file.endsWith('.zip'));
});

test('selectUvAsset rejects an unsupported machine', () => {
  assert.throws(() => selectUvAsset(manifest, 'freebsd', 'x64'), /no uv build pinned for freebsd-x64/);
});

test('uvEnv pins cache, python dir and ignores user config', () => {
  const paths = getPaths('/tmp/pk-home');
  const env = uvEnv(paths);
  assert.equal(env.UV_CACHE_DIR, paths.uvCache);
  assert.equal(env.UV_PYTHON_INSTALL_DIR, paths.python);
  assert.equal(env.UV_PYTHON_PREFERENCE, 'only-managed');
  assert.equal(env.UV_NO_CONFIG, '1');
});

test('ensureUv dry-run does not download', async () => {
  const paths = getPaths('/tmp/pk-does-not-exist');
  assert.equal(await ensureUv(paths, { dryRun: true }), paths.uv);
});
