/**
 * jobs.js — generic asynchronous generation jobs with live progress.
 *
 * A job is a background run so the UI can show a real progress bar instead of
 * a blank spinner:
 *   uploading -> queued -> running (per-step progress from ComfyUI's WebSocket)
 *   -> saving -> done | error | cancelled | blocked
 *
 * This module is deliberately workflow-agnostic: callers supply a `kind`
 * ('edit' | 'generate' | 'transform'), an API-format workflow builder and the
 * inputs for it. Each job gets its own client_id, so its WebSocket stream only
 * carries that prompt's messages even if other work is queued.
 */
'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const brand = require('../brand');
const { EventEmitter } = require('events');
const { getImageSize } = require('./imageMeta');

// Edits of uploaded photos are checked; Generate (no uploaded photo) never is.
const CHECKED_KINDS = ['edit', 'transform'];
const BLOCKED_MESSAGE = "Blocked: edits of uploaded photos can't produce nudity.";
const UNAVAILABLE_MESSAGE = 'Safety check unavailable — run embernest doctor';

/** Environment variable to disable safety checks for testing. */
const DISABLE_SAFETY = brand.getEnv('NO_SAFETY') === '1';

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs for an hour

/** Proxy URL the browser (including a phone) can load. */
function imageProxyUrl({ filename, subfolder = '', type = 'output' }) {
  const qs = new URLSearchParams({ filename, subfolder, type }).toString();
  return `/api/image?${qs}`;
}

/** Public job view (drops internal emitter/control fields). */
function snapshot(job) {
  const { events, stop, unchecked, ...pub } = job;
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
 * Delete result images from disk (path-guarded to the output folder) and
 * drop the prompt from ComfyUI's history. Best effort: never throws.
 * @param {object} client
 * @param {string} promptId
 * @param {object[]} images       {filename, subfolder, type}
 * @param {string|null} outputRoot ComfyUI's output folder, or null when unknown
 */
async function discardOutputs(client, promptId, images, outputRoot) {
  if (outputRoot) {
    const root = path.resolve(outputRoot);
    for (const img of images) {
      if ((img.type || 'output') !== 'output') continue;
      const file = path.resolve(root, img.subfolder || '', img.filename);
      if (!file.startsWith(root + path.sep)) continue;
      try { await fsp.rm(file, { force: true }); } catch (_) { /* ignore */ }
    }
  }
  try { await client.deleteHistoryItems([promptId]); } catch (_) { /* ignore */ }
}

/**
 * Run the nudity check over every result image.
 * @returns {Promise<'ok'|'blocked'|'unavailable'>}
 */
async function checkOutputs(client, safety, images) {
  if (DISABLE_SAFETY) {
    console.warn('[jobs] Safety check disabled (EMBERNEST_NO_SAFETY=1); skipping checks for', CHECKED_KINDS.join(','));
    return 'ok'; // bypass the check when disabled
  }
  if (!safety) return 'unavailable'; // fail closed: a checked kind must have a checker
  try {
    for (const img of images) {
      const { buffer } = await client.viewImage(img);
      if ((await safety.check(buffer)).blocked) return 'blocked';
    }
    return 'ok';
  } catch (_) {
    // SafetyUnavailableError, or the image could not be fetched: either way it is unchecked.
    return 'unavailable';
  }
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
 * @param {object|null} [o.safety]  nudity checker (see safety.js); required for edit/transform
 * @param {string|null} [o.outputRoot] ComfyUI's output folder, so blocked files can be deleted
 */
async function run(job, { client, file, inputs = {}, buildWorkflow, safety = null, outputRoot = null }) {
  const resolvedInputs = { ...inputs };
  // Unique output prefix per job. ComfyUI's SaveImage counter scans the output
  // folder and can flap/collide across rapid jobs (overwriting earlier results),
  // so give every job its own filename namespace instead.
  const kindPrefix = job.kind === 'generate' ? 'embernest_gen' : job.kind === 'transform' ? 'embernest_tf' : 'embernest';
  resolvedInputs.filenamePrefix = `${kindPrefix}_${Date.now().toString(36)}`;
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
      const fileName = `embernest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${safeExt(file.originalname)}`;
      const subfolder = 'embernest';
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
    const found = client.collectImages(history);

    if (CHECKED_KINDS.includes(job.kind)) {
      job.phaseLabel = 'Checking result';
      job.unchecked = found; // hidden from /api/image and /api/history until approved
      update(job, true);
      const verdict = await checkOutputs(client, safety, found);
      if (verdict !== 'ok') {
        await discardOutputs(client, job.promptId, found, outputRoot);
        job.images = [];
        job.after = null;
        job.status = verdict === 'blocked' ? 'blocked' : 'error';
        job.phase = job.status;
        job.phaseLabel = verdict === 'blocked' ? 'Blocked' : 'Failed';
        job.error = verdict === 'blocked' ? BLOCKED_MESSAGE : UNAVAILABLE_MESSAGE;
        job.finishedAt = Date.now();
        update(job, true);
        return;
      }
    }
    const images = found.map((img) => ({ ...img, url: imageProxyUrl(img) }));

    job.unchecked = null;
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
 * @param {object|null} [o.safety]    nudity checker; edit/transform fail closed without one
 * @param {string|null} [o.outputRoot] ComfyUI's output folder
 * @returns {object} public job snapshot
 */
function startJob({ kind, client, file = null, inputs = {}, buildWorkflow, safety = null, outputRoot = null }) {
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
  run(job, { client, file, inputs, buildWorkflow, safety, outputRoot }); // fire and forget
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
  if (['done', 'error', 'cancelled', 'blocked'].includes(job.status)) return snapshot(job);

  const wasRunning = job.status === 'running';
  job.status = 'cancelled';
  job.phase = 'cancelled';
  job.phaseLabel = 'Cancelled';
  job.finishedAt = Date.now();
  if (job.stop) job.stop();
  update(job, true);

  // Best-effort: drop the pending prompt, and interrupt ComfyUI only if THIS job is the one
  // running (its interrupt is global, so a queued job's cancel must not stop another job).
  if (wasRunning) {
    try { await client.interrupt(job.clientId); } catch (_) { /* ignore */ }
  }
  if (job.promptId) {
    try { await client.deleteFromQueue(job.promptId); } catch (_) { /* ignore */ }
  }
  return snapshot(job);
}

/**
 * True while a photo-edit result is unapproved: its job is still being checked
 * (or failed the check), so neither the image nor its history entry is shown.
 * @param {string} promptId
 */
function isHeldPrompt(promptId) {
  for (const job of jobs.values()) {
    if (CHECKED_KINDS.includes(job.kind) && job.promptId === promptId && job.status !== 'done') return true;
  }
  return false;
}

/** True if the image belongs to a photo-edit result that has not been approved. */
function isHeldImage({ filename, subfolder = '' }) {
  for (const job of jobs.values()) {
    if (!job.unchecked || job.status === 'done') continue;
    if (job.unchecked.some((img) => img.filename === filename && (img.subfolder || '') === subfolder)) return true;
  }
  return false;
}

module.exports = {
  isHeldPrompt,
  isHeldImage,
  startJob,
  getJob,
  listJobs,
  subscribe,
  cancelJob,
  imageProxyUrl,
  discardOutputs,
  checkOutputs, // exported for testing DISABLE_SAFETY
};
