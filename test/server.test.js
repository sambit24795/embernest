'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getPaths } = require('../src/core/paths');
const { saveConfig, loadConfig } = require('../src/core/config');
const { createApp } = require('../src/server/app');
const version = require('../src/version');
const { startFakeComfy, PNG_1X1 } = require('./helpers/fake-comfy');
const { SafetyUnavailableError } = require('../src/server/safety');
const { discardOutputs } = require('../src/server/jobs');

/** Fallback hardware in the detectHardware() shape (6 GB NVIDIA). */
const HARDWARE = {
  os: 'linux', distro: 'Test', arch: 'x64',
  cpu: { model: 'Test CPU', cores: 8 }, ramGB: 16, freeDiskGB: 100,
  gpu: { vendor: 'nvidia', name: 'Fake GPU', vramGB: 6, driver: '', cudaVersion: '12.8', computeCap: '7.5' },
  source: [],
};
/** Config hardware for the recommend checks: a 6 GB NVIDIA card. */
const CONFIG_HW = { ...HARDWARE, gpu: { ...HARDWARE.gpu, name: 'Fake 6GB NVIDIA' } };

/** Safety stub: never blocks (the real worker needs Python and a model). */
const PASS = { check: async () => ({ nsfwScore: 0, blocked: false }), close() {} };

async function setup(t, { supervisor = null, safety = PASS, home: givenHome = null } = {}) {
  const home = givenHome || fs.mkdtempSync(path.join(os.tmpdir(), 'embernest-home-'));
  const paths = getPaths(home);
  const fake = await startFakeComfy({ outputDir: paths.output });
  saveConfig(paths, {
    authToken: 'secret-auth-token',
    comfy: { url: fake.url },
    tokens: { civitai: 'secret-civitai-token' },
  });
  const server = createApp({ paths, supervisor, hardware: HARDWARE, safety }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fake.close();
    if (!givenHome) fs.rmSync(home, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, fake, paths, home };
}

async function waitDone(base, id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { job } = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (['done', 'error', 'blocked'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish in 5s');
}

test('GET /api/health', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/health`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, name: 'embernest', version });
});

test('GET /api/recommend uses config.hardware and honours ?vramGB=', async (t) => {
  const { base, paths } = await setup(t);
  saveConfig(paths, { hardware: CONFIG_HW });
  const rec = await (await fetch(`${base}/api/recommend`)).json();
  assert.strictEqual(rec.recommendation.maxSize, 768);
  assert.strictEqual(rec.specs.gpu, 'Fake 6GB NVIDIA');
  assert.strictEqual(rec.specs.vramGB, 6);
  const big = await (await fetch(`${base}/api/recommend?vramGB=12`)).json();
  assert.strictEqual(big.recommendation.maxSize, 1024);
  assert.strictEqual(big.specs.vramGB, 12);
});

test('GET /api/specs returns flat UI fields and the hardware detail', async (t) => {
  const { base } = await setup(t);
  const specs = await (await fetch(`${base}/api/specs`)).json();
  assert.strictEqual(specs.gpu, 'Fake GPU');
  assert.strictEqual(specs.vramGB, 6);
  assert.strictEqual(specs.ramGB, 16);
  assert.strictEqual(specs.os, 'linux');
  assert.strictEqual(specs.gpuDetail.vendor, 'nvidia');
});

test('GET /api/status lists checkpoints from ComfyUI', async (t) => {
  const { base } = await setup(t);
  const body = await (await fetch(`${base}/api/status`)).json();
  assert.strictEqual(body.online, true);
  assert.deepStrictEqual(body.checkpoints, ['a.safetensors']);
});

test('GET /api/config never exposes secrets', async (t) => {
  const { base } = await setup(t);
  const text = await (await fetch(`${base}/api/config`)).text();
  const body = JSON.parse(text);
  assert.ok(!('authToken' in body));
  assert.ok(!text.includes('secret-auth-token'));
  assert.ok(!text.includes('secret-civitai-token'));
  assert.strictEqual(body.tokensSet.civitai, true);
  assert.strictEqual(body.comfyMode, 'managed');
});

test('PUT /api/config saves allowed fields only', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: 4000, comfyUrl: 'http://evil', tokens: { hf: 'x' } }),
  });
  const body = await res.json();
  assert.strictEqual(body.restartRequired, true);
  assert.strictEqual(body.config.port, 4000);
  assert.notStrictEqual(body.config.comfyUrl, 'http://evil');
  assert.strictEqual(body.config.tokensSet.hf, true);
});

test('PUT /api/config accepts an http(s) or empty SearXNG URL and rejects others', async (t) => {
  const { base, paths } = await setup(t);
  const put = (chat) => fetch(`${base}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat: { search: { searxngUrl: chat } } }),
  });
  let res = await put('https://search.example/');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).config.chat.search.searxngUrl, 'https://search.example/');
  res = await put('');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).config.chat.search.searxngUrl, '');
  res = await put('javascript:x');
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /searxngUrl/);
  assert.strictEqual(loadConfig(paths).chat.search.searxngUrl, '');
});

