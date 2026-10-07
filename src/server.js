/**
 * server.js — PixelKiln Express server.
 *
 * Milestones 1-3: system specs + recommendation, and the inpainting edit
 * endpoint that uploads an image to ComfyUI, runs the proven workflow, and
 * returns proxy URLs for before/after previews.
 */
'use strict';

const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const express = require('express');
const multer = require('multer');

const { loadConfig, saveConfig } = require('./config');
const { detectSystem, recommend } = require('./specs');
const { ComfyClient } = require('./comfy');
const { searchModels } = require('./models');
const downloads = require('./downloads');
const jobs = require('./jobs');
const { buildInpaintWorkflow, buildTxt2ImgWorkflow, buildImg2ImgWorkflow, clampSize } = require('./workflow');

const config = loadConfig();
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Uploaded images are forwarded straight to ComfyUI; hold them in memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

/** Fresh client each call so config.json edits are picked up without restart. */
function comfy() {
  return new ComfyClient(loadConfig().comfyUrl);
}

/** Parse a multipart/form-data value that should be a boolean. */
function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

/** Parse a numeric field, falling back when absent/invalid. */
function toNum(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Async sleep helper. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET /api/specs
 * Detects and returns OS, GPU model, VRAM (GB) and RAM (GB).
 */
app.get('/api/specs', async (req, res) => {
  try {
    res.json(await detectSystem());
  } catch (err) {
    res.status(500).json({ error: 'Failed to detect system specs', detail: err.message });
  }
});

/**
 * GET /api/recommend
 * Returns detected specs plus the VRAM-based recommendation.
 * Optional `?vramGB=` override is handy for testing the table.
 */
app.get('/api/recommend', async (req, res) => {
  try {
    const specs = await detectSystem();
    const override = Number.parseFloat(req.query.vramGB);
    const vramGB = Number.isFinite(override) ? override : specs.vramGB;
    res.json({ specs: { ...specs, vramGB }, recommendation: recommend({ vramGB }) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build recommendation', detail: err.message });
  }
});

/**
 * GET /api/config
 * Non-secret settings for the Settings tab. Tokens are never returned — only
 * a boolean telling the UI whether one is already saved.
 */
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    comfyUrl: cfg.comfyUrl,
    port: cfg.port,
    listenOnLan: cfg.listenOnLan,
    comfyRestartCommand: cfg.comfyRestartCommand || '',
    allowComfyRestart: Boolean(cfg.allowComfyRestart),
    defaults: cfg.defaults,
    tokensSet: Object.fromEntries(
      Object.entries(cfg.tokens || {}).map(([k, v]) => [k, Boolean(v)]),
    ),
  });
});

/**
 * PUT /api/config
 * Saves settings. Token fields only overwrite when a non-empty string is sent
 * (null clears one); leaving a field blank keeps the stored value.
 */
