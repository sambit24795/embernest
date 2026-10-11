'use strict';

const path = require('path');
const fsp = require('fs/promises');
const jobs = require('../jobs');
const { toNum } = require('../util');
const { entryFromHistory, outputImages } = require('../gallery-store');

/** ComfyUI queue entries are tuples: [number, promptId, workflow, extra]. */
function queueItem(entry) {
  const [, promptId, workflow, extra] = entry;
  return {
    promptId,
    clientId: (extra && extra.client_id) || null,
    nodeCount: workflow ? Object.keys(workflow).length : 0,
  };
}

/**
 * Index ComfyUI history entries that are not in the gallery yet (never held photo edits).
 * Throws when ComfyUI can't be reached.
 */
async function importLive(ctx) {
  const all = await ctx.comfy().getAllHistory();
  const fresh = Object.entries(all || {})
    .filter(([id]) => !ctx.gallery.has(id) && !jobs.isHeldPrompt(id))
    .map(([id, entry]) => entryFromHistory(id, entry, { source: 'import' }));
  return ctx.gallery.add(...fresh);
}

/** Import live history (if reachable), then scan the output folder. */
async function syncGallery(ctx) {
  let imported = 0;
  try { imported = await importLive(ctx); } catch (_) { /* engine not up yet */ }
  const scanned = await ctx.gallery.scan(ctx.outputRoot(), {
    isHeldImage: jobs.isHeldImage, checkedBusy: jobs.hasPendingChecked,
  });
  return { imported, ...scanned };
}

/** @param {import('express').Express} app @param {object} ctx */
function register(app, ctx) {
  const { comfy } = ctx;

  /**
   * GET /api/image?filename=&subfolder=&type=
   * Proxy an image from ComfyUI (bound to 127.0.0.1, so a phone can't reach it).
   */
  app.get('/api/image', async (req, res) => {
    const { filename, subfolder = '', type = 'output' } = req.query;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    if (type === 'output' && jobs.isHeldImage({ filename, subfolder })) {
      return res.status(404).json({ error: 'Image not available' });
    }
    try {
      const { buffer, contentType } = await comfy().viewImage({ filename, subfolder, type });
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) {
      res.status(502).json({ error: 'Could not fetch image from ComfyUI', detail: err.message });
    }
  });

  /** GET /api/queue — ComfyUI running/pending prompts + active Embernest edits. */
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

  /**
   * GET /api/history?limit=12&offset=0&mode=generate|transform|edit
   * Results (newest first) from the persistent gallery index, plus any live ComfyUI
   * results not indexed yet, with proxied image URLs, mode, prompt, key settings,
   * createdAt and, for edit/transform, the `before` image. Held photo edits are hidden.
   */
  app.get('/api/history', async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, Math.round(toNum(req.query.limit, 12))));
      const offset = Math.max(0, Math.round(toNum(req.query.offset, 0)));
      const wantMode = ['generate', 'transform', 'edit'].includes(req.query.mode) ? req.query.mode : null;
      let liveError = null;
      try {
        await importLive(ctx);
      } catch (err) {
        liveError = err; // ComfyUI is down: the index still answers
      }
      const { items: page, total } = await ctx.gallery.list({
        mode: wantMode, offset, limit, outputRoot: ctx.outputRoot(), isHidden: (e) => jobs.isHeldPrompt(e.id),
      });
      if (liveError && !total) return res.status(502).json({ error: 'Could not read ComfyUI history', detail: liveError.message });
      const items = page.map((e) => ({
        promptId: e.id,
        images: e.images.map((img) => ({ ...img, url: jobs.imageProxyUrl(img) })),
        status: 'success',
        mode: e.mode,
        prompt: e.prompt,
        settings: e.settings,
        createdAt: e.createdAt,
        before: e.before ? jobs.imageProxyUrl({ ...e.before, type: 'input' }) : null,
      }));
      res.json({ items, total, hasMore: offset + items.length < total });
    } catch (err) {
      res.status(500).json({ error: 'Could not read the gallery', detail: err.message });
    }
  });

  /** POST /api/history/rescan — index ComfyUI's history and the output folder again. */
  app.post('/api/history/rescan', async (req, res) => {
    try {
      res.json({ ok: true, ...(await syncGallery(ctx)), total: ctx.gallery.size() });
    } catch (err) {
      res.status(500).json({ error: 'Could not rescan', detail: err.message });
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
      let outputDir = ctx.outputRoot(); // the same folder the index and scan use
      if (!outputDir) {
        try { outputDir = await client.getOutputDirectory(); } catch (_) { /* engine may be down */ }
      }
      if (!outputDir) {
        return res.status(409).json({ error: 'Could not determine ComfyUI output directory' });
      }

      let entry = {};
      try {
        const raw = await client.getHistory(promptId);
        entry = (raw && raw[promptId]) || raw || {};
      } catch (_) { /* not in the live history */ }
      const indexed = ctx.gallery.get(promptId);
      const images = [...outputImages(entry), ...(indexed ? indexed.images : [])]
        .filter((img, i, all) => all.findIndex((o) => o.filename === img.filename && (o.subfolder || '') === (img.subfolder || '')) === i);

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

      try { await client.deleteHistoryItems([promptId]); } catch (_) { /* nothing live to remove */ }
      ctx.gallery.remove(promptId);
      res.json({ ok: true, promptId, deleted });
    } catch (err) {
      res.status(502).json({ error: 'Could not delete', detail: err.message });
    }
  });
}

module.exports = { register, syncGallery };
