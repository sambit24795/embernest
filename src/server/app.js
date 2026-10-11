/**
 * app.js — builds the Embernest Express app. It does not listen; the caller
 * (server-runner) binds the port.
 */
'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { loadConfig, saveConfig } = require('../core/config');
const { ComfyClient } = require('./comfy');
const { detectHardware } = require('../core/hardware');
const { planForHardware } = require('../core/tiers');
const { createAuth } = require('./auth');
const { createSafety } = require('./safety');
const { getMetaStore } = require('./model-meta');
const { localModelsDir } = require('../core/paths');
const { createGalleryStore, entryFromHistory, galleryFile } = require('./gallery-store');

const system = require('./routes/system');
const models = require('./routes/models');
const jobsRoutes = require('./routes/jobs');
const queue = require('./routes/queue');
const engine = require('./routes/engine');
const chatRoutes = require('./routes/chat');

/**
 * Flat fields the UI reads (gpu name, vramGB, ramGB, os), plus the full
 * hardware description under gpuDetail. vramGB is the effective VRAM the plan
 * uses, so Apple reports its share of unified memory.
 * @param {object} hw
 * @param {{ effectiveVramGB: number }} plan
 */
function specsFrom(hw, plan) {
  return {
    ...hw,
    gpu: hw.gpu.name || 'Unknown GPU',
    gpuDetail: hw.gpu,
    vramGB: plan.effectiveVramGB,
    ramGB: hw.ramGB,
  };
}

/**
 * @param {object} o
 * @param {object} o.paths               result of getPaths()
 * @param {() => object} [o.getConfig]   current config; called per request
 * @param {object|null} [o.supervisor]   ComfyUI supervisor (managed mode)
 * @param {object|null} [o.chatSupervisor] llama-server supervisor (null when chat is off)
 * @param {object|null} [o.hardware]     hardware fallback (detectHardware shape), used when config has none
 * @param {{ check: Function, close?: Function }} [o.safety] photo-edit nudity checker; default is the real worker (tests pass a stub)
 * @param {boolean} [o.trustLoopback]    false only in tests, to treat 127.0.0.1 clients like phones
 * @param {{ quietMs?: number, idleMs?: number }} [o.memoryTiming] memory-extraction timing (tests shorten it)
 * @returns {import('express').Express}
 */
function createApp({ paths, getConfig = () => loadConfig(paths), supervisor = null, chatSupervisor = null, hardware = null, safety = null, trustLoopback = true, memoryTiming = {} }) {
  const app = express();
  safety = safety || createSafety({ paths, getConfig });
  app.locals.safety = safety;
  const auth = createAuth({ getConfig, trustLoopback });
  app.use(auth.hostCheck);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'web'), {
    etag: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  app.get('/pair', auth.rateLimiter, auth.pairRoute);
  // Everything under /api needs auth except the health check (used by `stop`/`status`).
  app.use('/api', (req, res, next) => (req.method === 'GET' && req.path === '/health'
    ? next()
    : auth.rateLimiter(req, res, () => auth.requireAuth(req, res, next))));
  app.post('/api/logout', auth.logoutRoute);

  let detected = null;
  /** Config hardware (written by setup), else the fallback, else detected once. */
  const getHardware = async () => {
    const cfgHw = getConfig().hardware;
    if (cfgHw && cfgHw.gpu) return cfgHw;
    if (hardware) return hardware;
    if (!detected) detected = detectHardware({ dataDir: paths.home });
    return detected;
  };
  /**
   * Hardware, its flat specs and the install plan. `vramOverride` replaces
   * gpu.vramGB on a copy (the ?vramGB= query).
   * @param {number} [vramOverride]
   */
  const getPlan = async (vramOverride) => {
    let hw = await getHardware();
    if (Number.isFinite(vramOverride)) hw = { ...hw, gpu: { ...hw.gpu, vramGB: vramOverride } };
    const plan = planForHardware(hw);
    return { hw, plan, specs: specsFrom(hw, plan) };
  };

  const gallery = createGalleryStore({ file: galleryFile(paths, getConfig()) });
  const ctx = {
    paths,
    gallery,
    /** Called by a finished (approved) job: add its result to the persistent gallery. */
    onResult: ({ promptId, kind, history }) => {
      gallery.add(entryFromHistory(promptId, history, { mode: kind }));
    },
    getConfig,
    saveConfig: (patch) => saveConfig(paths, patch),
    /** Fresh client each call so config edits apply without a restart. */
    comfy: () => new ComfyClient(getConfig().comfy.url),
    getPlan,
    supervisor,
    chatSupervisor,
    safety,
    memoryTiming,
    /** ComfyUI's output folder (where blocked results are deleted), or null when unknown. */
    outputRoot: () => {
      const { comfy: c } = getConfig();
      if (c.mode !== 'external') return paths.output;
      return c.dir ? path.join(c.dir, 'output') : null;
    },
    // Uploaded images are forwarded straight to ComfyUI; hold them in memory.
    upload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }),
  };

  for (const mod of [system, models, jobsRoutes, queue, engine, chatRoutes]) mod.register(app, ctx);

  // Describe installed models in the background; requests get partial data meanwhile.
  setImmediate(() => {
    try {
      const dir = localModelsDir(paths, getConfig());
      if (dir) getMetaStore(dir).scan();
    } catch (_) { /* metadata is optional */ }
  });

  // Bring the gallery index up to date in the background: ComfyUI's live history, then the output folder.
  setImmediate(() => {
    queue.syncGallery(ctx).catch(() => { /* the gallery is optional */ });
  });

  // Multer / body errors -> clean JSON instead of an HTML stack trace.
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    return next();
  });

  return app;
}

module.exports = { createApp };
