'use strict';

const path = require('path');
const fsp = require('fs/promises');
const jobs = require('../jobs');
const { toNum } = require('../util');

/** ComfyUI queue entries are tuples: [number, promptId, workflow, extra]. */
function queueItem(entry) {
  const [, promptId, workflow, extra] = entry;
  return {
    promptId,
    clientId: (extra && extra.client_id) || null,
    nodeCount: workflow ? Object.keys(workflow).length : 0,
  };
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
        .filter((item) => item.images.length && !jobs.isHeldPrompt(item.promptId))
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
}

module.exports = { register };