test('POST /api/generate runs to done', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'x', checkpoint: 'a.safetensors' }),
  });
  assert.strictEqual(res.status, 202);
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'done');
  assert.ok(job.images.length >= 1);

  const img = await fetch(`${base}${job.images[0].url}`);
  assert.strictEqual(img.status, 200);
  assert.deepStrictEqual(Buffer.from(await img.arrayBuffer()), PNG_1X1);
});

test('POST /api/edit with an uploaded PNG runs to done', async (t) => {
  const { base } = await setup(t);
  const form = new FormData();
  form.append('image', new Blob([PNG_1X1], { type: 'image/png' }), 'in.png');
  const res = await fetch(`${base}/api/edit`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 202);
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'done');
});

test('POST /api/edit without an image is 400', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/edit`, { method: 'POST', body: new FormData() });
  assert.strictEqual(res.status, 400);
});

test('GET /api/queue and /api/history respond', async (t) => {
  const { base } = await setup(t);
  const q = await (await fetch(`${base}/api/queue`)).json();
  assert.ok(Array.isArray(q.running) && Array.isArray(q.pending));
  const h = await (await fetch(`${base}/api/history`)).json();
  assert.ok(Array.isArray(h.items));
});

test('POST /api/comfy/restart without a supervisor is 400', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/comfy/restart`, { method: 'POST' });
  assert.strictEqual(res.status, 400);
});

test('POST /api/comfy/restart with a supervisor restarts', async (t) => {
  let restarted = 0;
  const { base } = await setup(t, { supervisor: { restart: async () => { restarted += 1; } } });
  const res = await fetch(`${base}/api/comfy/restart`, { method: 'POST' });
  assert.deepStrictEqual(await res.json(), { restarted: true });
  assert.strictEqual(restarted, 1);
});

test('merge routes need the ComfyUI Python path', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/api/models/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ckptA: 'a.safetensors', ckptB: 'a.safetensors' }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /Merging needs the ComfyUI Python path/);
});

test('static files are served with no-cache', async (t) => {
  const { base } = await setup(t);
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'no-cache');
});

const editForm = () => {
  const form = new FormData();
  form.append('image', new Blob([PNG_1X1], { type: 'image/png' }), 'in.png');
  return form;
};
const BLOCKING = { check: async () => ({ nsfwScore: 0.99, blocked: true }), close() {} };
const BROKEN = { check: async () => { throw new SafetyUnavailableError('worker is down'); }, close() {} };

