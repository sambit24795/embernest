'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const mm = require('../src/server/model-meta');
const downloads = require('../src/server/downloads');
const { civitaiTriggerWords, normalizeCivitai } = require('../src/server/models');

/** Build a tiny safetensors file: header only claims tensors, data is zero-filled. */
function writeSafetensors(file, tensors, metadata) {
  const header = {};
  if (metadata) header.__metadata__ = metadata;
  let offset = 0;
  for (const [name, shape] of Object.entries(tensors)) {
    header[name] = { dtype: 'F16', shape, data_offsets: [offset, offset] };
  }
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([len, json]));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pk-meta-'));

const SD15_CKPT = {
  'model.diffusion_model.input_blocks.0.0.weight': [320, 4, 3, 3],
  'cond_stage_model.transformer.text_model.embeddings.position_ids': [1, 77],
  'first_stage_model.encoder.conv_in.weight': [128, 3, 3, 3],
};
const SDXL_CKPT = {
  'model.diffusion_model.input_blocks.0.0.weight': [320, 4, 3, 3],
  'model.diffusion_model.label_emb.0.0.weight': [1280, 2816],
  'conditioner.embedders.1.model.token_embedding.weight': [49408, 1280],
};

test('readSafetensorsHeader parses tensors and metadata without touching data', async () => {
  const dir = tmp();
  const f = path.join(dir, 'a.safetensors');
  writeSafetensors(f, SD15_CKPT, { 'modelspec.title': 'T' });
  const h = await mm.readSafetensorsHeader(f);
  assert.deepEqual(h.tensors['model.diffusion_model.input_blocks.0.0.weight'].shape, [320, 4, 3, 3]);
  assert.equal(h.metadata['modelspec.title'], 'T');
});

test('readSafetensorsHeader rejects oversized, truncated and junk headers', async () => {
  const dir = tmp();
  const big = path.join(dir, 'big.safetensors');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(mm.MAX_HEADER_BYTES + 1));
  fs.writeFileSync(big, Buffer.concat([len, Buffer.from('{}')]));
  await assert.rejects(mm.readSafetensorsHeader(big), /implausible/);
  const trunc = path.join(dir, 'trunc.safetensors');
  len.writeBigUInt64LE(1000n);
  fs.writeFileSync(trunc, Buffer.concat([len, Buffer.from('{}')]));
  await assert.rejects(mm.readSafetensorsHeader(trunc), /past the end/);
  const junk = path.join(dir, 'junk.safetensors');
  fs.writeFileSync(junk, 'not a safetensors file at all');
  await assert.rejects(mm.readSafetensorsHeader(junk));
});

function infer(type, tensors, metadata = {}, fileName = 'x.safetensors') {
  return mm.inferFromHeader({ type, fileName, header: { tensors: Object.fromEntries(Object.entries(tensors).map(([k, shape]) => [k, { shape }])), metadata } });
}

test('checkpoint family: SD 1.5, SDXL, Flux, SD 2 (unknown)', () => {
  assert.equal(infer('checkpoint', SD15_CKPT).family, 'sd15');
  assert.equal(infer('checkpoint', SDXL_CKPT).family, 'sdxl');
  assert.equal(infer('checkpoint', { 'double_blocks.0.img_attn.qkv.weight': [1, 1], 'single_blocks.0.linear1.weight': [1, 1] }).family, 'flux');
  assert.equal(infer('checkpoint', { 'cond_stage_model.model.transformer.x': [1] }).family, 'unknown');
});

test('checkpoint inpainting comes from the 9-channel first conv', () => {
  const inp = infer('checkpoint', { ...SD15_CKPT, 'model.diffusion_model.input_blocks.0.0.weight': [320, 9, 3, 3] });
  assert.equal(inp.inpainting, true);
  assert.equal(inp.family, 'sd15');
  assert.equal(infer('checkpoint', SD15_CKPT).inpainting, false);
  assert.equal(infer('lora', SD15_CKPT).inpainting, false);
});

