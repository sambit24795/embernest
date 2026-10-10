'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const brand = require('../src/brand');
const pkg = require('../package.json');

test('getEnv prefers EMBERNEST_* and falls back to PIXELKILN_*', () => {
  assert.strictEqual(brand.getEnv('NO_SAFETY', {}), undefined);
  assert.strictEqual(brand.getEnv('NO_SAFETY', { PIXELKILN_NO_SAFETY: '1' }), '1');
  assert.strictEqual(brand.getEnv('NO_SAFETY', { EMBERNEST_NO_SAFETY: '1' }), '1');
  assert.strictEqual(brand.getEnv('X', { EMBERNEST_X: 'new', PIXELKILN_X: 'old' }), 'new');
  assert.strictEqual(brand.getEnv('X', { EMBERNEST_X: '', PIXELKILN_X: 'old' }), 'old');
});

test('package.json keeps the pixelkiln command as an alias of embernest', () => {
  assert.strictEqual(pkg.name, 'embernest');
  assert.strictEqual(pkg.bin.embernest, 'bin/embernest.js');
  assert.strictEqual(pkg.bin.pixelkiln, 'bin/embernest.js');
  assert.ok(require('node:fs').existsSync(path.join(__dirname, '..', pkg.bin.embernest)));
});
