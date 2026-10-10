'use strict';
const { getPaths } = require('../../core/paths');
const ui = require('../ui');

/**
 * Register `embernest logs [server|engine|chat]`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('logs')
    .description('Show the last lines of the server, engine or chat log')
    .argument('[target]', 'server (default), engine or chat', 'server')
    .option('-f, --follow', 'keep printing new lines (Ctrl-C to stop)')
    .option('-n, --lines <n>', 'number of lines to show', (v) => Number.parseInt(v, 10), 100)
    .action((target, options) => {
      const { readTail, followFile } = require('../../runtime/logs');
      const paths = getPaths();
      const files = { server: paths.serverLog, engine: paths.comfyLog, chat: paths.chatLog };
      if (!files[target]) {
        ui.fail(`Unknown log "${target}". Use: server, engine or chat`);
        process.exitCode = 1;
        return;
      }
      if (!(options.lines > 0)) {
        ui.fail('--lines must be a positive number');
        process.exitCode = 1;
        return;
      }
      const file = files[target];
      for (const line of readTail(file, options.lines)) console.log(line);
      if (options.follow) followFile(file, (text) => process.stdout.write(text));
    });
}

module.exports = { register };
