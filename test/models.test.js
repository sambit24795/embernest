'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  planModels, missingModels, installModels, authHeadersFor, isHuggingFaceUrl, modelPath,
} = require('../src/install/models');
const { getManifest } = require('../src/install/manifest');
const { getPaths } = require('../src/core/paths');

const BODY = crypto.randomBytes(64 * 1024);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');

/** Local server that serves BODY and records the Authorization header of each request. */
function serve() {
  const state = { requests: 0, auth: [] };
  const server = http.createServer((req, res) => {
    state.requests++;
    state.auth.push(req.headers.authorization || null);
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.end(BODY);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    state.server = server;
    state.url = `http://127.0.0.1:${server.address().port}`;
    resolve(state);
  }));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pk-models-'));

/** A model entry pointing at the local server, in the same shape as the manifest. */
function entry(base, { id = 'm1', folder = 'checkpoints', file = 'm1.safetensors', mirrors = [] } = {}) {
  return { id, folder, file, url: `${base}/${file}`, mirrors, sha256: SHA, sizeMB: 1 };
}

test('planModels for low: 2 required + 1 starter', () => {
  const manifest = getManifest();
  const plan = planModels(manifest, 'low');
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((m) => m.id), ['birefnet', 'mediapipe-face', 'sd15-inpaint']);
});

test('planModels with includeStarter false returns only required models', () => {
  const plan = planModels(getManifest(), 'mid', { includeStarter: false });
  assert.deepEqual(plan.map((m) => m.id), ['birefnet', 'mediapipe-face']);
});

test('planModels for mid adds both starter models', () => {
  const plan = planModels(getManifest(), 'mid');
  assert.deepEqual(plan.map((m) => m.id), ['birefnet', 'mediapipe-face', 'sd15-inpaint', 'sdxl-general']);
});

test('planModels rejects an unknown tier', () => {
  assert.throws(() => planModels(getManifest(), 'nope'), /no starter models for tier "nope"/);
});

test('missingModels skips files that are already present', async () => {
  const paths = getPaths(tmp());
  const entries = [entry('http://x', { file: 'a.safetensors' }), entry('http://x', { id: 'b', file: 'b.safetensors' })];
  fs.mkdirSync(path.join(paths.models, 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(paths.models, 'checkpoints', 'a.safetensors'), 'x');
  const missing = await missingModels(paths, entries);
  assert.deepEqual(missing.map((m) => m.id), ['b']);
});

test('missingModels honours an external modelsDir', async () => {
  const paths = getPaths(tmp());
  const comfyModels = tmp();
  const entries = [entry('http://x')];
  fs.mkdirSync(path.join(comfyModels, 'checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(comfyModels, 'checkpoints', 'm1.safetensors'), 'x');
  assert.deepEqual(await missingModels(paths, entries, { modelsDir: comfyModels }), []);
  assert.equal((await missingModels(paths, entries)).length, 1);
});

test('installModels downloads each entry into models/<folder>/<file>', async () => {
  const s = await serve();
  const paths = getPaths(tmp());
  const entries = [entry(s.url, { id: 'a', file: 'a.safetensors' }), entry(s.url, { id: 'b', folder: 'loras', file: 'b.safetensors' })];
  const seen = [];
  try {
    await installModels(paths, entries, { onProgress: (e) => seen.push(e.id) });
    assert.ok(fs.readFileSync(modelPath(paths.models, entries[0])).equals(BODY));
    assert.ok(fs.readFileSync(path.join(paths.models, 'loras', 'b.safetensors')).equals(BODY));
    assert.equal(s.requests, 2);
    assert.ok(seen.includes('a') && seen.includes('b'));
  } finally {
    s.server.close();
  }
});

test('installModels is a no-op for files already present with the right sha256', async () => {
  const s = await serve();
  const paths = getPaths(tmp());
  const e = entry(s.url);
  try {
    await installModels(paths, [e]);
    await installModels(paths, [e]);
    assert.equal(s.requests, 1);
  } finally {
    s.server.close();
  }
});

test('installModels honours modelsDir for external ComfyUI', async () => {
  const s = await serve();
  const paths = getPaths(tmp());
  const comfyModels = tmp();
  try {
    await installModels(paths, [entry(s.url)], { modelsDir: comfyModels });
    assert.ok(fs.existsSync(path.join(comfyModels, 'checkpoints', 'm1.safetensors')));
    assert.ok(!fs.existsSync(path.join(paths.models, 'checkpoints', 'm1.safetensors')));
  } finally {
    s.server.close();
  }
});

test('installModels does not send the HF token to a non-HF local server', async () => {
  const s = await serve();
  const paths = getPaths(tmp());
  try {
    await installModels(paths, [entry(s.url)], { hfToken: 'hf_secret' });
    assert.deepEqual(s.auth, [null]);
  } finally {
    s.server.close();
  }
});

test('authHeadersFor adds Bearer only for huggingface.co and its subdomains', () => {
  assert.deepEqual(authHeadersFor('https://huggingface.co/a/b', 'tok'), { Authorization: 'Bearer tok' });
  assert.deepEqual(authHeadersFor('https://cdn-lfs.huggingface.co/x', 'tok'), { Authorization: 'Bearer tok' });
  assert.deepEqual(authHeadersFor('https://example.com/huggingface.co/x', 'tok'), {});
  assert.deepEqual(authHeadersFor('https://huggingface.co.evil.test/x', 'tok'), {});
  assert.deepEqual(authHeadersFor('https://github.com/x', 'tok'), {});
  assert.deepEqual(authHeadersFor('https://huggingface.co/x', null), {});
  assert.equal(isHuggingFaceUrl('not a url'), false);
});
