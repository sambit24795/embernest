/**
 * downloads.js — stream model files into the correct ComfyUI models folder,
 * with progress reporting.
 *
 * ComfyUI exposes its real folder paths at GET /experiment/models, so we never
 * have to guess where ComfyUI is installed. Downloads go to a `.part` file and
 * are renamed into place only once complete, so a crash/abort never leaves a
 * half-file that ComfyUI might try to load.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');

// Canonical model type -> ComfyUI models/<folder>.
const FOLDER_BY_TYPE = {
  checkpoint: 'checkpoints',
  lora: 'loras',
  vae: 'vae',
  detection: 'detection',
  background_removal: 'background_removal',
  controlnet: 'controlnet',
  upscaler: 'upscale_models',
  embedding: 'embeddings',
};

const jobs = new Map();

/** Keep only a safe base name with a sane length. */
function sanitizeFileName(name) {
  const base = path.basename(String(name || 'download.safetensors'));
  return base.replace(/[^\w.\- ]+/g, '_').replace(/_{2,}/g, '_').slice(0, 200)
    || 'download.safetensors';
}

/** Public view of a job (drops the internal emitter/abort/private fields). */
function snapshot(job) {
  const { events, abort, lastEmit, lastBytes, lastTime, ...pub } = job;
  return pub;
}

/** Recompute percent/speed and emit an SSE update (throttled). */
function update(job, force = false) {
  const now = Date.now();
  const dt = (now - job.lastTime) / 1000;
  if (dt >= 0.5) {
    job.speed = Math.round((job.received - job.lastBytes) / dt);
    job.lastTime = now;
    job.lastBytes = job.received;
  }
  job.percent = job.total ? Math.min(100, Math.round((job.received / job.total) * 1000) / 10) : 0;
  if (force || now - job.lastEmit > 250) {
    job.lastEmit = now;
    job.events.emit('update', snapshot(job));
  }
}

/** Ask ComfyUI where a given model type should be installed. */
async function resolveTarget(client, type, folder) {
  const folders = await client.listModelFolders();
  const wanted = folder || FOLDER_BY_TYPE[type];
  if (!wanted) {
    throw new Error(`Cannot install type "${type}"; choose a folder explicitly`);
  }
  const entry = folders.find((f) => f.name === wanted);
  if (!entry) {
    throw new Error(`ComfyUI has no "${wanted}" models folder`);
  }
  const dir = (entry.folders || [])[0];
  if (!dir) throw new Error(`No path configured for models/${wanted}`);
  await fsp.mkdir(dir, { recursive: true });
  return { dir, folderName: wanted, extensions: entry.extensions || [] };
}

