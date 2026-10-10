'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildInpaintWorkflow, buildTxt2ImgWorkflow, buildImg2ImgWorkflow } = require('../src/server/workflow');

const BASE = {
  inpaint: { imageName: 'in.png', checkpoint: 'a.safetensors', bgRemovalModel: 'birefnet.safetensors', positive: 'p' },
  txt2img: { checkpoint: 'a.safetensors', positive: 'p', width: 512, height: 512 },
  img2img: { imageName: 'in.png', checkpoint: 'a.safetensors', positive: 'p', width: 512, height: 512 },
};

const BUILDERS = [
  ['buildInpaintWorkflow', buildInpaintWorkflow, BASE.inpaint],
  ['buildTxt2ImgWorkflow', buildTxt2ImgWorkflow, BASE.txt2img],
  ['buildImg2ImgWorkflow', buildImg2ImgWorkflow, BASE.img2img],
];

const nodesOf = (workflow, classType) =>
  Object.entries(workflow).filter(([, node]) => node.class_type === classType);

for (const [name, build, base] of BUILDERS) {
  test(`${name}: every node has class_type and inputs`, () => {
    const wf = build({ ...base, seed: 1 });
    const ids = Object.keys(wf);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      assert.strictEqual(typeof wf[id].class_type, 'string', `node ${id} class_type`);
      assert.strictEqual(typeof wf[id].inputs, 'object', `node ${id} inputs`);
    }
  });

  test(`${name}: loraName adds a LoraLoader that feeds the KSampler model`, () => {
    const wf = build({ ...base, seed: 1, loraName: 'style.safetensors' });
    const loaders = nodesOf(wf, 'LoraLoader');
    assert.strictEqual(loaders.length, 1);
    const [loaderId] = loaders[0];
    assert.strictEqual(wf[loaderId].inputs.lora_name, 'style.safetensors');
    const [samplerId] = nodesOf(wf, 'KSampler')[0];
    assert.strictEqual(wf[samplerId].inputs.model[0], loaderId);
  });
}

test('buildImg2ImgWorkflow uses VAEEncode and no inpaint encoder', () => {
  const wf = buildImg2ImgWorkflow({ ...BASE.img2img, seed: 1 });
  assert.ok(nodesOf(wf, 'VAEEncode').length >= 1);
  assert.strictEqual(nodesOf(wf, 'VAEEncodeForInpaint').length, 0);
});
