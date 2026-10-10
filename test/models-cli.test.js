'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const downloads = require('../src/server/downloads');
const { localModelsDir, getPaths } = require('../src/core/paths');
const models = require('../src/cli/commands/models');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pk-models-cli-'));
const BODY = crypto.randomBytes(4096);

/** Local HTTP server that serves BODY at any path and records Authorization headers. */
function serve() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization || null);
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.end(BODY);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` });
  }));
}

test('listInstalled reads a { modelsDir } source into the matching folders', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'checkpoints'));
  fs.mkdirSync(path.join(dir, 'loras'));
  fs.writeFileSync(path.join(dir, 'checkpoints', 'b.safetensors'), 'xx');
  fs.writeFileSync(path.join(dir, 'checkpoints', 'a.safetensors'), '');
  fs.writeFileSync(path.join(dir, 'checkpoints', 'put_x.safetensors'), 'skip');
  fs.writeFileSync(path.join(dir, 'loras', 'l.safetensors'), 'x');
  const installed = await downloads.listInstalled({ modelsDir: dir });
  assert.deepEqual(installed.checkpoints.map((f) => f.name), ['a.safetensors', 'b.safetensors']);
  assert.deepEqual(installed.loras.map((f) => f.name), ['l.safetensors']);
  assert.deepEqual(installed.vae, []);
  assert.equal(await downloads.getModelFolderPath({ modelsDir: dir }, 'loras'), path.join(dir, 'loras'));
  assert.equal(await downloads.getModelFolderPath({ modelsDir: dir }, 'nope'), null);
});

test('listInstalled still accepts a ComfyUI-style client', async () => {
  const client = {
    listModelFolders: async () => [{ name: 'vae', folders: ['/x/vae'], extensions: [] }],
  };
  assert.equal(await downloads.getModelFolderPath(client, 'vae'), '/x/vae');
  assert.equal(await downloads.getModelFolderPath(client, 'loras'), null);
});

test('isPlainFileName rejects traversal and separators', () => {
  assert.equal(downloads.isPlainFileName('model.safetensors'), true);
  for (const bad of ['', '.', '..', '../x.safetensors', 'a/b', 'a\\b', '..\\x', '/abs']) {
    assert.equal(downloads.isPlainFileName(bad), false, bad);
  }
});

test('models rm target parsing rejects ../ and separators', () => {
  const ok = models.parseModelTarget('checkpoints/model.safetensors');
  assert.deepEqual(ok, { folder: 'checkpoints', file: 'model.safetensors' });
  for (const bad of [
    '../model.safetensors', 'checkpoints/../x', 'checkpoints/a/b', 'checkpoints\\..\\x',
    'checkpoints/a\\b', 'nope/model.safetensors', 'checkpoints', '',
  ]) {
    assert.throws(() => models.parseModelTarget(bad), undefined, bad);
  }
});

test('models rm resolves only files inside the models folder', () => {
  const paths = getPaths(tmp());
  const cfg = { comfy: { mode: 'managed', dir: '' }, tokens: {} };
  const full = models.modelPathFor({ paths, cfg, target: 'loras/x.safetensors' });
  assert.equal(full, path.join(paths.models, 'loras', 'x.safetensors'));
  assert.throws(() => models.modelPathFor({ paths, cfg, target: 'checkpoints/../../config.json' }), /Invalid model file name/);
});

test('localModelsDir: managed uses paths.models, external uses <comfy.dir>/models', () => {
  const paths = getPaths(tmp());
  assert.equal(localModelsDir(paths, { comfy: { mode: 'managed', dir: '/x' } }), paths.models);
  assert.equal(localModelsDir(paths, { comfy: { mode: 'external', dir: '/opt/ComfyUI' } }), path.join('/opt/ComfyUI', 'models'));
  assert.equal(localModelsDir(paths, { comfy: { mode: 'external', dir: '' } }), null);
});

test('models pull downloads into the folder for its type', async () => {
  const { server, base, seen } = await serve();
  try {
    const paths = getPaths(tmp());
    const cfg = { comfy: { mode: 'managed', dir: '' }, tokens: {} };
    const { dest, existed } = await models.pullModel({
      paths, cfg, url: `${base}/files/Some%20Lora.safetensors?download=1`, type: 'lora',
    });
    assert.equal(existed, false);
    assert.equal(dest, path.join(paths.models, 'loras', 'Some Lora.safetensors'));
    assert.deepEqual(fs.readFileSync(dest), BODY);

    const again = await models.pullModel({ paths, cfg, url: `${base}/x.safetensors`, type: 'lora', name: 'Some Lora.safetensors' });
    assert.equal(again.existed, true);
    assert.equal(seen.length, 1, 'existing file is not downloaded again');
  } finally {
    server.close();
  }
});

test('models pull sends a provider token only to its own host', async () => {
  const { server, base, seen } = await serve();
  try {
    const paths = getPaths(tmp());
    const cfg = { comfy: { mode: 'managed', dir: '' }, tokens: { hf: 'HFSECRET', civitai: 'CIVSECRET' } };
    await models.pullModel({ paths, cfg, url: `${base}/a.safetensors`, type: 'checkpoint' });
    assert.deepEqual(seen, [null], 'a 127.0.0.1 URL gets no token');
    assert.deepEqual(models.tokenHeadersFor('https://huggingface.co/x', cfg.tokens), { Authorization: 'Bearer HFSECRET' });
    assert.deepEqual(models.tokenHeadersFor('https://civitai.com/api/x', cfg.tokens), { Authorization: 'Bearer CIVSECRET' });
    assert.deepEqual(models.tokenHeadersFor('https://evil.example/x', cfg.tokens), {});
  } finally {
    server.close();
  }
});

test('models pull rejects unknown types, bad URLs and unsafe names', async () => {
  const paths = getPaths(tmp());
  const cfg = { comfy: { mode: 'managed', dir: '' }, tokens: {} };
  await assert.rejects(models.pullModel({ paths, cfg, url: 'http://127.0.0.1/a', type: 'nope' }), /Unknown --type/);
  await assert.rejects(models.pullModel({ paths, cfg, url: 'ftp://x/a.safetensors', type: 'lora' }), /http/);
  await assert.rejects(models.pullModel({ paths, cfg, url: 'not a url', type: 'lora' }), /Not a valid URL/);
  await assert.rejects(models.pullModel({ paths, cfg, url: 'http://127.0.0.1/a.safetensors', type: 'lora', name: '../evil' }), /file name/);
});
