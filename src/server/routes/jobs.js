'use strict';

const jobs = require('../jobs');
const { buildInpaintWorkflow, buildImg2ImgWorkflow } = require('../workflow');
const { toBool, toNum, DEFAULT_NEGATIVE } = require('../util');
const { streamEvents } = require('./sse');
const { startGenerate, GenerateError } = require('../generate');

const NO_IMAGE = { error: 'No image uploaded (send a multipart field named "image")' };
const NO_CHECKPOINT = { error: 'No checkpoint installed in ComfyUI/models/checkpoints' };

/** @param {import('express').Express} app @param {object} ctx */
function register(app, ctx) {
  const { getConfig, comfy, upload, getPlan, safety } = ctx;

  const streamJob = (req, res) => streamEvents(req, res, jobs.getJob(req.params.id), jobs.subscribe, 'Unknown job');

  /**
   * POST /api/edit  (multipart/form-data)
   * Field `image` (required) plus optional: positive, negative, checkpoint,
   * bgRemovalModel, faceModel, width, height, maxSize, preserveFace, restoreSize,
   * denoise, steps, cfg, sampler, scheduler, seed, growMask, faceExpand.
   * Returns 202 { job }; progress streams from /api/jobs/:id/events.
   */
  app.post('/api/edit', upload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json(NO_IMAGE);
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

      if (!checkpoint) return res.status(409).json(NO_CHECKPOINT);
      if (!checkpoints.includes(checkpoint)) return res.status(400).json({ error: `Unknown checkpoint "${checkpoint}"`, checkpoints });
      if (!bgRemovalModel) return res.status(409).json({ error: 'No background-removal model installed in ComfyUI/models/background_removal' });
      if (!bgModels.includes(bgRemovalModel)) return res.status(400).json({ error: `Unknown background-removal model "${bgRemovalModel}"`, bgRemovalModels: bgModels });

      const defaults = getConfig().defaults;
      const options = {
        checkpoint,
        bgRemovalModel,
        faceModel,
        positive: body.positive || '',
        negative: body.negative || DEFAULT_NEGATIVE,
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
        loraName: body.loraName || '',
        loraStrength: toNum(body.loraStrength, 1.0),
        growMask: Math.round(toNum(body.growMask, 10)),
        faceExpand: Math.round(toNum(body.faceExpand, 90)),
        timeout: 900000,
      };

      const job = jobs.startJob({
        kind: 'edit',
        client,
        file: req.file,
        inputs: options,
        buildWorkflow: buildInpaintWorkflow,
        safety,
        outputRoot: ctx.outputRoot(),
      });
      res.status(202).json({ job });
    } catch (err) {
      res.status(502).json({ error: 'Could not start edit', detail: err.message });
    }
  });

  // ---- generic jobs (and the original edit-job aliases) ----

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
  app.get('/api/jobs/:id/events', streamJob);

  /** DELETE /api/jobs/:id — cancel a running/pending job. */
  app.delete('/api/jobs/:id', async (req, res) => {
    const job = await jobs.cancelJob(req.params.id, comfy());
    if (!job) return res.status(404).json({ error: 'Unknown job' });
    res.json({ job });
  });

  app.get('/api/edit/jobs', (req, res) => {
    res.json({ jobs: jobs.listJobs('edit') });
  });

  app.get('/api/edit/jobs/:id', (req, res) => {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Unknown edit job' });
    res.json({ job });
  });

  app.get('/api/edit/jobs/:id/events', streamJob);

  app.delete('/api/edit/jobs/:id', async (req, res) => {
    const job = await jobs.cancelJob(req.params.id, comfy());
    if (!job) return res.status(404).json({ error: 'Unknown edit job' });
    res.json({ job });
  });

  /**
   * POST /api/generate  (JSON)
   * Body: { prompt, negative, width, height, steps, cfg, sampler, scheduler, seed, checkpoint }
   * width/height default to the recommended maxSize and are clamped to it so
   * SD 1.5 never samples above ~768px.
   */
  app.post('/api/generate', async (req, res) => {
    try {
      const job = await startGenerate(ctx, req.body || {});
      res.status(202).json({ job });
    } catch (err) {
      if (err instanceof GenerateError) return res.status(err.status).json(err.payload);
      res.status(502).json({ error: 'Could not start generate', detail: err.message });
    }
  });

  /**
   * POST /api/transform  (multipart/form-data)
   * Field `image` (required) plus: prompt, negative, denoise, steps, cfg,
   * sampler, scheduler, seed, checkpoint, maxSize, restoreSize.
   * img2img with plain VAEEncode; maxSize is clamped to the recommendation.
   */
  app.post('/api/transform', upload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json(NO_IMAGE);
      const body = req.body || {};
      const client = comfy();
      const checkpoints = await client.listCheckpoints();
      const checkpoint = body.checkpoint || checkpoints[0];

      if (!checkpoint) return res.status(409).json(NO_CHECKPOINT);
      if (!checkpoints.includes(checkpoint)) return res.status(400).json({ error: `Unknown checkpoint "${checkpoint}"`, checkpoints });

      const { plan } = await getPlan();
      const defaults = getConfig().defaults;
      const maxSize = Math.max(256, Math.min(Math.round(toNum(body.maxSize, plan.image.maxSize)), plan.image.maxSize));

      const inputs = {
        checkpoint,
        positive: body.prompt || body.positive || '',
        negative: body.negative || DEFAULT_NEGATIVE,
        denoise: Math.min(1, Math.max(0.25, toNum(body.denoise, 0.6))),
        maxSize,
        restoreSize: toBool(body.restoreSize, true),
        steps: Math.round(toNum(body.steps, defaults.steps)),
        cfg: toNum(body.cfg, defaults.cfg),
        sampler: body.sampler || defaults.sampler,
        scheduler: body.scheduler || defaults.scheduler,
        seed: Math.round(toNum(body.seed, defaults.seed)),
        loraName: body.loraName || '',
        loraStrength: toNum(body.loraStrength, 1.0),
        timeout: 900000,
      };

      const job = jobs.startJob({ kind: 'transform', client, file: req.file, inputs, buildWorkflow: buildImg2ImgWorkflow, safety, outputRoot: ctx.outputRoot() });
      res.status(202).json({ job });
    } catch (err) {
      res.status(502).json({ error: 'Could not start transform', detail: err.message });
    }
  });
}

module.exports = { register };
