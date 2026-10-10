'use strict';
const net = require('node:net');
const { spawn } = require('node:child_process');
const { streamChat } = require('../server/chat/llm-client');
const { benchCommand } = require('./llm-supervisor');
const { run } = require('../core/exec');
const { isWindows } = require('../core/platform');

/** The fixed prompts: a first question, then a follow-up that reuses turn 1 (prompt cache). */
const BENCH_SYSTEM = 'You are a helpful assistant. Keep answers short.';
const BENCH_TURNS = [
  'In two short sentences, what is a prime number?',
  'Give one example of a prime number above 100.',
];
const BENCH_MAX_TOKENS = 96;
const START_TIMEOUT_MS = 120000;
/** "fast enough for chat": at least this many tokens per second, and the first token within this time (turn 2). */
const TARGET = { genTps: 8, firstTokenMs: 3000 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);

/** Mean of the finite values, rounded to 0.1; null when there are none. Pure. */
function mean(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/**
 * Timing of one turn from what the client saw and llama-server's `timings`. Pure.
 * @param {{ ttftMs: number|null, timings?: object }} raw
 * @returns {{ firstTokenMs: number|null, promptTps: number|null, genTps: number|null }}
 */
function turnStats({ ttftMs, timings }) {
  const t = timings || {};
  return {
    firstTokenMs: finiteOrNull(ttftMs),
    promptTps: finiteOrNull(t.prompt_per_second),
    genTps: finiteOrNull(t.predicted_per_second),
  };
}

/**
 * One result row from the two turns: first token on each turn, and the mean speeds. Pure.
 * @returns {{ ttft1Ms: number|null, ttft2Ms: number|null, promptTps: number|null, genTps: number|null }}
 */
function summarizeTurns(first, second) {
  return {
    ttft1Ms: first.firstTokenMs,
    ttft2Ms: second.firstTokenMs,
    promptTps: mean([first.promptTps, second.promptTps]),
    genTps: mean([first.genTps, second.genTps]),
  };
}

/**
 * "fast enough for chat" when turn 2 generates at least 8 tokens/s and its first token comes within
 * 3 s. A think model's first token is reasoning, so it is never called fast enough for every message.
 * Pure. Rows with an error or without timings get no verdict.
 * @param {{ role?: string, error?: string, ttft2Ms?: number|null, genTps?: number|null }} row
 * @returns {string}
 */
function verdictFor(row) {
  if (row.error) return `error: ${row.error}`;
  if (row.genTps == null || row.ttft2Ms == null) return 'no timing reported';
  if (row.role === 'think') return 'reasons before it answers: use for tricky questions';
  const fast = row.genTps >= TARGET.genTps && row.ttft2Ms <= TARGET.firstTokenMs;
  return fast ? 'fast enough for chat' : 'slower than the chat target';
}

/** Table cells for `chat bench`: seconds, tokens per second, and a dash for missing values. Pure. */
function formatBenchRows(rows) {
  const secs = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)} s`);
  const tps = (v) => (v == null ? '-' : v.toFixed(1));
  return rows.map((r) => ({
    model: r.model,
    role: r.role,
    'first token 1': secs(r.ttft1Ms),
    'first token 2': secs(r.ttft2Ms),
    'prompt tok/s': tps(r.promptTps),
    'gen tok/s': tps(r.genTps),
    verdict: r.verdict,
  }));
}

/**
 * One request. Streams so the first token (reasoning or answer) can be timed.
 * @returns {Promise<{ text: string, ttftMs: number|null, timings: object }>}
 */
async function runTurn(stream, url, model, messages, maxTokens) {
  const t0 = Date.now();
  let first = null;
  let text = '';
  let timings = null;
  for await (const evt of stream({ url, model, messages, params: { max_tokens: maxTokens, temperature: 0 } })) {
    if (first === null && (evt.delta || evt.reasoning)) first = Date.now();
    if (evt.delta) text += evt.delta;
    if (evt.timings) timings = evt.timings;
  }
  return { text, ttftMs: first === null ? null : first - t0, timings: timings || {} };
}

/**
 * Benchmark each model on the server at `url`, one at a time. Each model gets a warm-up request
 * (the router loads it on first use, which is not timed), then the two fixed turns. A failure is
 * recorded on that model's row and the rest still run.
 * @param {{ url: string, models: { id: string, role?: string }[], stream?: Function }} o
 * @returns {Promise<object[]>} rows: model, role, ttft1Ms, ttft2Ms, promptTps, genTps, verdict (+ error)
 */
async function benchModels({ url, models, stream = streamChat }) {
  const rows = [];
  for (const m of models) {
    const row = { model: m.id, role: m.role || 'balanced' };
    try {
      await runTurn(stream, url, m.id, [{ role: 'user', content: 'Say hi.' }], 1);
      const system = { role: 'system', content: BENCH_SYSTEM };
      const q1 = { role: 'user', content: BENCH_TURNS[0] };
      const first = await runTurn(stream, url, m.id, [system, q1], BENCH_MAX_TOKENS);
      const q2 = { role: 'user', content: BENCH_TURNS[1] };
      const answer = { role: 'assistant', content: first.text || '...' };
      const second = await runTurn(stream, url, m.id, [system, q1, answer, q2], BENCH_MAX_TOKENS);
      Object.assign(row, summarizeTurns(turnStats(first), turnStats(second)));
    } catch (err) {
      row.error = err.message;
    }
    row.verdict = verdictFor(row);
    rows.push(row);
  }
  return rows;
}

/** A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Is an OpenAI-style server answering /health at `url`? */
async function isServing(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Ids the router lists at `url`/models, or null when the server has no such list. */
async function servedModelIds(url) {
  try {
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()).data;
    return Array.isArray(data) ? data.map((m) => m.id) : null;
  } catch {
    return null;
  }
}

/** Ends a child process and its group: SIGTERM, then SIGKILL after 5 s. Windows uses taskkill. */
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const kill = async (force) => {
    if (isWindows()) {
      await run('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])]).catch(() => {});
      return;
    }
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      try { process.kill(child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
  };
  await kill(false);
  const quit = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!quit) {
    await kill(true);
    await Promise.race([exited, sleep(3000)]);
  }
}

/** Polls /health until it answers; fails early when the child exits or the time runs out. */
async function waitForHealth(url, hasExited, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error('the temporary chat engine stopped while starting');
    if (await isServing(url)) return;
    await sleep(500);
  }
  throw new Error('the temporary chat engine did not start in time');
}

/**
 * Start a temporary router-mode llama-server on a free port that serves `models`. Call `stop()`
 * when done (in a finally). Throws, after stopping it, if it does not come up.
 * @param {Record<string, string>} paths
 * @param {object} cfg
 * @param {object[]} models manifest entries to serve
 * @param {{ timeoutMs?: number, spawnFn?: Function }} [o]
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
async function startBenchServer(paths, cfg, models, { timeoutMs = START_TIMEOUT_MS, spawnFn = spawn } = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { cmd, args, cwd } = benchCommand(paths, cfg, { port, models });
  const child = spawnFn(cmd, args, {
    cwd, stdio: 'ignore', detached: !isWindows(), windowsHide: true,
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  const stop = () => stopProcess(child);
  try {
    await waitForHealth(url, () => exited, timeoutMs);
  } catch (err) {
    await stop();
    throw err;
  }
  return { url, stop };
}

module.exports = {
  BENCH_TURNS, TARGET, turnStats, summarizeTurns, verdictFor, formatBenchRows, benchModels,
  startBenchServer, isServing, servedModelIds, mean,
};
