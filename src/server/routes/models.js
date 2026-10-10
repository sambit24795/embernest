'use strict';

const path = require('path');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { searchModels } = require('../models');
const downloads = require('../downloads');
const { toBool, toNum } = require('../util');
const { localModelsDir } = require('../../core/paths');
const { getMetaStore, compatible } = require('../model-meta');
const suggestions = require('../suggestions');
const { streamEvents } = require('./sse');

const execFileAsync = promisify(execFile);

const NEEDS_PYTHON = 'Merging needs the ComfyUI Python path (embernest setup --comfy-python …)';

/** Sanitise a user-supplied output file stem. */
function safeStem(value, fallback) {
  return String(value || fallback).replace(/[^\w.-]+/g, '_').slice(0, 60) || fallback;
}

/** First `<stem>[_n].safetensors` name that does not exist in `dir`. */
async function freeName(dir, stem) {
  let name = `${stem}.safetensors`;
  for (let i = 1; ; i += 1) {
    try { await fsp.access(path.join(dir, name)); } catch (_) { return name; }
    name = `${stem}_${i}.safetensors`;
  }
}

/** @param {import('express').Express} app @param {object} ctx */
function register(app, ctx) {
  const { getConfig, comfy, getPlan } = ctx;
  const script = (name) => path.join(__dirname, '..', '..', '..', 'python', name);

  /**
   * GET /api/models/search?provider=&query=&type=&baseModel=&nsfw=&sort=&limit=
   * Aggregates Civitai / HuggingFace and attaches a
   * "fits your GPU" badge based on the detected VRAM.
   */
  app.get('/api/models/search', async (req, res) => {
    try {
      const { specs, plan } = await getPlan();
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
        tokens: getConfig().tokens || {},
        system: { vramGB: plan.effectiveVramGB, ramGB: specs.ramGB },
      });
      res.json({
        query: { provider: req.query.provider || 'all', query: req.query.query || '', limit },
        system: { gpu: specs.gpu, vramGB: specs.vramGB, ramGB: specs.ramGB },
        recommendation: plan.image,
        ...result,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * GET /api/models/suggestions — the curated list that fits this machine's tier,
   * each entry with `installed`. Suggestions only; nothing is downloaded until the user asks.
   */
  app.get('/api/models/suggestions', async (req, res) => {
    try {
      const { plan } = await getPlan();
      const { goals, suggestions: all } = suggestions.loadSuggestions();
      let folders = {};
      try { folders = await downloads.listInstalled(comfy()); } catch (_) { /* engine down: show all as not installed */ }
      res.json({
        tier: plan.id,
        baseModel: plan.image.baseModel,
        goals,
        suggestions: suggestions.markInstalled(suggestions.forTier(all, plan.id), folders),
      });
    } catch (err) {
      res.status(500).json({ error: 'Could not load suggestions', detail: err.message });
    }
  });

  /** Metadata store for the models folder we manage (null in url-only external mode). */
  const metaStore = () => {
    const dir = localModelsDir(ctx.paths, getConfig());
    return dir ? getMetaStore(dir) : null;
  };

  /**
   * GET /api/models/installed — files present in the ComfyUI models folders.
   * Each file carries `meta` (type, family, inpainting, trigger words…) or null
   * if the background scan has not reached it yet; `scanning` says whether it is still running.
   */
  app.get('/api/models/installed', async (req, res) => {
    try {
      const folders = await downloads.listInstalled(comfy());
      const store = metaStore();
      if (store) {
        store.scan();
        for (const [folder, files] of Object.entries(folders)) {
          for (const f of files) f.meta = store.get(`${folder}/${f.name}`);
        }
      }
      res.json({ folders, scanning: store ? store.scanning : false });
    } catch (err) {
      res.status(502).json({ error: 'Could not list installed models', detail: err.message });
    }
  });

  /**
   * GET /api/models/compatibility?checkpoint=<name> — yes/no/unknown for every
   * installed LoRA against that checkpoint.
   */
  app.get('/api/models/compatibility', (req, res) => {
    const store = metaStore();
    const ckpt = store && store.get(`checkpoints/${String(req.query.checkpoint || '')}`);
    const loras = {};
    if (store) {
      for (const [key, meta] of Object.entries(store.all())) {
        if (key.startsWith('loras/')) loras[key.slice('loras/'.length)] = compatible(ckpt, meta);
      }
    }
    res.json({ checkpoint: ckpt ? ckpt.family : null, loras });
  });

  /**
   * DELETE /api/models/installed/:folder/:name
   * `folder` must be a known model folder; `name` a plain base name. ComfyUI
   * caches the file list, so the response sets `restartRequired: true`.
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
      if (!downloads.isPlainFileName(name)) {
        return res.status(400).json({ error: 'Invalid model file name' });
      }

      const dir = await downloads.getModelFolderPath(comfy(), folder);
      if (!dir) return res.status(404).json({ error: `ComfyUI has no "${folder}" models folder` });

      const root = path.resolve(dir) + path.sep;
      const full = path.resolve(dir, name);
      if (!full.startsWith(root)) return res.status(400).json({ error: 'Invalid model path' });

      try {
        await fsp.unlink(full);
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: `File not found: ${folder}/${name}` });
        throw err;
      }

      res.json({ ok: true, deleted: `${folder}/${name}`, restartRequired: true });
    } catch (err) {
      res.status(502).json({ error: 'Could not delete model', detail: err.message });
    }
  });

  /**
   * POST /api/models/merge  Body: { ckptA, ckptB, ratio, filename }
   * Merges two same-base checkpoints into a new .safetensors.
   */
  app.post('/api/models/merge', async (req, res) => {
    try {
      const { ckptA, ckptB } = req.body || {};
      if (!ckptA || !ckptB) return res.status(400).json({ error: 'ckptA and ckptB are required' });
      const py = getConfig().comfy.python;
      if (!py) return res.status(400).json({ error: NEEDS_PYTHON });

      const client = comfy();
      const checkpoints = await client.listCheckpoints();
      if (!checkpoints.includes(ckptA)) return res.status(400).json({ error: `Unknown checkpoint "${ckptA}"`, checkpoints });
      if (!checkpoints.includes(ckptB)) return res.status(400).json({ error: `Unknown checkpoint "${ckptB}"`, checkpoints });

      const ratio = Math.min(1, Math.max(0, Number(req.body.ratio ?? 0.5)));
      const filename = safeStem(req.body.filename, 'embernest_merge');

      const folders = await client.listModelFolders();
      const ckptEntry = folders.find((f) => f.name === 'checkpoints');
      const ckptDir = ckptEntry && (ckptEntry.folders || [])[0];
      if (!ckptDir) throw new Error('Could not resolve ComfyUI models/checkpoints folder');

      const destName = await freeName(ckptDir, filename);
      await execFileAsync(py, [
        script('merge_checkpoints.py'),
        '--a', path.join(ckptDir, ckptA),
        '--b', path.join(ckptDir, ckptB),
        '--out', path.join(ckptDir, destName),
        '--ratio', String(ratio),
      ], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });

      res.json({ ok: true, filename: destName, restartRequired: true, message: `Merged checkpoint saved as ${destName} — restart ComfyUI to use it.` });
    } catch (err) {
      const detail = err.stderr ? `${err.message} | ${String(err.stderr).slice(0, 300)}` : err.message;
      res.status(502).json({ error: 'Merge failed', detail });
    }
  });

  /**
   * POST /api/models/merge-loras  Body: { loraA, loraB, strengthA, strengthB, filename }
   * Merges two same-base LoRAs via python/merge_loras.py (rank concatenation).
   */
  app.post('/api/models/merge-loras', async (req, res) => {
    try {
      const { loraA, loraB } = req.body || {};
      if (!loraA || !loraB) return res.status(400).json({ error: 'loraA and loraB are required' });
      const py = getConfig().comfy.python;
      if (!py) return res.status(400).json({ error: NEEDS_PYTHON });

      const client = comfy();
      const loras = await client.listLoras();
      if (!loras.includes(loraA)) return res.status(400).json({ error: `Unknown LoRA "${loraA}"`, loras });
      if (!loras.includes(loraB)) return res.status(400).json({ error: `Unknown LoRA "${loraB}"`, loras });

      const clamp = (v, lo, hi, fb) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; };
      const strengthA = clamp(req.body.strengthA, 0, 2, 1);
      const strengthB = clamp(req.body.strengthB, 0, 2, 1);
      const filename = safeStem(req.body.filename, 'embernest_lora_merge');

      const folders = await client.listModelFolders();
      const loraEntry = folders.find((f) => f.name === 'loras');
      const lorasDir = loraEntry && (loraEntry.folders || [])[0];
      if (!lorasDir) throw new Error('Could not resolve ComfyUI models/loras folder');

      const destName = await freeName(lorasDir, filename);
      await execFileAsync(py, [
        script('merge_loras.py'),
        '--a', path.join(lorasDir, loraA),
        '--b', path.join(lorasDir, loraB),
        '--out', path.join(lorasDir, destName),
        '--strength-a', String(strengthA),
        '--strength-b', String(strengthB),
      ], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });

      res.json({ ok: true, filename: destName, restartRequired: true, message: `Merged LoRA saved as ${destName} — restart ComfyUI to use it.` });
    } catch (err) {
      const detail = err.stderr ? `${err.message} | ${String(err.stderr).slice(0, 300)}` : err.message;
      res.status(502).json({ error: 'LoRA merge failed', detail });
    }
  });

  /**
   * POST /api/models/download  Body: { downloadUrl, type, fileName, fileSizeMB, provider, folder? }
   * Starts a background download. Tokens come from config, never the request body.
   */
  app.post('/api/models/download', async (req, res) => {
    try {
      const { downloadUrl, type, fileName, fileSizeMB, provider, folder } = req.body || {};
      // Descriptive fields from the search item; remembered once the file lands.
      const meta = { ...req.body, provider };
      if (!downloadUrl) return res.status(400).json({ error: 'downloadUrl is required' });
      const tokens = getConfig().tokens || {};
      const tokenKey = provider === 'huggingface' ? 'hf' : provider;
      const job = downloads.startDownload({
        client: comfy(),
        downloadUrl,
        type,
        fileName,
        fileSizeMB: Number(fileSizeMB) || 0,
        provider,
        folder,
        meta,
        metaStore: metaStore(),
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

  /** GET /api/models/downloads/:id/events — Server-Sent Events progress stream. */
  app.get('/api/models/downloads/:id/events', (req, res) => {
    streamEvents(req, res, downloads.getJob(req.params.id), downloads.subscribe, 'Unknown download job');
  });

  /** DELETE /api/models/downloads/:id — cancel a job. */
  app.delete('/api/models/downloads/:id', (req, res) => {
    const job = downloads.cancelJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Unknown download job' });
    res.json({ job });
  });
}

module.exports = { register };
