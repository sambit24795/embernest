'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { rotateIfNeeded } = require('../core/log');
const { isPortFree } = require('../core/net');
const { isWindows } = require('../core/platform');
const { run } = require('../core/exec');

const HEALTH_TIMEOUT_MS = 180000;
const STOP_GRACE_MS = 10000;
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const MAX_CRASHES = 3;
const TAIL_LINES = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for the data-folder mode that uses extra_model_paths.yaml (setup records it with hyphens). */
function usesExtraModelPaths(comfy) {
  return comfy.dataMode === 'extra-model-paths' || comfy.dataMode === 'extra_model_paths';
}

/**
 * Supervises one long-running child process (ComfyUI, llama-server, ...): port
 * guard, spawn, health wait, process-group stop, and restarts after crashes.
 * Emits 'state' (status), 'crashed' and 'exit'.
 *
 * Subclasses may override `isExternal(cfg)` (no child: only wait for the health
 * URL) and `describe(cfg)` (extra fields for status()).
 */
class ProcessSupervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.name           shown in messages, e.g. 'ComfyUI'
   * @param {Record<string, string>} o.paths
   * @param {string} o.logFile        child output goes here (mode 0600, rotated)
   * @param {() => object} o.getConfig
   * @param {(cfg: object) => string} o.healthUrl   URL that answers 200 when the child is ready
   * @param {(cfg: object) => { cmd: string, args: string[], cwd?: string, env?: object }} [o.buildCommand]
   * @param {(cfg: object) => ({ port: number, url: string, setting: string }|null)} [o.portCheck]
   *   port the child will bind, probed before start; null skips the guard
   * @param {{ info: Function, warn: Function, error: Function }} [o.logger]
   * @param {(cfg: object) => { cmd: string, args: string[], cwd?: string, env?: object }} [o.command]
   *   replaces the command line (tests only)
   * @param {{ healthTimeoutMs?: number, healthIntervalMs?: number, restartDelayMs?: number, stopGraceMs?: number }} [o.timing]
   */
  constructor({
    name, paths, logFile, getConfig, healthUrl, buildCommand = null, portCheck = () => null,
    logger = null, command = null, timing = {},
  }) {
    super();
    this.name = name;
    this.paths = paths;
    this.logFile = logFile;
    this.getConfig = getConfig;
    this.healthUrl = healthUrl;
    this.commandBuilder = buildCommand;
    this.portCheck = portCheck;
    this.logger = logger;
    this.command = command;
    this.timing = {
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
      healthIntervalMs: 1000,
      restartDelayMs: 2000,
      stopGraceMs: STOP_GRACE_MS,
      ...timing,
    };
    this.child = null;
    this.state = 'stopped';
    this.startedAt = null;
    this.restarts = 0;
    this.crashTimes = [];
    this.tail = [];
    this.stopping = false;
    this.restartTimer = null;
  }

  /** @returns {boolean} true when there is no child to manage (subclass hook) */
  isExternal() {
    return false;
  }

  /** @returns {object} extra fields for status() (subclass hook) */
  describe() {
    return {};
  }

  /** @returns {number|null} pid of the child */
  get pid() {
    return this.child && this.child.pid ? this.child.pid : null;
  }

  /** @returns {{ state: string, pid: number|null, url: string, startedAt: string|null, restarts: number }} */
  status() {
    const cfg = this.getConfig();
    return {
      ...this.describe(cfg),
      state: this.state,
      pid: this.pid,
      url: this.healthUrl(cfg),
      startedAt: this.startedAt,
      restarts: this.restarts,
    };
  }

  setState(state) {
    this.state = state;
    this.emit('state', this.status());
  }

  /**
   * Managed: spawn the child and wait until healthy. External: wait until healthy only.
   * @returns {Promise<void>}
   */
  async start() {
    const cfg = this.getConfig();
    this.stopping = false;
    this.crashTimes = [];
    if (this.isExternal(cfg)) {
      this.setState('starting');
      try {
        await this.waitHealthy(this.healthUrl(cfg), null);
      } catch (err) {
        this.setState('stopped');
        throw err;
      }
      this.startedAt = new Date().toISOString();
      this.setState('external');
      return;
    }
    await this.guardPort(cfg);
    this.setState('starting');
    try {
      await this.spawnAndWait();
    } catch (err) {
      this.stopping = true; // do not auto-restart a failed first start
      await this.killChild();
      this.setState('crashed');
      throw err;
    }
    this.startedAt = new Date().toISOString();
    this.setState('running');
  }

  /** Refuse to start when something we did not start already owns the port. */
  async guardPort(cfg) {
    const check = this.portCheck(cfg);
    if (!check || await isPortFree(check.port, '127.0.0.1')) return;
    if (await this.probe(this.healthUrl(cfg))) {
      throw new Error(`Something is already running on port ${check.port} — stop it or change ${check.setting}`);
    }
    throw new Error(`Port ${check.port} is in use by another program — change ${check.setting}`);
  }

  async probe(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  /** Poll the health URL; reject early if the child exits (with the log tail). */
  async waitHealthy(url, child) {
    const deadline = Date.now() + this.timing.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        throw new Error(`${this.name} exited (code ${child.exitCode}) before it was ready:\n${this.tail.join('\n')}`);
      }
      if (child && this.child !== child) throw new Error(`${this.name} was stopped before it was ready`);
      if (await this.probe(url)) return;
      await sleep(this.timing.healthIntervalMs);
    }
    throw new Error(`${this.name} did not answer at ${url} within ${Math.round(this.timing.healthTimeoutMs / 1000)} s`);
  }

  buildCommand(cfg) {
    if (this.command) return this.command(cfg);
    if (!this.commandBuilder) throw new Error(`${this.name}: no command line configured`);
    return this.commandBuilder(cfg);
  }

  spawnChild(cfg) {
    const { cmd, args, cwd, env } = this.buildCommand(cfg);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    rotateIfNeeded(this.logFile);
    this.tail = [];
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, HF_HOME: this.paths.hfCache, PYTHONUNBUFFERED: '1', ...env },
      detached: !isWindows(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pipeLines(child);
    child.on('error', (err) => this.writeLog(`spawn error: ${err.message}`));
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    this.logger && this.logger.info(`${this.name} started (pid ${child.pid})`);
    return child;
  }

  writeLog(line) {
    this.tail.push(line);
    if (this.tail.length > TAIL_LINES) this.tail.shift();
    try {
      fs.appendFileSync(this.logFile, `${line}\n`, { mode: 0o600 });
    } catch (_) {
      // a full disk must not kill the supervisor
    }
  }

  pipeLines(child) {
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const parts = (rest + chunk).split(/\r?\n/);
        rest = parts.pop();
        parts.forEach((l) => this.writeLog(l));
      });
      stream.on('end', () => { if (rest) this.writeLog(rest); });
    }
  }

  async spawnAndWait() {
    const cfg = this.getConfig();
    const child = this.spawnChild(cfg);
    await this.waitHealthy(this.healthUrl(cfg), child);
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.emit('exit', { code, signal });
    if (this.stopping) return;
    this.logger && this.logger.warn(`${this.name} exited unexpectedly (${signal || code})`);
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    if (this.crashTimes.length > MAX_CRASHES) {
      this.setState('crashed');
      this.logger && this.logger.error(`${this.name} crashed too many times; giving up`);
      this.emit('crashed', this.status());
      return;
    }
    this.setState('starting');
    this.restartTimer = setTimeout(() => this.autoRestart(), this.timing.restartDelayMs);
  }

  async autoRestart() {
    this.restartTimer = null;
    if (this.stopping) return;
    this.restarts += 1;
    try {
      await this.spawnAndWait();
      if (!this.stopping) {
        this.startedAt = new Date().toISOString();
        this.setState('running');
      }
    } catch (err) {
      this.logger && this.logger.error(`${this.name} restart failed: ${err.message}`);
    }
  }

  /** Graceful stop, then forced. A no-op for external children. */
  async stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    await this.killChild();
    this.startedAt = null;
    this.setState('stopped');
  }

  async killChild() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await this.signal(child.pid, false);
    const timedOut = await Promise.race([exited.then(() => false), sleep(this.timing.stopGraceMs).then(() => true)]);
    if (timedOut) {
      await this.signal(child.pid, true);
      await Promise.race([exited, sleep(5000)]);
    }
    this.child = null;
  }

  async signal(pid, force) {
    if (isWindows()) {
      await run('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]).catch(() => {});
      return;
    }
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (_) {
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (__) { /* already gone */ }
    }
  }

  /** @returns {Promise<void>} */
  async restart() {
    if (this.isExternal(this.getConfig())) throw new Error('external engine');
    await this.stop();
    this.restarts += 1;
    await this.start();
  }
}