test('SDXL is refined to Pony or Illustrious only on explicit hints', () => {
  assert.equal(infer('checkpoint', SDXL_CKPT, {}, 'ponyDiffusionV6XL.safetensors').family, 'pony');
  assert.equal(infer('checkpoint', SDXL_CKPT, { 'modelspec.title': 'Illustrious-XL v1' }).family, 'illustrious');
  assert.equal(infer('checkpoint', SDXL_CKPT, { ss_tag_frequency: '{"x":{"score_9":5}}' }).family, 'pony');
  assert.equal(infer('checkpoint', SDXL_CKPT, {}, 'juggernautXL.safetensors').family, 'sdxl');
});

test('LoRA family from text encoder names and cross-attention width', () => {
  assert.equal(infer('lora', { 'lora_te_text_model_encoder_layers_0_mlp_fc1.lora_down.weight': [8, 768] }).family, 'sd15');
  assert.equal(infer('lora', { 'lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_down.weight': [8, 1280] }).family, 'sdxl');
  assert.equal(infer('lora', { 'lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight': [8, 2048] }).family, 'sdxl');
  assert.equal(infer('lora', { 'lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight': [8, 768] }).family, 'sd15');
  assert.equal(infer('lora', { 'transformer.single_transformer_blocks.0.attn.to_k.lora_A.weight': [8, 3072] }).family, 'flux');
});

test('metadata decides when tensors do not, and tensors win over metadata', () => {
  assert.equal(infer('lora', { 'hada_w1_a': [8, 8] }, { ss_base_model_version: 'sdxl_base_v1-0' }).family, 'sdxl');
  assert.equal(infer('lora', { 'weird': [1] }, {}).family, 'unknown');
  assert.equal(infer('checkpoint', SD15_CKPT, { ss_base_model_version: 'sdxl_base_v1-0' }).family, 'sd15');
});

test('embedding family', () => {
  assert.equal(infer('embedding', { clip_l: [1, 768], clip_g: [1, 1280] }).family, 'sdxl');
  assert.equal(infer('embedding', { emb_params: [4, 768] }).family, 'sd15');
});

test('inferFromName guesses from the file name', () => {
  assert.deepEqual(
    (({ family, inpainting, source }) => ({ family, inpainting, source }))(mm.inferFromName('realisticVision_inpainting.ckpt')),
    { family: 'unknown', inpainting: true, source: 'guess' },
  );
  assert.equal(mm.inferFromName('pony_thing_v2.pt').family, 'pony');
  assert.equal(mm.inferFromName('flux-dev.bin').family, 'flux');
  assert.equal(mm.inferFromName('model_sd1.5.ckpt').family, 'sd15');
});

test('compatible(): matrix', () => {
  const c = (a, b) => mm.compatible({ family: a }, { family: b });
  assert.equal(c('sd15', 'sd15'), 'yes');
  assert.equal(c('sdxl', 'sdxl'), 'yes');
  assert.equal(c('sd15', 'sdxl'), 'no');
  assert.equal(c('sd15', 'pony'), 'no');
  assert.equal(c('flux', 'sd15'), 'no');
  assert.equal(c('sdxl', 'pony'), 'unknown');
  assert.equal(c('pony', 'illustrious'), 'unknown');
  assert.equal(c('pony', 'pony'), 'yes');
  assert.equal(c('unknown', 'sd15'), 'unknown');
  assert.equal(c('sd15', 'unknown'), 'unknown');
  assert.equal(mm.compatible(null, { family: 'sd15' }), 'unknown');
  assert.equal(mm.compatible({ family: 'sd15' }, undefined), 'unknown');
});

