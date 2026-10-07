/**
 * jobs.js — generic asynchronous generation jobs with live progress.
 *
 * A job is a background run so the UI can show a real progress bar instead of
 * a blank spinner:
 *   uploading -> queued -> running (per-step progress from ComfyUI's WebSocket)
 *   -> saving -> done | error | cancelled
 *
 * This module is deliberately workflow-agnostic: callers supply a `kind`
 * ('edit' | 'generate' | 'transform'), an API-format workflow builder and the
 * inputs for it. Each job gets its own client_id, so its WebSocket stream only
 * carries that prompt's messages even if other work is queued.
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getImageSize } = require('./imageMeta');

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs for an hour

/** Proxy URL the browser (including a phone) can load. */
function imageProxyUrl({ filename, subfolder = '', type = 'output' }) {
  const qs = new URLSearchParams({ filename, subfolder, type }).toString();
  return `/api/image?${qs}`;
}

/** Public job view (drops internal emitter/control fields). */
function snapshot(job) {
  const { events, stop, ...pub } = job;
  return pub;
}

function update(job, force = false) {
  const now = Date.now();
  if (force || now - job.lastEmit > 200) {
    job.lastEmit = now;
    job.events.emit('update', snapshot(job));
  }
}

/** Pick a safe extension from the uploaded file name. */
function safeExt(originalName) {
  const dot = String(originalName || '').lastIndexOf('.');
  const ext = dot >= 0 ? originalName.slice(dot).toLowerCase() : '';
  return ['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext) ? ext : '.png';
}

/**
 * Open a per-job WebSocket and translate ComfyUI messages into progress.
 * Resolves when execution succeeds. Rejects with `err.comfyExecution` for a
 * real execution error, or `err.wsFallback` when it is only a transport issue
 * (the caller then falls back to polling history).
 */
function monitor(job, client, workflow, timeoutMs) {
  const titles = {};
  for (const [id, node] of Object.entries(workflow)) {
    titles[id] = (node._meta && node._meta.title) || node.class_type;
  }
  const wsUrl = `${client.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(job.clientId)}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) { /* ignore */ }
      if (err) reject(err); else resolve();
    };
    job.stop = () => {
      const err = new Error('Cancelled');
      err.cancelled = true;
      finish(err);
    };
    const timer = setTimeout(() => {
      const err = new Error('Timed out waiting for ComfyUI');
      err.wsFallback = true;
      finish(err);
    }, timeoutMs);

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      const d = msg.data || {};
      if (d.prompt_id && job.promptId && d.prompt_id !== job.promptId) return;

      switch (msg.type) {
        case 'execution_start':
          job.status = 'running';
          job.phase = 'running';
          job.phaseLabel = 'Starting';
          update(job, true);
          break;
        case 'executing':
          if (d.node) {
            job.status = 'running';
            job.phase = 'running';
            job.node = d.node;
            job.nodeTitle = titles[d.node] || `Node ${d.node}`;
            job.phaseLabel = job.nodeTitle;
            job.step = null;
            update(job, true);
          }
          break;
        case 'progress':
          job.node = d.node;
          job.nodeTitle = titles[d.node] || job.nodeTitle;
          job.phase = 'running';
          job.phaseLabel = job.nodeTitle;
          job.step = { value: d.value, max: d.max };
          update(job, true);
          break;
        case 'execution_success':
          finish();
          break;
        case 'execution_error': {
          const err = new Error(`${d.node_type || 'node'} #${d.node_id || '?'}: ${d.exception_message || 'execution error'}`);
          err.comfyExecution = true;
          finish(err);
          break;
        }
        case 'execution_interrupted': {
          const err = new Error('Cancelled');
          err.cancelled = true;
          finish(err);
          break;
        }
        default:
          break;
      }
    });
    ws.addEventListener('error', () => {
      const err = new Error('ComfyUI WebSocket connection failed');
      err.wsFallback = true;
      finish(err);
    });
  });
}

/**
 * The background worker for one job.
 *
 * @param {object} job
 * @param {object} o
 * @param {object} o.client         ComfyClient
 * @param {object|null} [o.file]    uploaded image (multipart) or null
 * @param {object} [o.inputs]       inputs handed to the workflow builder
 * @param {Function} o.buildWorkflow (inputs) => ComfyUI API-format workflow
 */
