'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../src/core/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pk-state-'));

test('readJson returns the fallback for a missing or corrupt file', () => {
  const dir = tmp();
  assert.strictEqual(readJson(path.join(dir, 'nope.json')), null);
  assert.deepStrictEqual(readJson(path.join(dir, 'nope.json'), { a: 1 }), { a: 1 });
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.strictEqual(readJson(bad, 'fallback'), 'fallback');
});

test('writeJson then readJson round trips and creates the folder', () => {
  const file = path.join(tmp(), 'run', 'state.json');
  writeJson(file, { pids: [1, 2], ok: true });
  assert.deepStrictEqual(readJson(file), { pids: [1, 2], ok: true });
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('writeJson replaces an existing file', () => {
  const file = path.join(tmp(), 'state.json');
  writeJson(file, { v: 1 });
  writeJson(file, { v: 2 });
  assert.deepStrictEqual(readJson(file), { v: 2 });
});