test('store: scan, cache by size+mtime, prune, and round trip', async () => {
  const dir = tmp();
  writeSafetensors(path.join(dir, 'checkpoints', 'a.safetensors'), { ...SD15_CKPT, 'model.diffusion_model.input_blocks.0.0.weight': [320, 9, 3, 3] });
  writeSafetensors(path.join(dir, 'loras', 'sub', 'b.safetensors'), { 'lora_te2_x.lora_down.weight': [8, 1280] });
  fs.writeFileSync(path.join(dir, 'checkpoints', 'old.ckpt'), 'x');
  fs.writeFileSync(path.join(dir, 'checkpoints', 'a.safetensors.part'), 'x');
  fs.writeFileSync(path.join(dir, 'checkpoints', 'put_checkpoints_here'), '');

  const store = mm.createMetaStore(dir);
  await store.scan();
  const all = store.all();
  assert.deepEqual(Object.keys(all).sort(), ['checkpoints/a.safetensors', 'checkpoints/old.ckpt', 'loras/sub/b.safetensors']);
  assert.equal(all['checkpoints/a.safetensors'].inpainting, true);
  assert.equal(all['checkpoints/a.safetensors'].source, 'header');
  assert.equal(all['loras/sub/b.safetensors'].family, 'sdxl');
  assert.equal(all['checkpoints/old.ckpt'].source, 'guess');
  assert.equal(all['checkpoints/a.safetensors'].recommendedStrength, null);

  // Round trip through a fresh store reading the file; mode is owner-only.
  assert.ok(fs.existsSync(store.file));
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o077, 0);
  const again = mm.createMetaStore(dir);
  assert.deepEqual(again.all(), all);

  // Cached: an unchanged file is not re-read (poison the cache to prove it).
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  raw['checkpoints/a.safetensors'].family = 'flux';
  fs.writeFileSync(store.file, JSON.stringify(raw));
  const cached = mm.createMetaStore(dir);
  await cached.scan();
  assert.equal(cached.get('checkpoints/a.safetensors').family, 'flux');

  // Changed size -> re-read; deleted file -> pruned.
  writeSafetensors(path.join(dir, 'checkpoints', 'a.safetensors'), SDXL_CKPT);
  fs.rmSync(path.join(dir, 'checkpoints', 'old.ckpt'));
  await cached.scan();
  assert.equal(cached.get('checkpoints/a.safetensors').family, 'sdxl');
  assert.equal(cached.get('checkpoints/old.ckpt'), null);
});

test('store: a corrupt meta file is rebuilt, never fatal', async () => {
  const dir = tmp();
  writeSafetensors(path.join(dir, 'checkpoints', 'a.safetensors'), SD15_CKPT);
  fs.writeFileSync(path.join(dir, mm.META_FILE), '{ not json');
  const store = mm.createMetaStore(dir);
  assert.deepEqual(store.all(), {});
  await store.scan();
  assert.equal(store.get('checkpoints/a.safetensors').family, 'sd15');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(store.file, 'utf8')));

  fs.writeFileSync(path.join(dir, mm.META_FILE), '[1,2]');
  const arr = mm.createMetaStore(dir);
  assert.deepEqual(arr.all(), {});
  fs.writeFileSync(path.join(dir, mm.META_FILE), JSON.stringify({ 'loras/x.safetensors': 5 }));
  assert.deepEqual(mm.createMetaStore(dir).all(), {});
});

test('store: scanning a missing models folder is harmless and writes nothing', async () => {
  const dir = path.join(tmp(), 'nope');
  const store = mm.createMetaStore(dir);
  await store.scan();
  assert.deepEqual(store.all(), {});
  assert.equal(fs.existsSync(dir), false);
});

test('civitaiTriggerWords splits, trims and dedupes trainedWords', () => {
  assert.deepEqual(civitaiTriggerWords(['abstract, brush stroke, ', 'brush stroke', ' sks ']), ['abstract', 'brush stroke', 'sks']);
  assert.deepEqual(civitaiTriggerWords(undefined), []);
  const n = normalizeCivitai({
    id: 1, name: 'Foo Inpainting', type: 'Checkpoint',
    modelVersions: [{ id: 2, baseModel: 'SD 1.5', trainedWords: ['a, b'], files: [] }],
  });
  assert.deepEqual(n.triggerWords, ['a', 'b']);
  assert.equal(n.inpainting, true);
  assert.equal(n.recommendedStrength, null);
});

