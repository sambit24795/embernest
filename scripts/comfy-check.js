#!/usr/bin/env node
/**
 * scripts/comfy-check.js — quick self-check for the ComfyUI client + workflow.
 *
 * Usage:
 *   npm run check:comfy          # health, list models, print workflow node count
 *   npm run check:comfy -- --run # also actually run the workflow and save a PNG
 *
 * `--run` expects the sample file `test_big.png` to exist in ComfyUI's input/
 * folder (it ships with a fresh ComfyUI install).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ComfyClient } = require('../src/comfy');
const { buildInpaintWorkflow } = require('../src/workflow');
const { loadConfig } = require('../src/config');

const RUN = process.argv.includes('--run');

(async () => {
  const config = loadConfig();
  const client = new ComfyClient(config.comfyUrl);

  console.log(`ComfyUI: ${config.comfyUrl}`);
  const stats = await client.health();
  console.log(`  health OK — ComfyUI ${stats.system.comfyui_version}`);

  const checkpoints = await client.listCheckpoints();
  const bgModels = await client.listBackgroundRemovalModels();
  const faceModels = await client.listFaceModels();
  const samplers = await client.listSamplers();
  console.log(`  checkpoints: ${checkpoints.length}, bg-removal: ${bgModels.length}, face: ${faceModels.length}, samplers: ${samplers.length}`);
  checkpoints.forEach((m) => console.log(`    ckpt: ${m}`));

  if (!checkpoints.length || !bgModels.length) {
    throw new Error('Need at least one checkpoint and one background-removal model (see README).');
  }

  const workflow = buildInpaintWorkflow({
    imageName: 'test_big.png',
    checkpoint: checkpoints[0],
    bgRemovalModel: bgModels[0],
    faceModel: faceModels[0] || null,
    positive: 'wearing a red silk shirt, photorealistic, detailed fabric',
    negative: 'blurry, low quality, worst quality, deformed body, extra limbs, bad anatomy',
    width: 1048,
    height: 960,
    maxSize: config.defaults.maxSize,
    denoise: config.defaults.denoise,
    steps: config.defaults.steps,
    cfg: config.defaults.cfg,
    sampler: config.defaults.sampler,
    scheduler: config.defaults.scheduler,
    filenamePrefix: 'pixelkiln_check',
  });
  console.log(`  workflow nodes: ${Object.keys(workflow).length} (expect 18 for a >maxSize image)`);

  if (!RUN) {
    console.log('\nAdd --run to execute it for real.');
    return;
  }

  console.log('\nRunning workflow (this can take a minute or two)...');
  const started = Date.now();
  const { images } = await client.runWorkflow(workflow, { timeout: 900000 });
  console.log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (!images.length) throw new Error('ComfyUI returned no images');

  const first = await client.viewImage(images[0]);
  const outPath = path.join('/tmp', 'pixelkiln_check.png');
  fs.writeFileSync(outPath, first.buffer);
  console.log(`  saved ${outPath} (${first.buffer.length} bytes)`);
})().catch((err) => {
  console.error(`\nCheck failed: ${err.message}`);
  process.exit(1);
});