async function run(job, { client, file, inputs = {}, buildWorkflow }) {
  const resolvedInputs = { ...inputs };
  try {
    // 1. Upload the source image, when the job has one.
    if (file) {
      job.phase = 'uploading';
      job.phaseLabel = 'Uploading image';
      job.percent = 3;
      update(job, true);

      const dims = getImageSize(file.buffer) || { width: 0, height: 0 };
      job.sourceSize = { width: dims.width, height: dims.height };
      // Resolve original dimensions for downscale/restore when the caller did
      // not send explicit width/height (SD 1.5 must not sample above maxSize).
      if (resolvedInputs.width == null) resolvedInputs.width = dims.width;
      if (resolvedInputs.height == null) resolvedInputs.height = dims.height;
      if (job.settings) {
        job.settings.width = resolvedInputs.width;
        job.settings.height = resolvedInputs.height;
      }
      const fileName = `pixelkiln_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${safeExt(file.originalname)}`;
      const subfolder = 'pixelkiln';
      const up = await client.uploadImage(file.buffer, fileName, { type: 'input', subfolder, overwrite: true });
      const imageName = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
      job.imageName = imageName;
      job.before = imageProxyUrl({ filename: up.name, subfolder: up.subfolder || '', type: 'input' });
    }

    // 2. Build + queue the workflow.
    const workflow = buildWorkflow({ ...resolvedInputs, imageName: job.imageName || undefined });

    job.phase = 'queued';
    job.phaseLabel = 'Queued in ComfyUI';
    job.percent = 8;
    update(job, true);
    job.promptId = await client.queuePrompt(workflow, job.clientId);

    // 3. Watch progress over the WebSocket.
    job.phase = 'running';
    job.phaseLabel = 'Generating';
    update(job, true);
    const timeout = resolvedInputs.timeout || 900000;
    try {
      await monitor(job, client, workflow, timeout);
    } catch (err) {
      if (err.cancelled) throw err;
      if (!err.wsFallback) throw err; // genuine execution error
      // Transport issue only — fall back to polling /history below.
      console.warn(`[jobs] job ${job.id} (${job.kind}): ${err.message}; polling history instead`);
    }

    // 4. Collect the result.
    job.phase = 'saving';
    job.phaseLabel = 'Saving result';
    job.percent = 95;
    job.step = null;
    update(job, true);

    const history = await client.waitForCompletion(job.promptId, { timeout: 120000, pollInterval: 500 });
    const images = client.collectImages(history).map((img) => ({ ...img, url: imageProxyUrl(img) }));

    job.images = images;
    job.after = images.length ? images[0].url : null;
    job.status = 'done';
    job.phase = 'done';
    job.phaseLabel = 'Done';
    job.percent = 100;
    job.finishedAt = Date.now();
    update(job, true);
  } catch (err) {
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.phase = 'error';
      job.phaseLabel = 'Failed';
      job.error = err.message;
    }
    job.finishedAt = Date.now();
    update(job, true);
  } finally {
    const cleanup = setTimeout(() => jobs.delete(job.id), JOB_TTL_MS);
    if (cleanup.unref) cleanup.unref();
  }
}

/**
 * Start a generic job and return its public snapshot immediately.
 *
 * @param {object} o
 * @param {string} o.kind             'edit' | 'generate' | 'transform'
 * @param {object} o.client           ComfyClient
 * @param {object|null} [o.file]      uploaded image (multipart) or null
 * @param {object} [o.inputs]         inputs for the workflow builder / settings
 * @param {Function} o.buildWorkflow  (inputs) => ComfyUI API-format workflow
 * @returns {object} public job snapshot
 */
function startJob({ kind, client, file = null, inputs = {}, buildWorkflow }) {
  if (typeof buildWorkflow !== 'function') {
    throw new Error('startJob: buildWorkflow must be a function');
  }
  const { timeout, ...settings } = inputs;
  const job = {
    id: crypto.randomUUID(),
    kind,
    status: file ? 'uploading' : 'queued',
    phase: file ? 'uploading' : 'queued',
    phaseLabel: file ? 'Uploading image' : 'Queued',
    clientId: crypto.randomUUID(),
    promptId: null,
    node: null,
    nodeTitle: null,
    step: null,
    percent: 0,
    error: null,
    before: null,
    after: null,
    images: [],
    settings,
    imageName: null,
    sourceSize: null,
    fileName: (file && file.originalname) || null,
    createdAt: Date.now(),
    finishedAt: null,
    lastEmit: 0,
    events: new EventEmitter(),
    stop: null,
  };
  jobs.set(job.id, job);
  run(job, { client, file, inputs, buildWorkflow }); // fire and forget
  return snapshot(job);
}

/** Public snapshot of one job, or null. */
function getJob(id) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

/** All jobs, newest first. Optional `kind` filter. */
function listJobs(kind) {
  let list = [...jobs.values()];
  if (kind) list = list.filter((j) => j.kind === kind);
  return list.map(snapshot).sort((a, b) => b.createdAt - a.createdAt);
}

/** Subscribe to a job's progress events. Returns an unsubscribe function. */
function subscribe(id, callback) {
  const job = jobs.get(id);
  if (!job) return null;
  const handler = (snap) => callback(snap);
  job.events.on('update', handler);
  return () => job.events.off('update', handler);
}

/** Cancel a running/pending job (interrupts ComfyUI for this client). */
async function cancelJob(id, client) {
  const job = jobs.get(id);
  if (!job) return null;
  if (['done', 'error', 'cancelled'].includes(job.status)) return snapshot(job);

  job.status = 'cancelled';
  job.phase = 'cancelled';
  job.phaseLabel = 'Cancelled';
  job.finishedAt = Date.now();
  if (job.stop) job.stop();
  update(job, true);

  // Best-effort: stop ComfyUI work for this client and drop any pending prompt.
  try { await client.interrupt(job.clientId); } catch (_) { /* ignore */ }
  if (job.promptId) {
    try { await client.deleteFromQueue(job.promptId); } catch (_) { /* ignore */ }
  }
  return snapshot(job);
}

module.exports = {
  startJob,
  getJob,
  listJobs,
  subscribe,
  cancelJob,
  imageProxyUrl,
};
