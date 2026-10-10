/**
 * safety.js — nudity check for results of photo edits.
 *
 * Runs python/nsfw_worker.py as a long-lived child (JSON lines over stdio) so
 * the model loads once. Fails closed: when the worker cannot start, crashes
 * or times out, check() throws SafetyUnavailableError.
 */
'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getManifest } = require('../install/manifest');
const { run } = require('../core/exec');

const WORKER_SCRIPT = path.join(__dirname, '..', '..', 'python', 'nsfw_worker.py');
const CHECK_TIMEOUT_MS = 30000;
const START_TIMEOUT_MS = 120000; // first start loads the model from disk

/** The safety check could not run, so the result must not be released. */
class SafetyUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyUnavailableError';
  }
}

/**
 * Command line that starts the worker for a pinned model.
 * @param {string} python
 * @param {{ repo: string, revision: string }} model
 * @param {{ warmup?: boolean, offline?: boolean }} [opts]
 * @returns {string[]} arguments for spawn(python, args)
 */
function workerArgs(python, model, { warmup = false, offline = false } = {}) {
  const args = [WORKER_SCRIPT, '--repo', model.repo, '--revision', model.revision];
  if (warmup) args.push('--warmup');
  if (offline) args.push('--offline');
  return args;
}

/**
 * Download (unless offline) and load the pinned model once, then exit.
 * @param {Record<string, string>} paths
 * @param {string} python
 * @param {{ repo: string, revision: string }} model
 * @param {{ offline?: boolean, onLine?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<void>} rejects with the worker's error
 */
async function warmup(paths, python, model, { offline = false, onLine, timeoutMs = 0 } = {}) {
  await run(python, workerArgs(python, model, { warmup: true, offline }),
    { env: { HF_HOME: paths.hfCache, CUDA_VISIBLE_DEVICES: '' }, onLine, timeoutMs });
}

/**
 * @param {object} o
 * @param {Record<string, string>} o.paths           getPaths() result (tmp, hfCache)
 * @param {() => object} o.getConfig                 current config (comfy.python)
 * @param {{ info?: Function, warn?: Function }} [o.logger]
 * @param {object} [o.manifest]                      override for tests ({ safety })
 * @param {{ cmd: string, args: string[] }} [o.command]  override for tests (a stub worker)
 * @param {number} [o.checkTimeoutMs]
 * @param {number} [o.startTimeoutMs]
 * @returns {{ check: (buffer: Buffer) => Promise<{ nsfwScore: number, blocked: boolean }>, close: () => void }}
 */
function createSafety({ paths, getConfig, logger = {}, manifest, command, checkTimeoutMs = CHECK_TIMEOUT_MS, startTimeoutMs = START_TIMEOUT_MS }) {
  const log = (level, msg) => { if (typeof logger[level] === 'function') logger[level](msg); };
  const settings = () => (manifest || getManifest()).safety;

  let child = null;
  let starting = null; // Promise<child> while the worker loads
  let onReady = null; // set while a start is waiting for {"ready": true}
  const pending = new Map(); // id -> { resolve, reject, timer }

  const failAll = (err, proc) => {
    for (const [id, p] of pending) {
      if (p.proc !== proc) continue;
      clearTimeout(p.timer); p.reject(err); pending.delete(id);
    }
  };

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.ready) { if (child) { child.ready = true; if (onReady) onReady(child); } return; }
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (typeof msg.nsfw === 'number') p.resolve(msg.nsfw);
    else p.reject(new SafetyUnavailableError(`safety worker could not read the image: ${msg.error || 'unknown error'}`));
  }

  function spawnWorker() {
    const cfg = getConfig();
    const s = settings();
    let cmd; let args;
    if (command) {
      ({ cmd, args } = command);
    } else {
      cmd = cfg.comfy.python;
      if (!cmd) throw new SafetyUnavailableError('no Python configured for the safety check');
      args = workerArgs(cmd, s, { offline: true });
    }
    const proc = spawn(cmd, args, {
      env: { ...process.env, HF_HOME: paths.hfCache, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderrTail = '';
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(onLine);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
    proc.stdin.on('error', () => { /* worker died; the exit handler reports it */ });
    proc.once('exit', (code, signal) => {
      if (child === proc) child = null;
      const why = signal ? `signal ${signal}` : `code ${code}`;
      log('warn', `safety worker exited (${why})${stderrTail ? `: ${stderrTail.trim().split('\n').pop()}` : ''}`);
      failAll(new SafetyUnavailableError(`safety worker exited (${why})`), proc);
    });
    proc.once('error', (err) => failAll(new SafetyUnavailableError(`safety worker could not start: ${err.message}`), proc));
    return proc;
  }

  /** Resolves with a worker that has printed {"ready": true}. */
  function ensureWorker() {
    if (child && child.ready) return Promise.resolve(child);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      let proc;
      try { proc = spawnWorker(); } catch (err) { reject(err); return; }
      child = proc;
      const timer = setTimeout(() => {
        proc.kill();
        reject(new SafetyUnavailableError('safety worker did not become ready in time'));
      }, startTimeoutMs);
      onReady = (p) => { clearTimeout(timer); onReady = null; resolve(p); };
      proc.once('exit', () => { clearTimeout(timer); reject(new SafetyUnavailableError('safety worker exited before it was ready')); });
      proc.once('error', (err) => { clearTimeout(timer); reject(new SafetyUnavailableError(`safety worker could not start: ${err.message}`)); });
    }).finally(() => { starting = null; onReady = null; });
    return starting;
  }

  async function check(buffer) {
    await fsp.mkdir(paths.tmp, { recursive: true });
    const file = path.join(paths.tmp, `safety_${crypto.randomUUID()}.img`);
    await fsp.writeFile(file, buffer);
    try {
      const proc = await ensureWorker();
      const id = crypto.randomUUID();
      const nsfwScore = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          if (child === proc) child = null; // the next check starts a fresh worker
          proc.kill();
          reject(new SafetyUnavailableError(`safety check timed out after ${checkTimeoutMs / 1000}s`));
        }, checkTimeoutMs);
        pending.set(id, { resolve, reject, timer, proc });
        proc.stdin.write(`${JSON.stringify({ id, path: file })}\n`);
      });
      return { nsfwScore, blocked: nsfwScore >= settings().threshold };
    } catch (err) {
      if (err instanceof SafetyUnavailableError) throw err;
      throw new SafetyUnavailableError(err.message);
    } finally {
      fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  function close() {
    const proc = child;
    child = null;
    if (proc) {
      try { proc.stdin.end(); } catch (_) { /* ignore */ }
      proc.kill();
    }
  }

  return { check, close };
}

module.exports = { createSafety, warmup, SafetyUnavailableError, workerArgs, WORKER_SCRIPT };