test('a blocked edit ends blocked, with no images, and the history entry is deleted', async (t) => {
  const { base, fake } = await setup(t, { safety: BLOCKING });
  const res = await fetch(`${base}/api/edit`, { method: 'POST', body: editForm() });
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'blocked');
  assert.deepStrictEqual(job.images, []);
  assert.strictEqual(job.after, null);
  assert.strictEqual(job.error, "Blocked: edits of uploaded photos can't produce nudity.");
  assert.ok(fake.calls.includes('POST /history'));
  const hist = await (await fetch(`${base}/api/history`)).json();
  assert.deepStrictEqual(hist.items, []);
});

test('a blocked transform ends blocked', async (t) => {
  const { base } = await setup(t, { safety: BLOCKING });
  const res = await fetch(`${base}/api/transform`, { method: 'POST', body: editForm() });
  assert.strictEqual(res.status, 202);
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'blocked');
});

test('generate is never checked, even when the safety stub blocks', async (t) => {
  let calls = 0;
  const safety = { check: async () => { calls += 1; return { nsfwScore: 1, blocked: true }; }, close() {} };
  const { base } = await setup(t, { safety });
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }),
  });
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'done');
  assert.ok(job.images.length >= 1);
  assert.strictEqual(calls, 0);
});

test('an unavailable safety check ends in error and deletes the outputs', async (t) => {
  const { base, fake } = await setup(t, { safety: BROKEN });
  const res = await fetch(`${base}/api/edit`, { method: 'POST', body: editForm() });
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'error');
  assert.deepStrictEqual(job.images, []);
  assert.strictEqual(job.error, 'Safety check unavailable — run embernest doctor');
  assert.ok(fake.calls.includes('POST /history'));
});

test('a blocked job ends the SSE stream with the final update', async (t) => {
  const { base } = await setup(t, { safety: BLOCKING });
  const { job } = await (await fetch(`${base}/api/edit`, { method: 'POST', body: editForm() })).json();
  const text = await (await fetch(`${base}/api/jobs/${job.id}/events`)).text(); // ends when the job is terminal
  const last = JSON.parse(text.trim().split('\n\n').pop().replace(/^data: /, ''));
  assert.strictEqual(last.status, 'blocked');
});

test('discardOutputs deletes output files but never outside the output folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-out-'));
  const outside = path.join(path.dirname(root), `pk-outside-${path.basename(root)}.png`);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'keep.png'), 'x');
  fs.writeFileSync(outside, 'x');
  const deleted = [];
  const client = { deleteHistoryItems: async (ids) => deleted.push(...ids) };
  await discardOutputs(client, 'p1', [
    { filename: 'a.png', subfolder: 'sub', type: 'output' },
    { filename: path.relative(root, outside), subfolder: '', type: 'output' },
    { filename: 'keep.png', subfolder: '', type: 'temp' },
  ], root);
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'a.png')));
  assert.ok(fs.existsSync(outside));
  assert.ok(fs.existsSync(path.join(root, 'keep.png')));
  assert.deepStrictEqual(deleted, ['p1']);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test('while an edit is being checked, its result is hidden from history and /api/image', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let checking = false;
  const SLOW = { check: async () => { checking = true; await gate; return { nsfwScore: 0, blocked: false }; }, close() {} };
  const { base, fake } = await setup(t, { safety: SLOW });
  const res = await fetch(`${base}/api/edit`, { method: 'POST', body: editForm() });
  const { id } = (await res.json()).job;
  for (let i = 0; i < 200 && !checking; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(checking, 'safety check started');

  const raw = await (await fetch(`${fake.url}/history`)).json();
  const out = Object.values(raw).flatMap((e) => Object.values(e.outputs || {}).flatMap((o) => o.images || []));
  assert.ok(out.length, 'fake ComfyUI has an output image');
  const img = out[out.length - 1];
  const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: 'output' });
  assert.strictEqual((await fetch(`${base}/api/image?${qs}`)).status, 404);
  const during = await (await fetch(`${base}/api/history`)).json();
  assert.deepStrictEqual(during.items, []);
  const live = await (await fetch(`${base}/api/jobs/${id}`)).json();
  assert.strictEqual(JSON.stringify(live).includes(img.filename), false, 'job view does not leak the filename');

  release();
  const job = await waitDone(base, id);
  assert.strictEqual(job.status, 'done');
  assert.strictEqual((await fetch(`${base}/api/image?${qs}`)).status, 200);
});

