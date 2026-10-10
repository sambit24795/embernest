'use strict';
const { getPaths } = require('../../core/paths');

/**
 * Register `embernest start`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('start')
    .description('Start the engine and the web app')
    .option('--background', 'run detached and return to the prompt')
    .option('--open', 'open the web app in your browser')
    .option('--foreground-child', 'internal: used by --background', false)
    .action(async (options) => {
      const { runServer } = require('../../runtime/server-runner');
      await runServer({ paths: getPaths(), background: Boolean(options.background), open: Boolean(options.open) });
    });
}

module.exports = { register };
