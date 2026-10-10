'use strict';
const fs = require('node:fs');
const path = require('node:path');
const brand = require('../brand');
const { spawn } = require('node:child_process');
const qrcode = require('qrcode-terminal');
const { loadConfig } = require('../core/config');
const { createLogger } = require('../core/log');
const { getLanIps, isPortFree } = require('../core/net');
const { isWindows, isMac } = require('../core/platform');
const { readJson, writeJson } = require('../core/state');
const version = require('../version');
const ui = require('../cli/ui');
const { ComfySupervisor } = require('./supervisor');
const { LlmSupervisor } = require('./llm-supervisor');

const BACKGROUND_WAIT_MS = 200000;
const BIN = path.join(__dirname, '..', '..', 'bin', 'embernest.js');

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** True when a Embernest server answers /api/health on loopback. */
async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

/**
 * The URL a phone opens to pair. It carries the auth token by design.
 * @param {string} ip
 * @param {number} port
 * @param {string} token
 * @returns {string}
 */
function pairingUrl(ip, port, token) {
  return `http://${ip}:${port}/pair?token=${encodeURIComponent(token)}`;
}

/**
 * Pairing URL on a base address the phone can reach (e.g. a Tailscale https name).
 * @param {string} baseUrl origin such as "https://pc.tailnet.ts.net"
 * @param {string} token
 * @returns {string}
 */
function pairingUrlFromBase(baseUrl, token) {
  return `${baseUrl}/pair?token=${encodeURIComponent(token)}`;
}

/**
 * Validate a `--url` value and return its origin (no path, no trailing slash).
 * @param {string} value
 * @returns {string}
 */