// ---- /api/history: paging, mode, prompt extraction ----

const { modeFromFilename, extractFromGraph } = require('../src/server/historyMeta');

async function generate(base, prompt) {
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, steps: 7, seed: 42, width: 512, height: 640 }),
  });
  return waitDone(base, (await res.json()).job.id);
}

test('modeFromFilename maps output prefixes', () => {
  assert.strictEqual(modeFromFilename('embernest_gen_abc_00001_.png'), 'generate');
  assert.strictEqual(modeFromFilename('pixelkiln_gen_abc_00001_.png'), 'generate');
  assert.strictEqual(modeFromFilename('embernest_tf_abc_00001_.png'), 'transform');
  assert.strictEqual(modeFromFilename('embernest_lq3k_00001_.png'), 'edit');
  assert.strictEqual(modeFromFilename('pixelkiln_00001_.png'), 'edit');
  assert.strictEqual(modeFromFilename('ComfyUI_00001_.png'), null);
  assert.strictEqual(modeFromFilename(undefined), null);
});

test('extractFromGraph reads prompt, settings and the before image', () => {
  const graph = {
    1: { class_type: 'LoadImage', inputs: { image: 'embernest/in 1.png' } },
    2: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    3: { class_type: 'LoraLoader', inputs: { lora_name: 'l.safetensors', strength_model: 0.7 } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'neg words', clip: ['2', 1] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'a red fox', clip: ['2', 1] } },
    6: { class_type: 'KSampler', inputs: { seed: 9, steps: 12, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6, positive: ['5', 0], negative: ['4', 0] } },
    7: { class_type: 'ImageScale', _meta: { title: 'Restore to 800x600' }, inputs: { width: 800, height: 600 } },
  };
  const m = extractFromGraph(graph);
  assert.strictEqual(m.prompt, 'a red fox');
  assert.deepStrictEqual(m.before, { filename: 'in 1.png', subfolder: 'embernest' });
  assert.strictEqual(m.settings.negative, 'neg words');
  assert.strictEqual(m.settings.checkpoint, 'm.safetensors');
  assert.strictEqual(m.settings.lora, 'l.safetensors');
  assert.strictEqual(m.settings.seed, 9);
  assert.strictEqual(m.settings.width, 800);
  assert.deepStrictEqual(extractFromGraph({}).settings.seed, null);
});

test('GET /api/history pages newest first and reports mode and prompt', async (t) => {
  const { base } = await setup(t);
  for (const p of ['one', 'two', 'three']) await generate(base, p);
  const all = await (await fetch(`${base}/api/history?limit=2`)).json();
  assert.strictEqual(all.items.length, 2);
  assert.strictEqual(all.total, 3);
  assert.strictEqual(all.hasMore, true);
  assert.strictEqual(all.items[0].prompt, 'three');
  assert.strictEqual(all.items[0].mode, 'generate');
  assert.strictEqual(all.items[0].settings.seed, 42);
  assert.strictEqual(all.items[0].settings.width, 512);
  assert.strictEqual(all.items[0].settings.height, 640);
  assert.ok(all.items[0].createdAt > 0);
  assert.strictEqual(all.items[0].before, null);
  const rest = await (await fetch(`${base}/api/history?limit=2&offset=2`)).json();
  assert.deepStrictEqual(rest.items.map((i) => i.prompt), ['one']);
  assert.strictEqual(rest.hasMore, false);
  const none = await (await fetch(`${base}/api/history?mode=edit`)).json();
  assert.deepStrictEqual(none.items, []);
});

