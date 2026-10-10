'use strict';
const { getPaths } = require('../../core/paths');
const { loadConfig, saveConfig, generateToken } = require('../../core/config');
const { getLanIps } = require('../../core/net');
const { printPairing, baseUrlOf } = require('../../runtime/server-runner');
const ui = require('../ui');

/**
 * Register `embernest pair`. The QR code and URL carry the auth token, so they
 * are printed only to a terminal.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('pair')
    .description('Show the QR code and URL to pair a phone')
    .option('--rotate', 'make a new token; this signs out every paired device')
    .option('--yes', 'do not ask for confirmation with --rotate')
    .option('--url <base>', 'base URL the phone uses, e.g. https://pc.tailnet.ts.net (Tailscale serve)')
    .action(async (options) => {
      const paths = getPaths();
      if (options.rotate) {
        if (!options.yes && !process.stdin.isTTY) throw new Error('--rotate asks to confirm; pass --yes to run it without a terminal');
        const ok = await ui.confirm('Rotating the token signs out every paired phone. Continue?', { yes: options.yes });
        if (!ok) {
          ui.info('Cancelled, nothing was changed.');
          return;
        }
        saveConfig(paths, { authToken: generateToken() });
        ui.ok('New pairing token saved. Every paired device is signed out.');
        if (!process.stdout.isTTY) {
          ui.info('Run embernest pair in a terminal to show the new code.');
          return;
        }
      }

      if (!process.stdout.isTTY) throw new Error('pair shows a secret code: run it in a terminal');
      const cfg = loadConfig(paths);
      if (!cfg.authToken) throw new Error('Run embernest setup first');
      if (options.url) {
        // Reached through another address (Tailscale serve): LAN settings do not matter.
        printPairing(cfg, [], { baseUrl: baseUrlOf(options.url) });
        return;
      }
      if (!cfg.listenOnLan) throw new Error('LAN access is off (embernest config set listenOnLan true)');
      const ips = getLanIps();
      if (!ips.length) throw new Error('No LAN address found (check your connection)');
      printPairing(cfg, ips);
    });
}

module.exports = { register };
