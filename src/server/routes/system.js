'use strict';

const { getLanIps } = require('../../core/net');
const version = require('../../version');
const { checkSearxngUrl } = require('../chat/search');

/** Non-secret view of the config; tokens are reported only as booleans. */
function publicConfig(cfg) {
  return {
    comfyUrl: cfg.comfy.url,
    comfyMode: cfg.comfy.mode,
    port: cfg.port,
    listenOnLan: cfg.listenOnLan,
    defaults: cfg.defaults,
    chat: { search: { searxngUrl: (cfg.chat && cfg.chat.search && cfg.chat.search.searxngUrl) || '' } },
    tokensSet: Object.fromEntries(
      Object.entries(cfg.tokens || {}).map(([k, v]) => [k, Boolean(v)]),
    ),
  };
}

/** @param {import('express').Express} app @param {object} ctx */
function register(app, ctx) {
  const { getConfig, saveConfig, comfy, getPlan } = ctx;

  /** GET /api/health — liveness probe; never needs auth. */
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'embernest', version });
  });

  /** GET /api/specs — OS, GPU model, VRAM (GB) and RAM (GB). */
  app.get('/api/specs', async (req, res) => {
    try {
      const { specs } = await getPlan();
      res.json(specs);
    } catch (err) {
      res.status(500).json({ error: 'Failed to detect system specs', detail: err.message });
    }
  });

  /** GET /api/recommend — specs plus the VRAM-based recommendation (`?vramGB=` override). */
  app.get('/api/recommend', async (req, res) => {
    try {
      const override = Number.parseFloat(req.query.vramGB);
      const { specs, plan } = await getPlan(override);
      res.json({ specs, recommendation: plan.image });
    } catch (err) {
      res.status(500).json({ error: 'Failed to build recommendation', detail: err.message });
    }
  });

  /** GET /api/config — non-secret settings for the Settings tab. */
  app.get('/api/config', (req, res) => {
    res.json(publicConfig(getConfig()));
  });

  /**
   * PUT /api/config — token fields only overwrite when a non-empty string is
   * sent (null clears one); leaving a field blank keeps the stored value.
   */
  app.put('/api/config', (req, res) => {
    try {
      const body = req.body || {};
      const before = getConfig();
      const patch = {};
      if (body.port != null) {
        const port = Math.round(Number(body.port));
        if (port > 0 && port < 65536) patch.port = port;
      }
      if (typeof body.listenOnLan === 'boolean') patch.listenOnLan = body.listenOnLan;
      if (body.defaults && typeof body.defaults === 'object') patch.defaults = body.defaults;
      const search = body.chat && body.chat.search;
      if (search && typeof search === 'object' && 'searxngUrl' in search) {
        patch.chat = { search: { searxngUrl: checkSearxngUrl(search.searxngUrl) } };
      }
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
      res.json({ ok: true, restartRequired, config: publicConfig(saved) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** GET /api/network — URLs this app is reachable on (phone access hint). */
  app.get('/api/network', (req, res) => {
    const cfg = getConfig();
    const port = cfg.port || 3000;
    res.json({
      port,
      listenOnLan: cfg.listenOnLan,
      localUrl: `http://127.0.0.1:${port}`,
      lanUrls: cfg.listenOnLan
        ? getLanIps().map((ip) => ({ url: `http://${ip.address}:${port}`, iface: ip.iface }))
        : [],
    });
  });

  /**
   * GET /api/status — ComfyUI health + the model/sampler lists the UI needs.
   * Never 500s: if ComfyUI is down it returns { online: false, error }.
   */
  app.get('/api/status', async (req, res) => {
    const client = comfy();
    try {
      const [stats, checkpoints, bgRemovalModels, faceModels, samplers, schedulers, loras] =
        await Promise.all([
          client.health(),
          client.listCheckpoints(),
          client.listBackgroundRemovalModels(),
          client.listFaceModels(),
          client.listSamplers(),
          client.listSchedulers(),
          client.listLoras(),
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
        loras,
      });
    } catch (err) {
      res.json({ online: false, comfyUrl: client.baseUrl, error: err.message });
    }
  });
}

module.exports = { register };