test('history reports transform mode with a before image, and hides held edits', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let checking = false;
  const SLOW = { check: async () => { checking = true; await gate; return { nsfwScore: 0, blocked: false }; }, close() {} };
  const { base } = await setup(t, { safety: SLOW });
  const res = await fetch(`${base}/api/transform`, { method: 'POST', body: editForm() });
  const { id } = (await res.json()).job;
  for (let i = 0; i < 200 && !checking; i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepStrictEqual((await (await fetch(`${base}/api/history`)).json()).items, [], 'held while checking');
  release();
  await waitDone(base, id);
  const h = await (await fetch(`${base}/api/history?mode=transform`)).json();
  assert.strictEqual(h.items.length, 1);
  assert.strictEqual(h.items[0].mode, 'transform');
  assert.match(h.items[0].before, /^\/api\/image\?.*type=input/);
});

test('cancelling a queued job does not interrupt the job ComfyUI is running', async () => {
  const jobsMod = require('../src/server/jobs');
  const calls = [];
  const client = {
    queuePrompt: () => new Promise(() => {}), // never starts
    interrupt: async () => { calls.push('interrupt'); },
    deleteFromQueue: async () => { calls.push('delete'); },
  };
  const queued = jobsMod.startJob({ kind: 'generate', client, buildWorkflow: () => ({}) });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual((await jobsMod.cancelJob(queued.id, client)).status, 'cancelled');
  assert.ok(!calls.includes('interrupt'));
});

// ---- persistent gallery ----

const zlibMod = require('node:zlib');
const pngChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
};
const pngWithPrompt = (graph) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', Buffer.alloc(13)),
  pngChunk('tEXt', Buffer.from(`prompt\0${JSON.stringify(graph)}`, 'latin1')),
  pngChunk('IDAT', zlibMod.deflateSync(Buffer.from('x'))),
  pngChunk('IEND', Buffer.alloc(0)),
]);
const listHistory = async (base, qs = '') => (await fetch(`${base}/api/history${qs}`)).json();
const readIndex = (paths) => JSON.parse(fs.readFileSync(path.join(paths.data, 'gallery.json'), 'utf8'));

test('a finished job is recorded in the gallery index (0600) and listed', async (t) => {
  const { base, paths } = await setup(t);
  const job = await generate(base, 'a recorded cat');
  const idx = readIndex(paths);
  assert.strictEqual(idx.items.length, 1);
  assert.strictEqual(idx.items[0].id, job.promptId);
  assert.strictEqual(idx.items[0].source, 'job');
  assert.strictEqual(idx.items[0].prompt, 'a recorded cat');
  assert.strictEqual(idx.items[0].mode, 'generate');
  assert.strictEqual(fs.statSync(path.join(paths.data, 'gallery.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(idx).includes('secret-'));
});

test('blocked and unavailable results are never indexed', async (t) => {
  for (const safety of [BLOCKING, BROKEN]) {
    const { base, paths } = await setup(t, { safety });
    const res = await fetch(`${base}/api/edit`, { method: 'POST', body: editForm() });
    await waitDone(base, (await res.json()).job.id);
    const file = path.join(paths.data, 'gallery.json');
    assert.ok(!fs.existsSync(file) || readIndex(paths).items.length === 0);
    assert.deepStrictEqual((await listHistory(base)).items, []);
  }
});

test('an approved edit is indexed only once done', async (t) => {
  const { base, paths } = await setup(t);
  const res = await fetch(`${base}/api/edit`, { method: 'POST', body: editForm() });
  const job = await waitDone(base, (await res.json()).job.id);
  assert.strictEqual(job.status, 'done');
  const idx = readIndex(paths);
  assert.strictEqual(idx.items.length, 1);
  assert.strictEqual(idx.items[0].mode, 'edit');
});

test('results already in ComfyUI history are imported into the index', async (t) => {
  const { base, fake, paths } = await setup(t);
  const workflow = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: 'from comfy' } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'embernest_gen_imp' } },
  };
  await fetch(`${fake.url}/prompt`, { method: 'POST', body: JSON.stringify({ client_id: 'x', prompt: workflow }) });
  let h;
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    h = await listHistory(base);
    if (h.items.length) break;
  }
  assert.strictEqual(h.items.length, 1);
  assert.strictEqual(h.items[0].prompt, 'from comfy');
  assert.strictEqual(readIndex(paths).items[0].source, 'import');
});