/** Build the request headers, adding tokens only for the matching host. */
function buildHeaders(downloadUrl, provider, token) {
  const headers = { 'User-Agent': 'Embernest/0.1 (local personal use)', Accept: '*/*' };
  if (!token) return headers;
  let host = '';
  try { host = new URL(downloadUrl).hostname; } catch (_) { /* ignore */ }
  const wantsAuth = (provider === 'civitai' && /(^|\.)civitai\.com$/i.test(host))
    || ((provider === 'huggingface' || provider === 'hf') && /(^|\.)huggingface\.co$/i.test(host));
  // Only attach the token to the provider's own host — never to a redirect
  // target (Node's fetch also strips it on cross-origin redirects).
  if (wantsAuth) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** The actual download, run in the background by startDownload(). */
async function run(job, opts) {
  let tmpPath = null;
  try {
    const client = opts.client;
    const target = await resolveTarget(client, opts.type, opts.folder);
    job.folder = target.folderName;

    const finalPath = path.join(target.dir, job.fileName);
    tmpPath = `${finalPath}.part`;
    job.filePath = finalPath;

    const expected = opts.fileSizeMB ? Math.round(opts.fileSizeMB * 1048576) : 0;
    const headers = buildHeaders(opts.downloadUrl, opts.provider, opts.token);

    job.status = 'downloading';
    update(job, true);

    const res = await fetch(opts.downloadUrl, {
      headers,
      redirect: 'follow',
      signal: job.abort.signal,
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('Download failed: empty response body');

    const advertised = Number(res.headers.get('content-length')) || 0;
    job.total = advertised || expected || 0;
    update(job, true);

    // Count bytes as they flow through to disk.
    const progress = new Transform({
      transform(chunk, _enc, cb) {
        job.received += chunk.length;
        update(job);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(tmpPath));

    // Size sanity check (plan section 7.4).
    if (job.total && job.received !== job.total) {
      job.warning = `Expected ${job.total} bytes but received ${job.received}`;
    } else if (expected && Math.abs(job.received - expected) > expected * 0.02) {
      job.warning = `Size differs from listing: got ${job.received} bytes, expected ~${expected}`;
    }

    await fsp.rename(tmpPath, finalPath);
    tmpPath = null;
    if (opts.metaStore && opts.meta) {
      await opts.metaStore.recordDownload(target.folderName, job.fileName, opts.meta);
    }
    job.status = 'done';
    job.finishedAt = Date.now();
    job.restartRequired = true;
    update(job, true);
  } catch (err) {
    if (tmpPath) await fsp.rm(tmpPath, { force: true }).catch(() => {});
    if (job.status !== 'cancelled') {
      job.status = 'error';
      job.error = err.name === 'AbortError' ? 'Cancelled' : err.message;
      console.error(`[downloads] job ${job.id} failed:`, err.message);
    }
    job.finishedAt = Date.now();
    update(job, true);
  }
}

/**
 * Start a download. Returns the public job snapshot immediately; progress is
 * streamed via subscribe()/SSE.
 *
 * @param {object} o
 * @param {object} o.client      ComfyClient (for /experiment/models)
 * @param {string} o.downloadUrl
 * @param {string} o.type        canonical model type
 * @param {string} [o.fileName]
 * @param {number} [o.fileSizeMB]
 * @param {string} [o.provider]
 * @param {string} [o.token]     only sent to the provider's own host
 * @param {string} [o.folder]    override the destination folder name
 * @param {object} [o.meta]      search-item metadata to remember (see model-meta.js)
 * @param {{ recordDownload: Function }} [o.metaStore] where to remember it
 */
function startDownload(o) {
  if (!o || !o.downloadUrl) throw new Error('downloadUrl is required');
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    provider: o.provider || null,
    type: o.type || null,
    fileName: sanitizeFileName(o.fileName || path.basename(new URL(o.downloadUrl).pathname).split('?')[0]),
    received: 0,
    total: 0,
    percent: 0,
    speed: 0,
    folder: null,
    filePath: null,
    warning: null,
    error: null,
    restartRequired: false,
    createdAt: Date.now(),
    finishedAt: null,
    events: new EventEmitter(),
    abort: new AbortController(),
    lastEmit: 0,
    lastBytes: 0,
    lastTime: Date.now(),
  };
  jobs.set(job.id, job);
  run(job, o); // fire and forget
  return snapshot(job);
}

/** Public snapshot of one job, or null. */
function getJob(id) {
  const job = jobs.get(id);
  return job ? snapshot(job) : null;
}

/** All jobs, newest first. */
function listJobs() {
  return [...jobs.values()].map(snapshot).sort((a, b) => b.createdAt - a.createdAt);
}

/** Subscribe to a job's progress events. Returns an unsubscribe function. */
function subscribe(id, callback) {
  const job = jobs.get(id);
  if (!job) return null;
  const handler = (snap) => callback(snap);
  job.events.on('update', handler);
  return () => job.events.off('update', handler);
}

/** Abort a running download. */
function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'queued' || job.status === 'downloading') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    job.abort.abort();
    update(job, true);
  }
  return snapshot(job);
}

/**
 * Folder entries in the shape ComfyUI's listModelFolders() returns:
 * [{ name, folders: [absoluteDir], extensions }]. A ComfyClient asks ComfyUI;
 * a `{ modelsDir }` source (the CLI, external mode) maps FOLDER_BY_TYPE onto it.
 * @param {{ listModelFolders: () => Promise<object[]> } | { modelsDir: string }} source
 * @returns {Promise<object[]>}
 */
async function folderEntries(source) {
  if (source && source.modelsDir) {
    return Object.values(FOLDER_BY_TYPE).map((name) => ({
      name,
      folders: [path.join(source.modelsDir, name)],
      extensions: [],
    }));
  }
  return source.listModelFolders();
}

/**
 * True for a plain base name: no separators, not "." or "..". The guard for
 * anything that joins a user-supplied file name onto a models folder.
 * @param {unknown} name
 * @returns {boolean}
 */
function isPlainFileName(name) {
  if (typeof name !== 'string' || !name) return false;
  return path.basename(name) === name && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\\');
}

/**
 * List files already installed in the relevant model folders.
 * @param {ComfyClient|{ modelsDir: string }} source
 * @returns {Promise<Record<string, Array<{ name: string, sizeMB: number }>>>}
 */
async function listInstalled(source) {
  const folders = await folderEntries(source);
  const wanted = new Set(Object.values(FOLDER_BY_TYPE));
  const result = {};
  for (const entry of folders) {
    if (!wanted.has(entry.name)) continue;
    const dir = (entry.folders || [])[0];
    result[entry.name] = [];
    if (!dir) continue;
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('put_')) continue;
        if (!e.isFile() && !e.isSymbolicLink()) continue;
        let size = 0;
        try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch (_) { /* ignore */ }
        result[entry.name].push({ name: e.name, sizeMB: Math.round((size / 1048576) * 10) / 10 });
      }
      result[entry.name].sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) {
      /* folder missing/unreadable -> empty list */
    }
  }
  return result;
}

/**
 * Resolve the absolute directory for a named models folder, or null.
 * @param {ComfyClient|{ modelsDir: string }} source
 * @param {string} folderName
 * @returns {Promise<string|null>}
 */
async function getModelFolderPath(source, folderName) {
  const folders = await folderEntries(source);
  const entry = folders.find((f) => f.name === folderName);
  if (!entry) return null;
  return (entry.folders || [])[0] || null;
}

module.exports = {
  startDownload,
  getJob,
  listJobs,
  subscribe,
  cancelJob,
  listInstalled,
  getModelFolderPath,
  isPlainFileName,
  FOLDER_BY_TYPE,
};
