'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { detectHardware, parseNvidiaSmiCsv, parseCudaVersion, parseRocmSmiJson, freeDiskGB } = require('../src/core/hardware');

test('parseNvidiaSmiCsv: single GPU', () => {
  const out = parseNvidiaSmiCsv('NVIDIA GeForce GTX 1660 Ti, 6144, 580.95.05, 7.5\n');
  assert.deepEqual(out, [{ name: 'NVIDIA GeForce GTX 1660 Ti', vramGB: 6, driver: '580.95.05', computeCap: '7.5' }]);
});

test('parseNvidiaSmiCsv: multi-GPU keeps every row', () => {
  const out = parseNvidiaSmiCsv('NVIDIA GeForce RTX 3060, 12288, 550.54.14, 8.6\r\nNVIDIA GeForce RTX 4090, 24564, 550.54.14, 8.9\r\n');
  assert.equal(out.length, 2);
  assert.equal(out[1].vramGB, 24);
  assert.equal(out[1].computeCap, '8.9');
});

test('parseNvidiaSmiCsv: [N/A] or missing compute_cap gives empty string', () => {
  assert.equal(parseNvidiaSmiCsv('Tesla K80, 11441, 470.82.01, [N/A]')[0].computeCap, '');
  assert.equal(parseNvidiaSmiCsv('Tesla K80, 11441, 470.82.01, [Not Supported]')[0].computeCap, '');
  assert.equal(parseNvidiaSmiCsv('Tesla K80, 11441, 470.82.01')[0].computeCap, '');
});

test('parseNvidiaSmiCsv: junk and empty input', () => {
  assert.deepEqual(parseNvidiaSmiCsv(''), []);
  assert.deepEqual(parseNvidiaSmiCsv(undefined), []);
  assert.deepEqual(parseNvidiaSmiCsv('NVIDIA-SMI has failed because it could not communicate'), []);
});

const HEADER = `Thu Oct  8 10:00:00 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 570.86.10              Driver Version: 570.86.10      CUDA Version: 12.8     |
|-----------------------------------------+------------------------+----------------------+
`;

test('parseCudaVersion', () => {
  assert.equal(parseCudaVersion(HEADER), '12.8');
  assert.equal(parseCudaVersion('CUDA Version: 11.4'), '11.4');
  assert.equal(parseCudaVersion('no gpu here'), '');
  assert.equal(parseCudaVersion(''), '');
});

test('parseRocmSmiJson: two cards', () => {
  const json = JSON.stringify({
    card0: { 'VRAM Total Memory (B)': '17163091968', 'VRAM Total Used Memory (B)': '123456' },
    card1: { 'VRAM Total Memory (B)': '8589934592', 'Card Series': 'Radeon RX 6600' },
  });
  const cards = parseRocmSmiJson(json);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].vramGB, 16);
  assert.equal(cards[1].vramGB, 8);
  assert.equal(cards[1].name, 'Radeon RX 6600');
});

test('parseRocmSmiJson: invalid input gives []', () => {
  assert.deepEqual(parseRocmSmiJson('not json'), []);
  assert.deepEqual(parseRocmSmiJson('{"system": {"Driver version": "6.1"}}'), []);
});

test('freeDiskGB walks up to an existing parent', async () => {
  const gb = await freeDiskGB(require('node:path').join(os.tmpdir(), 'embernest-nope', 'a', 'b'));
  assert.ok(gb > 0);
});

test('detectHardware returns the documented shape and never throws', async () => {
  const hw = await detectHardware({ dataDir: os.tmpdir() });
  assert.ok(['linux', 'darwin', 'win32'].includes(hw.os));
  assert.ok(hw.cpu.cores > 0);
  assert.ok(hw.ramGB > 0);
  assert.ok(['nvidia', 'amd', 'apple', 'intel', 'none'].includes(hw.gpu.vendor));
  for (const k of ['name', 'driver', 'cudaVersion', 'computeCap']) assert.equal(typeof hw.gpu[k], 'string');
  assert.ok(Array.isArray(hw.source));
});