test('rescan adds orphan output files, recovering the prompt from the PNG', async (t) => {
  const { base, paths } = await setup(t);
  fs.mkdirSync(paths.output, { recursive: true });
  const graph = { 2: { class_type: 'CLIPTextEncode', inputs: { text: 'orphan dragon' } }, 3: { class_type: 'KSampler', inputs: { seed: 3, steps: 9, positive: ['2', 0] } } };
  fs.writeFileSync(path.join(paths.output, 'pixelkiln_gen_abc_00001_.png'), pngWithPrompt(graph));
  fs.writeFileSync(path.join(paths.output, 'embernest_tf_def_00001_.png'), PNG_1X1); // no prompt chunk
  fs.writeFileSync(path.join(paths.output, 'ComfyUI_00001_.png'), PNG_1X1); // not ours
  const r = await (await fetch(`${base}/api/history/rescan`, { method: 'POST' })).json();
  assert.strictEqual(r.added, 2);
  const h = await listHistory(base);
  assert.strictEqual(h.items.length, 2);
  const gen = h.items.find((i) => i.mode === 'generate');
  assert.strictEqual(gen.prompt, 'orphan dragon');
  assert.strictEqual(gen.settings.steps, 9);
  const tf = h.items.find((i) => i.mode === 'transform');
  assert.strictEqual(tf.prompt, null);
  assert.ok(tf.createdAt > 0);
  assert.strictEqual((await (await fetch(`${base}/api/history/rescan`, { method: 'POST' })).json()).added, 0);
});

test('DELETE removes the files and the index entry; files deleted elsewhere vanish lazily', async (t) => {
  const { base, paths } = await setup(t);
  const a = await generate(base, 'keep');
  const b = await generate(base, 'delete me');
  const c = await generate(base, 'vanish');
  const file = (job) => path.join(paths.output, job.images[0].filename);
  assert.ok(fs.existsSync(file(b)));
  const del = await (await fetch(`${base}/api/history/${b.promptId}`, { method: 'DELETE' })).json();
  assert.strictEqual(del.deleted.length, 1);
  assert.ok(!fs.existsSync(file(b)));
  assert.ok(!readIndex(paths).items.some((e) => e.id === b.promptId));

  fs.rmSync(file(c)); // deleted outside the app
  const h = await listHistory(base);
  assert.deepStrictEqual(h.items.map((i) => i.promptId), [a.promptId]);
  assert.strictEqual(h.total, 1);
  assert.deepStrictEqual(readIndex(paths).items.map((e) => e.id), [a.promptId]);
});

test('after an engine restart (empty ComfyUI history) earlier results are still listed and deletable', async (t) => {
  const first = await setup(t);
  const job = await generate(first.base, 'before restart');
  const second = await setup(t, { home: first.home }); // new app + new, empty fake ComfyUI
  assert.deepStrictEqual(Object.keys(await (await fetch(`${second.fake.url}/history`)).json()), []);
  const h = await listHistory(second.base);
  assert.strictEqual(h.items.length, 1);
  assert.strictEqual(h.items[0].promptId, job.promptId);
  assert.strictEqual(h.items[0].prompt, 'before restart');
  const del = await (await fetch(`${second.base}/api/history/${job.promptId}`, { method: 'DELETE' })).json();
  assert.strictEqual(del.deleted.length, 1);
  assert.deepStrictEqual((await listHistory(second.base)).items, []);
});