/** Supervises ComfyUI (managed), or just waits for it to answer (external). */
class ComfySupervisor extends ProcessSupervisor {
  /** @param {object} o same as ProcessSupervisor, minus name/logFile/healthUrl/portCheck */
  constructor({ paths, ...rest }) {
    super({
      ...rest,
      name: 'ComfyUI',
      paths,
      logFile: paths.comfyLog,
      healthUrl: (cfg) => `${cfg.comfy.url}/system_stats`,
      portCheck: (cfg) => ({ port: cfg.comfy.port, url: cfg.comfy.url, setting: 'comfy.port' }),
    });
  }

  isExternal(cfg) {
    return cfg.comfy.mode === 'external';
  }

  describe(cfg) {
    return { mode: cfg.comfy.mode };
  }

  /** In external mode the status url is the engine URL itself, as before. */
  status() {
    return { ...super.status(), url: this.getConfig().comfy.url };
  }

  buildCommand(cfg) {
    if (this.command) return this.command(cfg);
    const { comfy } = cfg;
    const dataArgs = usesExtraModelPaths(comfy)
      ? ['--output-directory', this.paths.output, '--input-directory', this.paths.input]
      : ['--base-directory', this.paths.data];
    return {
      cmd: comfy.python,
      args: ['main.py', '--listen', '127.0.0.1', '--port', String(comfy.port), ...dataArgs, ...(comfy.args || [])],
      cwd: comfy.dir,
    };
  }
}

module.exports = { ProcessSupervisor, ComfySupervisor, Supervisor: ComfySupervisor };
