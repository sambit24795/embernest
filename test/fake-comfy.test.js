'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ComfyClient } = require('../src/server/comfy');
const { buildTxt2ImgWorkflow } = require('../src/server/workflow');
const { startFakeComfy } = require('./helpers/fake-comfy');

test('fake ComfyUI answers health, combo lists and model folders', async (t) => {
  const fake = await startFakeComfy({ checkpoints: ['a.safetensors', 'b.safetensors'], loras: ['l.safetensors'] });
  t.after(() => fake.close());
  const client = new ComfyClient(fake.url);

  const stats = await client.health();
  assert.ok(stats.system);
  assert.deepStrictEqual(await client.comboOptions('CheckpointLoaderSimple', 'ckpt_name'), ['a.safetensors', 'b.safetensors']);
  assert.deepStrictEqual(await client.listLoras(), ['l.safetensors']);
  assert.ok((await client.listSamplers()).includes('dpmpp_2m'));
  assert.ok((await client.listBackgroundRemovalModels()).length > 0);
  assert.ok((await client.listFaceModels()).length > 0);

  const folders = await client.listModelFolders();
  assert.ok(folders.find((f) => f.name === 'checkpoints').folders[0].startsWith(fake.modelsDir));
  assert.ok(fake.calls.includes('GET /system_stats'));
});

test('fake ComfyUI runs a workflow and serves the image', async (t) => {
  const fake = await startFakeComfy();
  t.after(() => fake.close());
  const client = new ComfyClient(fake.url);

  const workflow = buildTxt2ImgWorkflow({ checkpoint: 'a.safetensors', positive: 'x', width: 512, height: 512 });
  const { images } = await client.runWorkflow(workflow, { clientId: 'c1', pollInterval: 20 });
  assert.strictEqual(images.length, 1);
  const { buffer, contentType } = await client.viewImage(images[0]);
  assert.strictEqual(contentType, 'image/png');
  assert.strictEqual(buffer.subarray(1, 4).toString(), 'PNG');
});

test('failPrompt makes runWorkflow reject', async (t) => {
  const fake = await startFakeComfy({ failPrompt: true });
  t.after(() => fake.close());
  const client = new ComfyClient(fake.url);
  const workflow = buildTxt2ImgWorkflow({ checkpoint: 'a.safetensors', positive: 'x', width: 512, height: 512 });
  await assert.rejects(client.runWorkflow(workflow, { pollInterval: 20 }), /execution failed/);
});
