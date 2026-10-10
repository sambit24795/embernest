'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const g = require('../src/web/js/models-guide');
const mm = require('../src/server/model-meta');

test('guideFamily and guideCompat agree with the server rules', () => {
  for (const text of ['SD 1.5', 'SDXL 1.0', 'Pony', 'Illustrious', 'Flux.1 D', 'SD 3', '', 'something']) {
    assert.equal(g.guideFamily(text), mm.familyFromText(text), text);
  }
  const fams = ['sd15', 'sdxl', 'pony', 'illustrious', 'flux', 'unknown'];
  for (const a of fams) for (const b of fams) {
    assert.equal(g.guideCompat(a, b), mm.compatible({ family: a }, { family: b }), `${a}/${b}`);
  }
});

test('insertTriggerWord appends to the end and never duplicates', () => {
  assert.deepEqual(g.insertTriggerWord('', 'sks style'), { text: 'sks style', caret: 9, added: true });
  const a = g.insertTriggerWord('a portrait', 'sks style');
  assert.equal(a.text, 'a portrait, sks style');
  assert.equal(a.caret, a.text.length);
  // never splits a phrase, even when the prompt has a trailing comma or spaces
  assert.equal(g.insertTriggerWord('portrait, cinematic still,  of a woman', 'sks').text, 'portrait, cinematic still,  of a woman, sks');
  assert.equal(g.insertTriggerWord('red, ', 'sks').text, 'red, sks');
  assert.equal(g.insertTriggerWord('red,, \n', 'sks').text, 'red, sks');
  assert.equal(g.insertTriggerWord('   ', 'sks').text, 'sks');
  const dup = g.insertTriggerWord('a portrait, SKS Style', 'sks style');
  assert.equal(dup.added, false);
  assert.equal(dup.text, 'a portrait, SKS Style');
  assert.equal(g.insertTriggerWord('x', '  ').added, false);
});

test('loraChoices hides incompatible LoRAs unless showAll', () => {
  const compat = { a: 'yes', b: 'no', c: 'unknown' };
  const hidden = g.loraChoices(['a', 'b', 'c', 'd'], compat, false);
  assert.deepEqual(hidden.options.map((o) => o.value), ['a', 'c', 'd']);
  assert.equal(hidden.hidden, 1);
  assert.match(hidden.options[1].label, /❔/);
  assert.equal(hidden.options[0].label, 'a');
  const all = g.loraChoices(['a', 'b'], compat, true);
  assert.deepEqual(all.options.map((o) => o.value), ['a', 'b']);
  assert.match(all.options[1].label, /may not work/);
  assert.equal(all.hidden, 0);
});

test('checkpoint badges and Create hints follow the inpainting flag; unknown shows nothing', () => {
  assert.equal(g.checkpointBadge({ inpainting: true }), 'best for Edit');
  assert.equal(g.checkpointBadge({ inpainting: false }), 'best for Generate');
  assert.equal(g.checkpointBadge({ inpainting: null }), '');
  assert.equal(g.checkpointBadge(null), '');
  assert.equal(g.guideHint('edit', { inpainting: false }).id, 'edit-regular');
  assert.equal(g.guideHint('edit', { inpainting: true }), null);
  assert.equal(g.guideHint('generate', { inpainting: true }).id, 'create-inpainting');
  assert.equal(g.guideHint('transform', { inpainting: true }).goal, 'realistic');
  assert.equal(g.guideHint('generate', { inpainting: false }), null);
  assert.equal(g.guideHint('edit', { inpainting: null }), null);
  assert.equal(g.guideHint('edit', null), null);
});

test('pickWelcome picks one checkpoint per goal for the right family', () => {
  const entries = [
    { id: 'a', type: 'checkpoint', goal: 'realistic', family: 'sdxl' },
    { id: 'b', type: 'checkpoint', goal: 'realistic', family: 'sd15' },
    { id: 'c', type: 'checkpoint', goal: 'edit-photos', family: 'sd15' },
    { id: 'd', type: 'lora', goal: 'faces-skin', family: 'sd15' },
    { id: 'e', type: 'checkpoint', goal: 'anime', family: 'sdxl' },
  ];
  assert.deepEqual(g.pickWelcome(entries, 'SD 1.5').map((e) => e.id), ['b', 'c', 'e']);
  assert.deepEqual(g.pickWelcome(entries, 'SDXL').map((e) => e.id), ['a', 'c', 'e']);
});

test('downloadWarning flags a GPU misfit or a family nobody installed can use', () => {
  assert.equal(g.downloadWarning({ type: 'checkpoint', fit: { level: 'good' } }, { checkpointFamilies: [] }), '');
  assert.match(g.downloadWarning({ type: 'checkpoint', fit: { level: 'no', reason: 'needs 12 GB' } }, {}), /too big for your GPU \(needs 12 GB\)/);
  const lora = { type: 'LORA', baseModel: 'SDXL 1.0' };
  assert.match(g.downloadWarning(lora, { checkpointFamilies: ['sd15'] }), /SDXL checkpoints/);
  assert.equal(g.downloadWarning(lora, { checkpointFamilies: ['sd15', 'sdxl'] }), '');
  assert.equal(g.downloadWarning(lora, { checkpointFamilies: [] }), '');
  assert.equal(g.downloadWarning({ type: 'lora', baseModel: 'Pony' }, { checkpointFamilies: ['sdxl'] }), '');
  assert.equal(g.downloadWarning({ type: 'lora', baseModel: '' }, { checkpointFamilies: ['sd15'] }), '');
});

test('whatItIs describes the model type and what it works with', () => {
  assert.match(g.whatItIs({ type: 'lora', baseModel: 'SD 1.5' }), /Use with SD 1\.5 checkpoints/);
  assert.match(g.whatItIs({ type: 'checkpoint', baseModel: 'SDXL 1.0', name: 'X Inpainting' }), /Inpainting checkpoint \(SDXL\)/);
  assert.match(g.whatItIs({ type: 'lora', baseModel: null }), /Check its page/);
  assert.equal(g.whatItIs({ type: 'controlnet' }), '');
});
