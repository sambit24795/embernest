'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { extract, findFile } = require('../src/core/archive');

const FIXTURE_ZIP = path.join(__dirname, 'fixtures', 'sample.zip');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pk-arc-'));

test('extract a tar.gz with strip: 1 drops the top folder', async () => {
  const work = tmp();
  const src = path.join(work, 'src');
  fs.mkdirSync(path.join(src, 'pkg', 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'pkg', 'a.txt'), 'A');
  fs.writeFileSync(path.join(src, 'pkg', 'b', 'c.txt'), 'C');
  const archive = path.join(work, 'pkg.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: src }, ['pkg']);

  const dest = path.join(work, 'out');
  await extract(archive, dest, { strip: 1 });
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'A');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'b', 'c.txt'), 'utf8'), 'C');
  assert.ok(!fs.existsSync(path.join(dest, 'pkg')));
});

test('extract a zip fixture with strip: 1 (round trip)', async () => {
  const dest = path.join(tmp(), 'out');
  await extract(FIXTURE_ZIP, dest, { strip: 1 });
  assert.strictEqual(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8'), 'hello from pixelkiln\n');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'sub', 'note.txt'), 'utf8'), 'nested note\n');
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['hello.txt', 'sub']);
});

test('extract a zip with strip: 0 keeps the top folder and leaves no scratch folder', async () => {
  const dest = path.join(tmp(), 'out');
  await extract(FIXTURE_ZIP, dest);
  assert.strictEqual(
    fs.readFileSync(path.join(dest, 'sample', 'sub', 'data.json'), 'utf8'),
    '{"ok": true}\n',
  );
  assert.deepStrictEqual(fs.readdirSync(dest), ['sample']);
});

test('extract rejects an unsupported archive type', async () => {
  await assert.rejects(extract('/nope/file.rar', tmp()), /unsupported archive type/);
});

test('findFile returns the shallowest match, or null', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'x', 'y'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'x', 'y', 'target.bin'), '1');
  fs.writeFileSync(path.join(dir, 'x', 'target.bin'), '2');
  assert.strictEqual(await findFile(dir, ['target.bin']), path.join(dir, 'x', 'target.bin'));
  assert.strictEqual(await findFile(dir, ['missing.bin', 'other.bin']), null);
});

test('zip extraction refuses entries that escape the destination', async () => {
  // Build a minimal one-entry zip by hand (no zip-writer dependency).
  const name = Buffer.from('../evil.txt');
  const data = Buffer.from('x');
  const crc = require('node:zlib').crc32 ? require('node:zlib').crc32(data) : 0x8cdc1683;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4);
  local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(1, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(10, 6);
  central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(1, 20); central.writeUInt32LE(1, 24); central.writeUInt16LE(name.length, 28);
  const localPart = Buffer.concat([local, name, data]);
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12); end.writeUInt32LE(localPart.length, 16);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-zipslip-'));
  const zipPath = path.join(dir, 'evil.zip');
  fs.writeFileSync(zipPath, Buffer.concat([localPart, centralPart, end]));
  const dest = path.join(dir, 'out');
  await assert.rejects(extract(zipPath, dest), /escapes|invalid|relative/i);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')));
});
