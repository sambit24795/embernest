'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../core/config');
const { run } = require('../core/exec');
const { getLanIps } = require('../core/net');
const { isWindows } = require('../core/platform');
const { readJson } = require('../core/state');
const { planForHardware } = require('../core/tiers');
const { pidAlive, healthy } = require('./server-runner');
const { resolveDevice } = require('../install/llm');

const STOP_TIMEOUT_MS = 15000;
const POLL_MS = 200;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Total size in bytes of a folder tree. Symlinks are not followed.
 * @param {string} dir
 * @returns {number}
 */
function dirSize(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSize(p);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(p).size;
      } catch (_) {
        // removed while we were counting
      }
    }
  }
  return total;
}

/**
 * The server is running when the recorded pid is alive and it answers
 * /api/health on loopback. The pid alone is not enough: a recycled pid must
 * never be signalled.
 * @param {{ pid: number, port: number }|null} state
 * @returns {Promise<boolean>}
 */
async function isRunning(state) {
  return Boolean(state) && pidAlive(state.pid) && await healthy(state.port);
}

/**
 * Ask the running server for its engine state. Never throws.
 * @param {number} port
 * @returns {Promise<{ online: boolean }>}
 */
async function engineOnline(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return { online: Boolean(body.online) };
  } catch (_) {
    return { online: false };
  }
}

/**
 * State of the chat engine: 'off' (not enabled), 'stopped' (Embernest not running),
 * 'running' (llama-server /health answers 200) or 'offline'.
 * @param {object} cfg
 * @param {boolean} running whether the Embernest server runs
 * @param {Function} [fetchFn]
 * @returns {Promise<string>}
 */
async function chatState(cfg, running, fetchFn = fetch) {
  if (!cfg.chat.enabled) return 'off';
  if (!running) return 'stopped';
  try {
    const res = await fetchFn(`${cfg.chat.url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? 'running' : 'offline';
  } catch (_) {
    return 'offline';
  }
}

/**
 * Status of Embernest for `embernest status`. Contains no secrets: the auth
 * token and provider tokens are never copied into the result.
 * @param {Record<string, string>} paths result of getPaths()
 * @returns {Promise<object>}
 */
async function collectStatus(paths) {
  const cfg = loadConfig(paths);
  const state = readJson(paths.state, null);
  const running = await isRunning(state);
  const port = running ? state.port : cfg.port || 3000;
  const engine = running ? await engineOnline(port) : { online: null };
  const hw = cfg.hardware || {};
  const hasHardware = Object.keys(hw).length > 0;
  const plan = hasHardware ? planForHardware(hw) : null;

  return {
    running,
    pid: running ? state.pid : null,
    version: running ? state.version || null : null,
    startedAt: running ? state.startedAt || null : null,
    uptimeSeconds: running && state.startedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000))
      : null,
    port,
    urls: {
      local: `http://127.0.0.1:${port}`,
      lan: running && cfg.listenOnLan ? getLanIps().map((ip) => `http://${ip.address}:${port}`) : [],
    },
    engine: {
      mode: cfg.comfy.mode,
      version: cfg.comfy.version || null,
      state: running ? (engine.online ? 'online' : 'offline') : 'stopped',
    },
    gpu: hw.gpu && hw.gpu.name ? hw.gpu.name : null,
    tier: plan ? plan.id : null,
    chat: {
      enabled: cfg.chat.enabled,
      model: cfg.chat.model || null,
      device: plan ? resolveDevice(cfg, plan) : null,
      port: cfg.chat.port,
      state: await chatState(cfg, running),
    },
    dataFolder: paths.home,
    disk: {
      modelsBytes: dirSize(paths.models),
      outputBytes: dirSize(paths.output),
    },
  };
}

/**
 * Send the stop signal to a Embernest server. POSIX: SIGTERM, so the server
 * stops ComfyUI and removes its state. Windows: taskkill, with the tree.
 * @param {number} pid
 */
async function signalStop(pid) {
  if (isWindows()) {
    await run('taskkill', ['/PID', String(pid), '/T']);
    return;
  }
  process.kill(pid, 'SIGTERM');
}

/**
 * Stop the running server and wait until its process has exited. The process
 * exits only after ComfyUI is stopped, so this also covers the engine.
 * @param {Record<string, string>} paths result of getPaths()
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: 'stopped'|'not-running'|'timeout', pid: number|null }>}
 */
async function stopServer(paths, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const state = readJson(paths.state, null);
  if (!(await isRunning(state))) {
    fs.rmSync(paths.state, { force: true });
    return { status: 'not-running', pid: null };
  }
  const { pid } = state;
  await signalStop(pid);
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return { status: 'timeout', pid };
    await sleep(POLL_MS);
  }
  fs.rmSync(paths.state, { force: true });
  return { status: 'stopped', pid };
}

module.exports = { collectStatus, stopServer, isRunning, dirSize, STOP_TIMEOUT_MS };