function baseUrlOf(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch (_) {
    throw new Error(`--url is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--url must start with http:// or https://');
  return url.origin;
}

/**
 * Firewall hint lines for an OS (from the v0.1 README).
 * @param {number} port
 * @param {string} [platform]
 * @returns {string[]}
 */
function firewallHint(port, platform = process.platform) {
  if (platform === 'win32') {
    return [`Windows: allow Node.js through Windows Defender Firewall (Private networks), or`,
      `  New-NetFirewallRule -DisplayName "Embernest" -Direction Inbound -LocalPort ${port} -Protocol TCP -Action Allow`];
  }
  if (platform === 'darwin') {
    return ['macOS: System Settings > Network > Firewall > Options > allow incoming for Node.'];
  }
  return [`Linux (ufw):       sudo ufw allow ${port}/tcp`,
    `Linux (firewalld): sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`];
}

/**
 * Banner text lines (no QR). The token never appears here.
 * @param {object} cfg
 * @param {Array<{ iface: string, address: string }>} ips
 * @param {string} [platform]
 * @returns {string[]}
 */
function bannerLines(cfg, ips, platform = process.platform) {
  const port = cfg.port || 3000;
  const hw = cfg.hardware || {};
  const gpu = (hw.gpu && hw.gpu.name) || 'unknown GPU';
  const lines = ['', '  Embernest  -  forge your pixels', '  ----------------------------------',
    `  Local:    http://127.0.0.1:${port}`];
  if (cfg.listenOnLan) {
    if (ips.length) {
      ips.forEach((ip, i) => lines.push(`  ${i === 0 ? 'Network:' : '        '}  http://${ip.address}:${port}   (${ip.iface})`));
    } else {
      lines.push('  Network:  no LAN address found (check your connection)');
    }
  } else {
    lines.push('  Network:  LAN access is off (embernest config set listenOnLan true)');
  }
  const engine = cfg.comfy.mode === 'external' ? `external, ${cfg.comfy.url}` : `ComfyUI ${cfg.comfy.version || ''}`.trim();
  lines.push(`  Engine:   ${engine}`, `  GPU:      ${gpu}`, '');
  if (cfg.listenOnLan && ips.length) {
    lines.push('  If the phone cannot connect, allow the port through your firewall:');
    for (const l of firewallHint(port, platform)) lines.push(`    ${l}`);
    lines.push('');
  }
  return lines;
}

/**
 * Print the banner and, when LAN is on, the pairing QR code. The QR and URL
 * carry the auth token, so they are only printed to a terminal — never into a
 * log file (e.g. the --background child, whose stdout is embernest.log).
 * @param {object} cfg
 */
function printBanner(cfg) {
  const ips = getLanIps();
  for (const line of bannerLines(cfg, ips)) console.log(line);
  if (!process.stdout.isTTY) {
    if (cfg.listenOnLan) console.log('  To pair a phone, run: embernest pair\n');
    return;
  }
  printPairing(cfg, ips);
}

/**
 * Print the pairing QR code and URL. Without a baseUrl this uses the first LAN
 * address, and does nothing unless LAN is on and an address exists.
 * @param {object} cfg
 * @param {Array<{ iface: string, address: string }>} ips
 * @param {{ baseUrl?: string }} [opts] origin the phone should use instead of a LAN address
 * @returns {boolean} true when the code was printed
 */
function printPairing(cfg, ips, opts = {}) {
  if (!process.stdout.isTTY || !cfg.authToken) return false;
  if (!opts.baseUrl && (!cfg.listenOnLan || !ips.length)) return false;
  const url = opts.baseUrl
    ? pairingUrlFromBase(opts.baseUrl, cfg.authToken)
    : pairingUrl(ips[0].address, cfg.port || 3000, cfg.authToken);
  qrcode.generate(url, { small: true }, (qr) => {
    console.log(qr);
    console.log('  Scan with your phone (same Wi-Fi)');
    console.log(`  ${url}`);
    console.log('');
  });
  return true;
}

/** Open a URL in the default browser. Failures are ignored. */
function openBrowser(url) {
  let cmd = 'xdg-open';
  let args = [url];
  if (isMac()) cmd = 'open';
  if (isWindows()) {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch (_) {
    // no browser available
  }
}

/** A tiny TTY spinner; plain text elsewhere. */
function spinner(text) {
  if (!process.stdout.isTTY) {
    console.log(`${text}...`);
    return { stop() {} };
  }
  const frames = ['|', '/', '-', '\\'];
  let i = 0;
  const timer = setInterval(() => process.stdout.write(`\r${frames[i++ % 4]} ${text}`), 120);
  return { stop() { clearInterval(timer); process.stdout.write('\r\x1b[K'); } };
}

/** @returns {boolean} true when setup.json says setup finished */
function setupDone(paths, cfg) {
  const rec = readJson(paths.setupState, {});
  return Boolean(cfg.comfy.url && rec.steps && rec.steps.config);
}

/** Re-launch `start` as a detached child that logs to the server log. */
async function startBackground(paths, cfg, open) {
  fs.mkdirSync(path.dirname(paths.serverLog), { recursive: true });
  const fd = fs.openSync(paths.serverLog, 'a', 0o600);
  const child = spawn(process.execPath, [BIN, 'start', '--foreground-child'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, EMBERNEST_HOME: paths.home },
  });
  child.unref();
  fs.closeSync(fd);
  let exited = false;
  child.on('exit', () => { exited = true; });
  const spin = spinner('Starting Embernest in the background');
  const deadline = Date.now() + BACKGROUND_WAIT_MS;
  while (Date.now() < deadline && !exited) {
    if (await healthy(cfg.port)) {
      spin.stop();
      printBanner(cfg);
      ui.info(`  Running in the background (pid ${child.pid}). Logs: ${paths.serverLog}`);
      if (open) openBrowser(`http://127.0.0.1:${cfg.port}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  spin.stop();
  throw new Error(exited
    ? `Embernest failed to start. See ${paths.serverLog}`
    : `Embernest did not come up within ${BACKGROUND_WAIT_MS / 1000} s. See ${paths.serverLog}`);
}

/**
 * Start llama-server when chat is enabled. A failure is a warning: images keep working.
 * @param {Record<string, string>} paths
 * @param {object} cfg
 * @param {{ info: Function, warn: Function }} logger
 * @returns {Promise<LlmSupervisor|null>} null when chat is off or failed to start
 */
async function startChat(paths, cfg, logger) {
  if (!cfg.chat.enabled) return null;
  const chat = new LlmSupervisor({ paths, getConfig: () => loadConfig(paths), logger });
  chat.on('crashed', () => ui.fail('The chat engine keeps crashing. See: embernest logs chat'));
  const spin = spinner('Loading the chat model');
  try {
    await chat.start();
  } catch (err) {
    spin.stop();
    ui.warn(`Chat did not start (images still work): ${err.message.split('\n')[0]}`);
    logger.warn(`chat did not start: ${err.message}`);
    return null;
  }
  spin.stop();
  return chat;
}

/**
 * Start the supervisor and the web app.
 * @param {{ paths: Record<string, string>, background?: boolean, open?: boolean }} opts
 * @returns {Promise<void>}
 */
async function runServer({ paths, background = false, open = false }) {
  const cfg = loadConfig(paths);
  if (!setupDone(paths, cfg)) {
    ui.fail('Run embernest setup first');
    process.exitCode = 1;
    return;
  }
  const port = cfg.port || 3000;
  const host = cfg.listenOnLan ? '0.0.0.0' : '127.0.0.1';

  const prev = readJson(paths.state, null);
  if (prev && pidAlive(prev.pid) && await healthy(prev.port || port)) {
    ui.info(`Embernest is already running (pid ${prev.pid}).`);
    printBanner(cfg);
    return;
  }
  if (!(await isPortFree(port, host))) {
    ui.fail(`Port ${port} is already in use. Stop the other program or run: embernest config set port <n>`);
    process.exitCode = 1;
    return;
  }
  if (background) {
    try {
      await startBackground(paths, cfg, open);
    } catch (err) {
      ui.fail(err.message);
      process.exitCode = 1;
    }
    return;
  }

  const logger = createLogger(paths.serverLog);
  const supervisor = new ComfySupervisor({ paths, getConfig: () => loadConfig(paths), logger });
  supervisor.on('crashed', () => ui.fail('ComfyUI keeps crashing. See: embernest logs engine'));

  /** Warn if safety is disabled for testing. */
  if (brand.getEnv('NO_SAFETY') === '1') {
    logger.warn('Safety filter disabled (EMBERNEST_NO_SAFETY=1). Edits and transforms will not be checked.');
  }

  const spin = spinner('Starting engine');
  try {
    await supervisor.start();
  } catch (err) {
    spin.stop();
    ui.fail(err.message);
    process.exitCode = 1;
    return;
  }
  spin.stop();

  const chatSupervisor = await startChat(paths, cfg, logger);

  const { createApp } = require('../server/app');
  const app = createApp({ paths, getConfig: () => loadConfig(paths), supervisor, chatSupervisor, hardware: cfg.hardware });
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = app.listen(port, host, () => resolve(s));
      s.once('error', reject);
    });
  } catch (err) {
    if (chatSupervisor) await chatSupervisor.stop();
    await supervisor.stop();
    ui.fail(`Could not listen on port ${port}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  printBanner(cfg);
  writeJson(paths.state, {
    pid: process.pid, port, comfyPid: supervisor.pid, chatPid: chatSupervisor ? chatSupervisor.pid : null, startedAt: new Date().toISOString(), version,
  });
  logger.info(`Embernest ${version} listening on ${host}:${port}`);
  if (open) openBrowser(`http://127.0.0.1:${port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    ui.info('Shutting down...');
    server.close();
    server.closeAllConnections();
    app.locals.safety.close();
    if (app.locals.chatMemory) app.locals.chatMemory.close();
    if (chatSupervisor) await chatSupervisor.stop();
    await supervisor.stop();
    fs.rmSync(paths.state, { force: true });
    logger.info('Embernest stopped');
    process.exit(0);
  };
  const signals = isWindows() ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  for (const sig of signals) process.on(sig, shutdown);
}

module.exports = {
  runServer, bannerLines, pairingUrl, pairingUrlFromBase, baseUrlOf, printPairing, firewallHint, pidAlive, healthy,
};
