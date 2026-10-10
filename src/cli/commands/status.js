'use strict';
const { getPaths } = require('../../core/paths');
const ui = require('../ui');
const brand = require('../../brand');

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Check if safety is disabled via environment variable. */
const SAFETY_DISABLED = brand.getEnv('NO_SAFETY') === '1';

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** @param {number|null} seconds */
function formatUptime(seconds) {
  if (seconds === null) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** @param {{ enabled: boolean, model: string|null, device: string|null, state: string }} chat */
function formatChat(chat) {
  if (!chat.enabled) return 'off (embernest setup --chat adds it)';
  return `${chat.state} (${chat.model || 'no model'}${chat.device ? `, ${chat.device}` : ''})`;
}

/**
 * Print the human-readable status block.
 * @param {object} s result of collectStatus()
 */
function printStatus(s) {
  const rows = [
    ['Running', s.running ? `yes (pid ${s.pid})` : 'no'],
    ['Local', s.urls.local],
    ...s.urls.lan.map((url, i) => [i === 0 ? 'Network' : '', url]),
    ['Uptime', formatUptime(s.uptimeSeconds)],
    ['Engine', `${s.engine.state}${s.engine.version ? ` (${s.engine.version})` : ''}`],
    ['Chat', formatChat(s.chat)],
    ['GPU', s.gpu || 'unknown'],
    ['Tier', s.tier || 'unknown'],
    ['Data folder', s.dataFolder],
    ['Models', formatBytes(s.disk.modelsBytes)],
    ['Outputs', formatBytes(s.disk.outputBytes)],
    ['Safety filter', SAFETY_DISABLED ? 'disabled (testing)' : 'enabled'],
  ];
  ui.info('');
  for (const [label, value] of rows) ui.info(`  ${label.padEnd(12)} ${value}`);
  ui.info('');
}

/**
 * Register `embernest status`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('status')
    .description('Show whether Embernest runs, its URLs, engine, GPU and disk use')
    .option('--json', 'print machine-readable JSON')
    .action(async (options) => {
      const { collectStatus } = require('../../runtime/status');
      const status = await collectStatus(getPaths());
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      if (!status.running) ui.info('Embernest is not running');
      printStatus(status);
    });
}

module.exports = { register, formatBytes, formatUptime };