test('download stores the search-item metadata next to the file', async (t) => {
  const dir = tmp();
  const body = Buffer.alloc(64);
  const server = http.createServer((req, res) => { res.setHeader('content-length', body.length); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const lorasDir = path.join(dir, 'loras');
  const client = { listModelFolders: async () => [{ name: 'loras', folders: [lorasDir], extensions: [] }] };
  const store = mm.createMetaStore(dir);

  const job = downloads.startDownload({
    client,
    downloadUrl: `http://127.0.0.1:${server.address().port}/f.safetensors`,
    type: 'lora',
    fileName: 'f.safetensors',
    provider: 'civitai',
    metaStore: store,
    meta: {
      name: 'Foo', baseModel: 'SD 1.5', homeUrl: 'https://civitai.com/models/1', provider: 'civitai',
      triggerWords: ['sks style', 'sks style', 5], recommendedStrength: 0.7, junk: 'ignored',
    },
  });
  for (let i = 0; i < 100 && downloads.getJob(job.id).status !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(downloads.getJob(job.id).status, 'done');
  const m = store.get('loras/f.safetensors');
  assert.equal(m.type, 'lora');
  assert.equal(m.family, 'sd15');
  assert.equal(m.source, 'download');
  assert.deepEqual(m.triggerWords, ['sks style']);
  assert.equal(m.recommendedStrength, 0.7);
  assert.equal(m.homeUrl, 'https://civitai.com/models/1');
  assert.equal(m.name, 'Foo');
  assert.equal(m.junk, undefined);

  // A later scan keeps the downloaded entry (size+mtime unchanged).
  await mm.createMetaStore(dir).scan();
  assert.equal(mm.createMetaStore(dir).get('loras/f.safetensors').triggerWords[0], 'sks style');
});

test('sanitizeDownloadMeta rejects non-http homeUrl and out-of-range strength', () => {
  const m = mm.sanitizeDownloadMeta({ homeUrl: 'javascript:alert(1)', recommendedStrength: 9, triggerWords: 'x' });
  assert.equal(m.homeUrl, null);
  assert.equal(m.recommendedStrength, null);
  assert.deepEqual(m.triggerWords, []);
  assert.equal(mm.sanitizeDownloadMeta(null), null);
});

test('GET /api/models/installed carries meta; /compatibility rates LoRAs', async (t) => {
  const { getPaths } = require('../src/core/paths');
  const { saveConfig } = require('../src/core/config');
  const { createApp } = require('../src/server/app');
  const { startFakeComfy } = require('./helpers/fake-comfy');
  const home = tmp();
  const paths = getPaths(home);
  const fake = await startFakeComfy();
  const modelsDir = fake.modelsDir;
  saveConfig(paths, { authToken: 'tok', comfy: { mode: 'external', url: fake.url, dir: path.dirname(modelsDir) } });
  writeSafetensors(path.join(modelsDir, 'checkpoints', 'c.safetensors'), SD15_CKPT);
  writeSafetensors(path.join(modelsDir, 'loras', 'xl.safetensors'), { 'lora_te2_x.lora_down.weight': [8, 1280] });
  writeSafetensors(path.join(modelsDir, 'loras', 'ok.safetensors'), { 'lora_te_x.lora_down.weight': [8, 768] });
  const hw = { os: 'linux', cpu: { model: 'x', cores: 1 }, ramGB: 16, freeDiskGB: 10, gpu: { vendor: 'nvidia', name: 'g', vramGB: 6 }, source: [] };
  const server = createApp({ paths, hardware: hw, safety: { check: async () => ({}), close() {} } }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fake.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  await mm.getMetaStore(modelsDir).scan();
  const inst = await (await fetch(`${base}/api/models/installed`)).json();
  const ck = inst.folders.checkpoints.find((f) => f.name === 'c.safetensors');
  assert.equal(ck.meta.family, 'sd15');
  assert.equal(ck.meta.homeUrl, null);
  const comp = await (await fetch(`${base}/api/models/compatibility?checkpoint=c.safetensors`)).json();
  assert.deepEqual(comp.loras, { 'xl.safetensors': 'no', 'ok.safetensors': 'yes' });
  const none = await (await fetch(`${base}/api/models/compatibility?checkpoint=missing.safetensors`)).json();
  assert.equal(none.loras['ok.safetensors'], 'unknown');
});
