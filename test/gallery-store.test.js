'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { readPngText, readEmbeddedGraph } = require('../src/server/png-meta');
const { createGalleryStore } = require('../src/server/gallery-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-'));

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]); // CRC is not checked by the reader
}
const text = (k, v) => chunk('tEXt', Buffer.from(`${k}\0${v}`, 'latin1'));

/** A tiny PNG shell: signature, IHDR, the given text chunks, IDAT, IEND. */
function makePng(chunks) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    ...chunks,
    chunk('IDAT', Buffer.from('pixels')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GRAPH = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'a lighthouse', clip: ['1', 1] } },
  3: { class_type: 'KSampler', inputs: { seed: 5, steps: 10, positive: ['2', 0], negative: ['2', 0] } },
};

test('readPngText reads tEXt, zTXt and iTXt chunks before the pixel data', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.png');
  const itxt = Buffer.concat([Buffer.from('note\0\0\0\0\0', 'latin1'), Buffer.from('héllo', 'utf8')]);
  const ztxt = Buffer.concat([Buffer.from('zed\0\0', 'latin1'), zlib.deflateSync('zipped')]);
  fs.writeFileSync(file, makePng([text('prompt', JSON.stringify(GRAPH)), chunk('iTXt', itxt), chunk('zTXt', ztxt)]));
  const t = await readPngText(file);
  assert.deepStrictEqual(JSON.parse(t.prompt), GRAPH);
  assert.strictEqual(t.note, 'héllo');
  assert.strictEqual(t.zed, 'zipped');
  assert.deepStrictEqual(await readEmbeddedGraph(file), GRAPH);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readPngText tolerates non-PNG, missing and truncated files', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.png'), 'not a png');
  assert.deepStrictEqual(await readPngText(path.join(dir, 'x.png')), {});
  assert.deepStrictEqual(await readPngText(path.join(dir, 'missing.png')), {});
  fs.writeFileSync(path.join(dir, 'cut.png'), makePng([text('prompt', '{"a":1}')]).subarray(0, 40));
  assert.strictEqual(await readEmbeddedGraph(path.join(dir, 'cut.png')), null);
  fs.writeFileSync(path.join(dir, 'bad.png'), makePng([text('prompt', '{oops')]));
  assert.strictEqual(await readEmbeddedGraph(path.join(dir, 'bad.png')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store persists atomically with mode 0600 and survives a corrupt file', async () => {
  const dir = tmp();
  const file = path.join(dir, 'data', 'gallery.json');
  const entry = (id, name, createdAt) => ({
    id, mode: 'generate', prompt: id, settings: {}, before: null, createdAt, source: 'job',
    images: [{ filename: name, subfolder: '', type: 'output' }],
  });
  const a = createGalleryStore({ file });
  a.add(entry('p1', 'embernest_gen_1_00001_.png', 1), entry('p2', 'embernest_gen_2_00001_.png', 2));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600); // no POSIX modes on Windows
  assert.strictEqual(createGalleryStore({ file }).size(), 2);
  assert.deepStrictEqual((await a.list({ limit: 1 })).items.map((e) => e.id), ['p2']);

  fs.writeFileSync(file, '{ truncated');
  const b = createGalleryStore({ file });
  assert.strictEqual(b.size(), 0);
  fs.writeFileSync(path.join(dir, 'embernest_gen_9_00001_.png'), makePng([text('prompt', JSON.stringify(GRAPH))]));
  assert.strictEqual((await b.scan(dir)).added, 1); // rebuilt from the output folder
  assert.strictEqual(createGalleryStore({ file }).size(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store falls back to memory when the index cannot be written', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file, so mkdir under it fails');
  const store = createGalleryStore({ file: path.join(dir, 'blocker', 'gallery.json') });
  store.add({ id: 'p', mode: 'edit', images: [{ filename: 'embernest_1.png', subfolder: '' }], createdAt: 1 });
  assert.strictEqual(store.persistent, false);
  assert.strictEqual(store.size(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
