'use strict';
const { getPaths } = require('../../core/paths');
const ui = require('../ui');

/**
 * Register `embernest stop`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('stop')
    .description('Stop the Embernest server and its engine')
    .action(async () => {
      const { stopServer, STOP_TIMEOUT_MS } = require('../../runtime/status');
      const { status, pid } = await stopServer(getPaths());
      if (status === 'not-running') {
        ui.info('Embernest is not running');
      } else if (status === 'stopped') {
        ui.ok('Embernest stopped');
      } else {
        ui.fail(`Embernest (pid ${pid}) did not stop within ${STOP_TIMEOUT_MS / 1000} s. Check: embernest logs server`);
        process.exitCode = 1;
      }
    });
}

module.exports = { register };
