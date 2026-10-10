'use strict';
const { spawn } = require('node:child_process');

/** Error from run(): a non-zero exit, a signal, a timeout or a spawn failure. */
class ExecError extends Error {
  /**
   * @param {string} message
   * @param {{ code: number|null, signal?: string|null, stdout: string, stderr: string, timedOut?: boolean }} info
   */
  constructor(message, { code, signal = null, stdout, stderr, timedOut = false }) {
    super(message);
    this.name = 'ExecError';
    this.code = code;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

/**
 * Splits a stream into lines and reports each complete line, plus the last
 * partial line when the stream ends.
 * @param {(line: string) => void} emit
 */
function lineSplitter(emit) {
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop();
      for (const line of parts) emit(line);
    },
    end() {
      if (rest) emit(rest);
      rest = '';
    },
  };
}

/**
 * Run a command and capture its output. Never uses a shell: `cmd` and `args`
 * are passed as an argument array, so paths with spaces are safe.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: object, timeoutMs?: number, onLine?: (line: string, stream: 'stdout'|'stderr') => void }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function run(cmd, args, { cwd, env, timeoutMs = 0, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    const splitters = {
      stdout: lineSplitter((line) => onLine && onLine(line, 'stdout')),
      stderr: lineSplitter((line) => onLine && onLine(line, 'stderr')),
    };

    const onData = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      splitters[stream].push(text);
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ExecError(`${cmd}: ${err.message}`, { code: null, stdout, stderr }));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      splitters.stdout.end();
      splitters.stderr.end();
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      const why = timedOut ? 'timed out' : `exited with ${signal || code}`;
      reject(new ExecError(`${cmd} ${why}`, { code, signal, stdout, stderr, timedOut }));
    });
  });
}

/**
 * True if `cmd` can be run (tries `cmd --version`). Errors are swallowed.
 * @param {string} cmd
 * @returns {Promise<boolean>}
 */
async function which(cmd) {
  try {
    await run(cmd, ['--version'], { timeoutMs: 15000 });
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { run, which, ExecError };