app.put('/api/config', (req, res) => {
  try {
    const body = req.body || {};
    const before = loadConfig();
    const patch = {};
    if (typeof body.comfyUrl === 'string' && body.comfyUrl.trim()) patch.comfyUrl = body.comfyUrl.trim();
    if (body.port != null) {
      const port = Math.round(Number(body.port));
      if (port > 0 && port < 65536) patch.port = port;
    }
    if (typeof body.listenOnLan === 'boolean') patch.listenOnLan = body.listenOnLan;
    if (typeof body.comfyRestartCommand === 'string') patch.comfyRestartCommand = body.comfyRestartCommand.trim();
    if (typeof body.allowComfyRestart === 'boolean') patch.allowComfyRestart = body.allowComfyRestart;
    if (body.defaults && typeof body.defaults === 'object') patch.defaults = body.defaults;
    if (body.tokens && typeof body.tokens === 'object') {
      const tokens = {};
      for (const [key, value] of Object.entries(body.tokens)) {
        if (typeof value === 'string' && value.length) tokens[key] = value;
        else if (value === null) tokens[key] = '';
      }
      if (Object.keys(tokens).length) patch.tokens = tokens;
    }

    const saved = saveConfig(patch);
    const restartRequired = saved.port !== before.port || saved.listenOnLan !== before.listenOnLan;
    res.json({
      ok: true,
      restartRequired,
      config: {
        comfyUrl: saved.comfyUrl,
        port: saved.port,
        listenOnLan: saved.listenOnLan,
        comfyRestartCommand: saved.comfyRestartCommand || '',
        allowComfyRestart: Boolean(saved.allowComfyRestart),
        defaults: saved.defaults,
        tokensSet: Object.fromEntries(
          Object.entries(saved.tokens || {}).map(([k, v]) => [k, Boolean(v)]),
        ),
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/network
 * URLs this app is reachable on — used by the Settings tab for phone access.
 */
app.get('/api/network', (req, res) => {
  const port = config.port || 3000;
  res.json({
    port,
    listenOnLan: config.listenOnLan,
    localUrl: `http://127.0.0.1:${port}`,
    lanUrls: config.listenOnLan
      ? getLanIps().map((ip) => ({ url: `http://${ip.address}:${port}`, iface: ip.iface }))
      : [],
  });
});

/**
 * GET /api/status
 * ComfyUI health + the model/sampler lists the UI needs. Never 500s: if
 * ComfyUI is down it returns { online: false, error } so the UI can warn.
 */
app.get('/api/status', async (req, res) => {
  const client = comfy();
  try {
    const [stats, checkpoints, bgRemovalModels, faceModels, samplers, schedulers] =
      await Promise.all([
        client.health(),
        client.listCheckpoints(),
        client.listBackgroundRemovalModels(),
        client.listFaceModels(),
        client.listSamplers(),
        client.listSchedulers(),
      ]);
    res.json({
      online: true,
      comfyUrl: client.baseUrl,
      version: stats.system && stats.system.comfyui_version,
      checkpoints,
      bgRemovalModels,
      faceModels,
      samplers,
      schedulers,
    });
  } catch (err) {
    res.json({ online: false, comfyUrl: client.baseUrl, error: err.message });
  }
});

/**
 * GET /api/models/search?provider=&query=&type=&baseModel=&nsfw=&sort=&limit=
 * Aggregates Civitai / HuggingFace / ModelScope / GitHub, normalizes each hit
 * and attaches a "fits your GPU" badge based on the detected VRAM.
 */
app.get('/api/models/search', async (req, res) => {
  try {
    const specs = await detectSystem();
    const recommendation = recommend(specs);
    const limit = Math.min(50, Math.max(1, Math.round(toNum(req.query.limit, 20))));
    const result = await searchModels({
      provider: req.query.provider || 'all',
      query: req.query.query || req.query.q || '',
      type: req.query.type || '',
      baseModel: req.query.baseModel || '',
      nsfw: toBool(req.query.nsfw, false),
      sort: req.query.sort || 'downloads',
      limit,
      period: req.query.period || '',
      task: req.query.task || '',
      tokens: loadConfig().tokens || {},
      system: { vramGB: specs.vramGB, ramGB: specs.ramGB },
    });
    res.json({
      query: { provider: req.query.provider || 'all', query: req.query.query || '', limit },
      system: { gpu: specs.gpu, vramGB: specs.vramGB, ramGB: specs.ramGB },
      recommendation,
      ...result,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/models/installed
 * Files already present in the ComfyUI models folders (from /experiment/models).
 */
app.get('/api/models/installed', async (req, res) => {
  try {
    res.json({ folders: await downloads.listInstalled(comfy()) });
  } catch (err) {
    res.status(502).json({ error: 'Could not list installed models', detail: err.message });
  }
});

/**
 * DELETE /api/models/installed/:folder/:name
 *
 * Delete one file from a ComfyUI models folder. `folder` must be one of the
 * known model folders; `name` must be a plain base name (no path separators,
 * no `.`/`..`). ComfyUI caches the file list at startup, so the response sets
 * `restartRequired: true` (gotcha in section 8).
 */
app.delete('/api/models/installed/:folder/:name', async (req, res) => {
  try {
    const folder = String(req.params.folder || '');
    const name = String(req.params.name || '');
    const allowed = new Set(Object.values(downloads.FOLDER_BY_TYPE));
    if (!allowed.has(folder)) {
      return res.status(400).json({ error: `Unsupported model folder "${folder}"`, allowed: [...allowed] });
    }

    // Path-traversal guard: only a plain base name is allowed.
    const base = path.basename(name);
    if (!name || name !== base || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      return res.status(400).json({ error: 'Invalid model file name' });
    }

    const dir = await downloads.getModelFolderPath(comfy(), folder);
    if (!dir) return res.status(404).json({ error: `ComfyUI has no "${folder}" models folder` });

    const root = path.resolve(dir) + path.sep;
    const full = path.resolve(dir, base);
    if (!full.startsWith(root)) return res.status(400).json({ error: 'Invalid model path' });

    try {
      await fsp.unlink(full);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: `File not found: ${folder}/${base}` });
      throw err;
    }

    res.json({ ok: true, deleted: `${folder}/${base}`, restartRequired: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not delete model', detail: err.message });
  }
});

/**
 * POST /api/models/download
 * Body: { downloadUrl, type, fileName, fileSizeMB, provider, folder? }
 * Starts a background download into the matching ComfyUI models folder.
 * Tokens come from config.json — never from the request body.
 */
app.post('/api/models/download', async (req, res) => {
  try {
    const { downloadUrl, type, fileName, fileSizeMB, provider, folder } = req.body || {};
    if (!downloadUrl) return res.status(400).json({ error: 'downloadUrl is required' });
    const tokens = loadConfig().tokens || {};
    const tokenKey = provider === 'huggingface' ? 'hf' : provider;
    const job = downloads.startDownload({
      client: comfy(),
      downloadUrl,
      type,
      fileName,
      fileSizeMB: Number(fileSizeMB) || 0,
      provider,
      folder,
      token: tokens[tokenKey] || '',
    });
    res.status(202).json({ job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** GET /api/models/downloads — all download jobs (newest first). */
app.get('/api/models/downloads', (req, res) => {
  res.json({ jobs: downloads.listJobs() });
});

/** GET /api/models/downloads/:id — one job's status (polling fallback). */
app.get('/api/models/downloads/:id', (req, res) => {
  const job = downloads.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown download job' });
  res.json({ job });
});

/**
 * GET /api/models/downloads/:id/events — Server-Sent Events progress stream.
 * Emits a `data: {job}` line every ~250ms and on every status change.
 */
app.get('/api/models/downloads/:id/events', (req, res) => {
  const job = downloads.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown download job' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const terminal = ['done', 'error', 'cancelled'];
  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  send(job);
  if (terminal.includes(job.status)) return res.end();

  const unsubscribe = downloads.subscribe(job.id, (snap) => {
    send(snap);
    if (terminal.includes(snap.status)) res.end();
  });
  req.on('close', () => { if (unsubscribe) unsubscribe(); });
});

/** DELETE /api/models/downloads/:id — cancel a job. */
app.delete('/api/models/downloads/:id', (req, res) => {
  const job = downloads.cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown download job' });
  res.json({ job });
});

/**
 * GET /api/image?filename=&subfolder=&type=
 * Proxy an image from ComfyUI through this server. ComfyUI binds to 127.0.0.1,
 * so a phone on the LAN cannot reach it directly.
 */
app.get('/api/image', async (req, res) => {
  const { filename, subfolder = '', type = 'output' } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename is required' });
  try {
    const { buffer, contentType } = await comfy().viewImage({ filename, subfolder, type });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch image from ComfyUI', detail: err.message });
  }
});

/**
 * POST /api/edit  (multipart/form-data)
 *
 * Field `image` (required) plus optional: positive, negative, checkpoint,
 * bgRemovalModel, faceModel, width, height, maxSize, preserveFace, restoreSize,
 * denoise, steps, cfg, sampler, scheduler, seed, growMask, faceExpand.
 *
 * Starts a background edit and returns 202 { job }. Progress streams from
 * /api/edit/jobs/:id/events (SSE); the finished job carries before/after URLs.
 */
app.post('/api/edit', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded (send a multipart field named "image")' });
    }
    const body = req.body || {};
    const client = comfy();

    // Resolve model names; fall back to the first installed option.
    const [checkpoints, bgModels, faceModels] = await Promise.all([
      client.listCheckpoints(),
      client.listBackgroundRemovalModels(),
      client.listFaceModels(),
    ]);
    const checkpoint = body.checkpoint || checkpoints[0];
    const bgRemovalModel = body.bgRemovalModel || bgModels[0];
    const faceModel = body.faceModel || faceModels[0] || null;

    if (!checkpoint) return res.status(409).json({ error: 'No checkpoint installed in ComfyUI/models/checkpoints' });
    if (!checkpoints.includes(checkpoint)) return res.status(400).json({ error: `Unknown checkpoint "${checkpoint}"`, checkpoints });
    if (!bgRemovalModel) return res.status(409).json({ error: 'No background-removal model installed in ComfyUI/models/background_removal' });
    if (!bgModels.includes(bgRemovalModel)) return res.status(400).json({ error: `Unknown background-removal model "${bgRemovalModel}"`, bgRemovalModels: bgModels });

    const defaults = loadConfig().defaults;
    const options = {
      checkpoint,
      bgRemovalModel,
      faceModel,
      positive: body.positive || '',
      negative: body.negative || 'blurry, low quality, worst quality, deformed body, extra limbs, bad anatomy, disfigured, watermark, text, logo',
      width: body.width ? Math.round(toNum(body.width, 0)) || undefined : undefined,
      height: body.height ? Math.round(toNum(body.height, 0)) || undefined : undefined,
      maxSize: Math.round(toNum(body.maxSize, defaults.maxSize)),
      preserveFace: toBool(body.preserveFace, defaults.preserveFace),
      restoreSize: toBool(body.restoreSize, defaults.restoreSize),
      denoise: toNum(body.denoise, defaults.denoise),
      steps: Math.round(toNum(body.steps, defaults.steps)),
      cfg: toNum(body.cfg, defaults.cfg),
      sampler: body.sampler || defaults.sampler,
      scheduler: body.scheduler || defaults.scheduler,
      seed: Math.round(toNum(body.seed, defaults.seed)),
      growMask: Math.round(toNum(body.growMask, 10)),
      faceExpand: Math.round(toNum(body.faceExpand, 40)),
      timeout: 900000,
    };

    const job = jobs.startJob({
      kind: 'edit',
      client,
      file: req.file,
      inputs: options,
      buildWorkflow: buildInpaintWorkflow,
    });
    res.status(202).json({ job });
  } catch (err) {
    res.status(502).json({ error: 'Could not start edit', detail: err.message });
  }
});

// ------------------------------ jobs (generic + edit aliases) ------------------------------

/** Shared SSE progress stream for any job (per-job client_id). */
function streamJobEvents(req, res, id) {
  const job = jobs.getJob(id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const terminal = ['done', 'error', 'cancelled'];
  const send = (snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`);
  send(job);
  if (terminal.includes(job.status)) return res.end();

  const unsubscribe = jobs.subscribe(job.id, (snap) => {
    send(snap);
    if (terminal.includes(snap.status)) res.end();
  });
  req.on('close', () => { if (unsubscribe) unsubscribe(); });
}

/** GET /api/jobs?kind= — all jobs (newest first), optionally filtered. */
app.get('/api/jobs', (req, res) => {
  res.json({ jobs: jobs.listJobs(req.query.kind || undefined) });
});

/** GET /api/jobs/:id — one job's status (polling fallback). */
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json({ job });
});

/** GET /api/jobs/:id/events — SSE progress stream. */
app.get('/api/jobs/:id/events', (req, res) => streamJobEvents(req, res, req.params.id));

/** DELETE /api/jobs/:id — cancel a running/pending job. */
app.delete('/api/jobs/:id', async (req, res) => {
  const job = await jobs.cancelJob(req.params.id, comfy());
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json({ job });
});

// Backwards-compatible aliases for the original edit job routes.
app.get('/api/edit/jobs', (req, res) => {
  res.json({ jobs: jobs.listJobs('edit') });
});

app.get('/api/edit/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown edit job' });
  res.json({ job });
});

app.get('/api/edit/jobs/:id/events', (req, res) => streamJobEvents(req, res, req.params.id));

app.delete('/api/edit/jobs/:id', async (req, res) => {
  const job = await jobs.cancelJob(req.params.id, comfy());
  if (!job) return res.status(404).json({ error: 'Unknown edit job' });
  res.json({ job });
});

/**
 * POST /api/generate  (JSON)
 *
 * Body: { prompt, negative, width, height, steps, cfg, sampler, scheduler,
 *         seed, checkpoint }
 *
 * Starts a text-to-image job and returns 202 { job }. width/height default to
 * the spec-recommended maxSize (square) and are clamped to it so SD 1.5 never
 * samples above ~768px (gotcha in section 8).
 */
app.post('/api/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const client = comfy();
    const checkpoints = await client.listCheckpoints();
    const checkpoint = body.checkpoint || checkpoints[0];

    if (!checkpoint) return res.status(409).json({ error: 'No checkpoint installed in ComfyUI/models/checkpoints' });
    if (!checkpoints.includes(checkpoint)) return res.status(400).json({ error: `Unknown checkpoint "${checkpoint}"`, checkpoints });

    const specs = await detectSystem();
    const rec = recommend(specs);
    const maxSize = rec.maxSize || 768;
    const defaults = loadConfig().defaults;

    const inputs = {
      checkpoint,
      positive: body.prompt || body.positive || '',
      negative: body.negative || 'blurry, low quality, worst quality, deformed body, extra limbs, bad anatomy, disfigured, watermark, text, logo',
      width: clampSize(body.width != null ? body.width : maxSize, maxSize),
      height: clampSize(body.height != null ? body.height : maxSize, maxSize),
      maxSize,
      steps: Math.round(toNum(body.steps, defaults.steps)),
      cfg: toNum(body.cfg, defaults.cfg),
      sampler: body.sampler || defaults.sampler,
      scheduler: body.scheduler || defaults.scheduler,
      seed: Math.round(toNum(body.seed, defaults.seed)),
      timeout: 900000,
    };

    const job = jobs.startJob({
      kind: 'generate',
      client,
      inputs,
      buildWorkflow: buildTxt2ImgWorkflow,
    });
    res.status(202).json({ job });
  } catch (err) {
    res.status(502).json({ error: 'Could not start generate', detail: err.message });
  }
});

/**
 * POST /api/transform  (multipart/form-data)
 *
 * Field `image` (required) plus: prompt, negative, denoise, steps, cfg,
 * sampler, scheduler, seed, checkpoint, maxSize, restoreSize.
 *
 * Starts an img2img (Transform) job and returns 202 { job }. Uses plain
 * VAEEncode (no inpaint mask) and clamps maxSize to the spec recommendation.
 */
app.post('/api/transform', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded (send a multipart field named "image")' });
    }
    const body = req.body || {};
    const client = comfy();
    const checkpoints = await client.listCheckpoints();
    const checkpoint = body.checkpoint || checkpoints[0];

    if (!checkpoint) return res.status(409).json({ error: 'No checkpoint installed in ComfyUI/models/checkpoints' });
    if (!checkpoints.includes(checkpoint)) return res.status(400).json({ error: `Unknown checkpoint "${checkpoint}"`, checkpoints });

    const specs = await detectSystem();
    const rec = recommend(specs);
    const defaults = loadConfig().defaults;
    const maxSize = Math.max(256, Math.min(Math.round(toNum(body.maxSize, rec.maxSize)), rec.maxSize));

    const inputs = {
      checkpoint,
      positive: body.prompt || body.positive || '',
      negative: body.negative || 'blurry, low quality, worst quality, deformed body, extra limbs, bad anatomy, disfigured, watermark, text, logo',
      denoise: Math.min(1, Math.max(0.25, toNum(body.denoise, 0.6))),
      maxSize,
      restoreSize: toBool(body.restoreSize, true),
      steps: Math.round(toNum(body.steps, defaults.steps)),
      cfg: toNum(body.cfg, defaults.cfg),
      sampler: body.sampler || defaults.sampler,
      scheduler: body.scheduler || defaults.scheduler,
      seed: Math.round(toNum(body.seed, defaults.seed)),
      timeout: 900000,
    };

    const job = jobs.startJob({
      kind: 'transform',
      client,
      file: req.file,
      inputs,
      buildWorkflow: buildImg2ImgWorkflow,
    });
    res.status(202).json({ job });
  } catch (err) {
    res.status(502).json({ error: 'Could not start transform', detail: err.message });
  }
});

// ------------------------------ queue / history ------------------------------

/** ComfyUI queue entries are tuples: [number, promptId, workflow, extra]. */
function queueItem(entry) {
  const [, promptId, workflow, extra] = entry;
  return {
    promptId,
    clientId: (extra && extra.client_id) || null,
    nodeCount: workflow ? Object.keys(workflow).length : 0,
  };
}

/** GET /api/queue — ComfyUI running/pending prompts + active PixelKiln edits. */
app.get('/api/queue', async (req, res) => {
  try {
    const q = await comfy().getQueue();
    res.json({
      running: (q.queue_running || []).map(queueItem),
      pending: (q.queue_pending || []).map(queueItem),
      activeEdits: jobs.listJobs('edit').filter((j) => ['uploading', 'queued', 'running', 'saving'].includes(j.status)),
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not read ComfyUI queue', detail: err.message });
  }
});

/** POST /api/interrupt — stop the currently running prompt. */
app.post('/api/interrupt', async (req, res) => {
  try {
    await comfy().interrupt((req.body || {}).clientId);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not interrupt ComfyUI', detail: err.message });
  }
});

/** DELETE /api/queue/:promptId — remove a pending prompt. */
app.delete('/api/queue/:promptId', async (req, res) => {
  try {
    await comfy().deleteFromQueue(req.params.promptId);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not remove queue item', detail: err.message });
  }
});

/** GET /api/history?limit=12 — recent results with proxied image URLs. */
app.get('/api/history', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Math.round(toNum(req.query.limit, 12))));
    const client = comfy();
    const all = await client.getAllHistory();
    const items = Object.entries(all)
      .map(([promptId, entry]) => {
        const images = client.collectImages(entry).map((img) => ({ ...img, url: jobs.imageProxyUrl(img) }));
        return { promptId, images, status: (entry.status && entry.status.status_str) || 'success' };
      })
      .filter((item) => item.images.length)
      .reverse()
      .slice(0, limit);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: 'Could not read ComfyUI history', detail: err.message });
  }
});

/**
 * DELETE /api/history/:promptId
 * Delete a result's image files from ComfyUI's output folder AND remove the
 * history entry so it disappears from the thumbnails.
 */
app.delete('/api/history/:promptId', async (req, res) => {
  try {
    const promptId = req.params.promptId;
    const client = comfy();
    const outputDir = await client.getOutputDirectory();
    if (!outputDir) {
      return res.status(409).json({ error: 'Could not determine ComfyUI output directory' });
    }

    const raw = await client.getHistory(promptId);
    const entry = (raw && raw[promptId]) || raw || {};
    const images = client.collectImages(entry).filter((i) => i.type === 'output');

    const root = path.resolve(outputDir) + path.sep;
    const deleted = [];
    for (const img of images) {
      const name = path.posix.basename(String(img.filename || ''));
      if (!name || name === '.' || name === '..') continue;
      const sub = String(img.subfolder || '').replace(/^\/+|\/+$/g, '');
      const relSegs = (sub ? sub.split('/') : []).concat(name);
      if (relSegs.some((seg) => seg === '..' || seg === '')) continue;
      const full = path.resolve(outputDir, ...relSegs);
      if (!full.startsWith(root)) continue; // never delete outside output/
      try {
        await fsp.unlink(full);
        deleted.push(img.filename);
      } catch (_) {
        /* already gone or unreadable */
      }
    }

    await client.deleteHistoryItems([promptId]);
    res.json({ ok: true, promptId, deleted });
  } catch (err) {
    res.status(502).json({ error: 'Could not delete', detail: err.message });
  }
});

/**
 * POST /api/comfy/restart
 * Runs the configured restart command (which must stop the old process and
 * start a new one), then waits for ComfyUI to go down and come back up.
 * Disabled unless `allowComfyRestart` is true and a command is configured.
 */
app.post('/api/comfy/restart', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.allowComfyRestart || !cfg.comfyRestartCommand) {
    return res.status(400).json({ error: 'Restart not enabled. Set a restart command and enable "Allow PixelKiln to restart ComfyUI" in Settings.' });
  }
  const client = comfy();
  let wasOnline = false;
  try { await client.health(); wasOnline = true; } catch (_) { /* offline */ }

  try {
    const { spawn } = require('child_process');
    const child = spawn(cfg.comfyRestartCommand, { shell: true, detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    return res.status(500).json({ error: 'Could not run restart command', detail: err.message });
  }

  const deadline = Date.now() + 150000;
  let sawDown = !wasOnline;
  let online = false;
  while (Date.now() < deadline) {
    let up = false;
    try { await client.health(); up = true; } catch (_) { /* not yet */ }
    if (!up) sawDown = true;
    if (up && sawDown) { online = true; break; }
    await sleep(2000);
  }
  if (online) return res.json({ restarted: true });
  return res.status(504).json({
    restarted: false,
    error: (wasOnline && !sawDown)
      ? 'ComfyUI never went down — does the restart command stop the old process?'
      : 'Timed out waiting for ComfyUI to come back',
  });
});

// --- Multer / body errors -> clean JSON instead of an HTML stack trace ---
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    return res.status(500).json({ error: err.message });
  }
  return next();
});

/**
 * All usable LAN IPv4 addresses. Skips virtual interfaces (Docker, bridges,
 * VPN/tailscale) so a phone gets the real WiFi/Ethernet address.
 */
function getLanIps() {
  const skip = /^(docker|br-|veth|virbr|tun|tap|wg|podman|zt)/i;
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    if (skip.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push({ iface: name, address: net.address });
    }
  }
  return ips;
}

const host = config.listenOnLan ? '0.0.0.0' : '127.0.0.1';
const port = config.port || 3000;

app.listen(port, host, () => {
  const ips = getLanIps();
  console.log('');
  console.log('  ▄▄  PixelKiln  ▄▄   forge your pixels');
  console.log('  ──────────────────────────────────────');
  console.log(`  Local:    http://127.0.0.1:${port}`);
  if (config.listenOnLan) {
    if (ips.length) {
      ips.forEach((ip, i) => {
        console.log(`  ${i === 0 ? 'Network:' : '        '}  http://${ip.address}:${port}   (${ip.iface})`);
      });
      console.log('            phone on the same WiFi — allow the port through your firewall');
    } else {
      console.log('  Network:  no LAN address found (check your connection)');
    }
  } else {
    console.log('  Network:  LAN access disabled (set "listenOnLan": true in config.json)');
  }
  console.log(`  ComfyUI:  ${config.comfyUrl}`);
  console.log('');
});
