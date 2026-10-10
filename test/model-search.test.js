'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_NAMES, civitaiThumbUrl, pickCivitaiPreview, placeholderSpec, normalizeCivitai, normalizeHF, searchModels,
} = require('../src/server/models');

const BASE = 'https://image.civitai.com/KEY/uuid-1';

test('providers are civitai and huggingface only', () => {
  assert.deepEqual(PROVIDER_NAMES, ['civitai', 'huggingface']);
});

test('searching a removed provider is an error', async () => {
  await assert.rejects(searchModels({ provider: 'modelscope' }), /Unknown provider/);
  await assert.rejects(searchModels({ provider: 'github' }), /Unknown provider/);
});

test('civitaiThumbUrl rewrites original=true and width=N segments', () => {
  assert.equal(civitaiThumbUrl(`${BASE}/original=true/1.jpeg`), `${BASE}/width=450/1.jpeg`);
  assert.equal(civitaiThumbUrl(`${BASE}/width=1024/1.jpeg`), `${BASE}/width=450/1.jpeg`);
  assert.equal(civitaiThumbUrl(`${BASE}/anim=false,width=2000/1.jpeg`), `${BASE}/width=450/1.jpeg`);
  assert.equal(civitaiThumbUrl(`${BASE}/original=true/1.mp4`, { still: true }), `${BASE}/anim=false,width=450/1.mp4`);
  assert.equal(civitaiThumbUrl(`${BASE}/original=true/1.jpeg`, { width: 200 }), `${BASE}/width=200/1.jpeg`);
});

test('civitaiThumbUrl leaves other hosts and shapes alone', () => {
  assert.equal(civitaiThumbUrl('https://example.com/original=true/a.jpg'), 'https://example.com/original=true/a.jpg');
  assert.equal(civitaiThumbUrl(`${BASE}/plain/1.jpeg`), `${BASE}/plain/1.jpeg`);
  assert.equal(civitaiThumbUrl('not a url'), 'not a url');
});

test('pickCivitaiPreview prefers the first image over an earlier video', () => {
  const p = pickCivitaiPreview([
    { url: `${BASE}/original=true/1.mp4`, type: 'video' },
    { url: `${BASE}/original=true/2.jpeg`, type: 'image' },
  ]);
  assert.deepEqual(p, { url: `${BASE}/width=450/2.jpeg`, type: 'image', poster: null });
});

test('pickCivitaiPreview falls back to a video with a still poster, or null', () => {
  const p = pickCivitaiPreview([{ url: `${BASE}/original=true/1.mp4` }]);
  assert.equal(p.type, 'video');
  assert.equal(p.url, `${BASE}/width=450/1.mp4`);
  assert.equal(p.poster, `${BASE}/anim=false,width=450/1.mp4`);
  assert.equal(pickCivitaiPreview([]), null);
  assert.equal(pickCivitaiPreview(undefined), null);
});

test('placeholderSpec is deterministic and varies by id', () => {
  assert.deepEqual(placeholderSpec('civitai:1'), placeholderSpec('civitai:1'));
  assert.notDeepEqual(placeholderSpec('civitai:1'), placeholderSpec('civitai:2'));
  const { hue, hue2 } = placeholderSpec('huggingface:a/b');
  assert.ok(hue >= 0 && hue < 360 && hue2 >= 0 && hue2 < 360);
});

test('normalizeCivitai uses the small image preview; normalizeHF gets a placeholder', () => {
  const c = normalizeCivitai({
    id: 7, name: 'M', type: 'LORA',
    modelVersions: [{ id: 1, files: [], images: [
      { url: `${BASE}/original=true/a.mp4`, type: 'video' },
      { url: `${BASE}/original=true/b.jpeg`, type: 'image' },
    ] }],
  });
  assert.equal(c.thumbnail, `${BASE}/width=450/b.jpeg`);
  assert.equal(c.thumbnailType, 'image');
  const h = normalizeHF({ id: 'a/b', tags: [] }, null);
  assert.equal(h.thumbnail, null);
  assert.deepEqual(h.placeholder, placeholderSpec('huggingface:a/b'));
});
