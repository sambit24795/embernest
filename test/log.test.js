'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger, rotateIfNeeded } = require('../src/core/log');

function tempFile(name = 'x.log') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-log-'));
  return { dir, file: path.join(dir, name) };
}

test('rotateIfNeeded does nothing when the file is at or under maxBytes', () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, 'abc');
    assert.strictEqual(rotateIfNeeded(file, 3, 3), false);
    assert.strictEqual(fs.existsSync(`${file}.1`), false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'abc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateIfNeeded shifts backups and keeps only `keep` of them', () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(`${file}.1`, 'old1');
    fs.writeFileSync(`${file}.2`, 'old2');
    fs.writeFileSync(`${file}.3`, 'old3');
    fs.writeFileSync(file, 'x'.repeat(10));
    assert.strictEqual(rotateIfNeeded(file, 5, 3), true);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(fs.readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(10));
    assert.strictEqual(fs.readFileSync(`${file}.2`, 'utf8'), 'old1');
    assert.strictEqual(fs.readFileSync(`${file}.3`, 'utf8'), 'old2');
    assert.strictEqual(fs.existsSync(`${file}.4`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateIfNeeded returns false for a missing file', () => {
  const { dir, file } = tempFile();
  try {
    assert.strictEqual(rotateIfNeeded(file, 1, 3), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createLogger writes ISO-time LEVEL message lines', () => {
  const { dir, file } = tempFile('app.log');
  try {
    const log = createLogger(file);
    log.info('hello');
    log.warn('careful');
    log.error('boom');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO hello$/);
    assert.match(lines[1], /^\S+ WARN careful$/);
    assert.match(lines[2], /^\S+ ERROR boom$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createLogger rotates before writing once the file is over the limit', () => {
  const { dir, file } = tempFile('app.log');
  try {
    fs.writeFileSync(file, 'y'.repeat(10 * 1024 * 1024 + 1));
    createLogger(file).info('after rotation');
    assert.strictEqual(fs.statSync(`${file}.1`).size, 10 * 1024 * 1024 + 1);
    assert.match(fs.readFileSync(file, 'utf8'), /INFO after rotation\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
