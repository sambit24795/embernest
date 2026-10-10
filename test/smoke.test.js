'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('version is a string', () => {
  assert.strictEqual(typeof require('../src/version'), 'string');
});
