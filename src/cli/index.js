'use strict';
const { Command } = require('commander');
const version = require('../version');
const brand = require('../brand');
const setupCommand = require('./commands/setup');
const startCommand = require('./commands/start');
const stopCommand = require('./commands/stop');
const statusCommand = require('./commands/status');
const logsCommand = require('./commands/logs');
const doctorCommand = require('./commands/doctor');
const modelsCommand = require('./commands/models');
const configCommand = require('./commands/config');
const chatCommand = require('./commands/chat');
const pairCommand = require('./commands/pair');
const updateCommand = require('./commands/update');
const uninstallCommand = require('./commands/uninstall');

/**
 * Build the commander program. One file per command in ./commands.
 * @returns {import('commander').Command}
 */
function buildProgram() {
  const program = new Command().name(brand.cli).version(version)
    .option('--home <dir>', 'data folder (same as the EMBERNEST_HOME env var)');
  // Runs before any command action, so paths resolve against the chosen folder.
  program.hook('preAction', () => setupCommand.applyHome(program.opts()));
  setupCommand.register(program);
  startCommand.register(program);
  stopCommand.register(program);
  statusCommand.register(program);
  logsCommand.register(program);
  doctorCommand.register(program);
  modelsCommand.register(program);
  configCommand.register(program);
  chatCommand.register(program);
  pairCommand.register(program);
  updateCommand.register(program);
  uninstallCommand.register(program);
  return program;
}

/**
 * CLI entry point.
 * @param {string[]} argv full process.argv (node, script, args...)
 * @returns {Promise<void>}
 */
function main(argv) {
  return buildProgram().parseAsync(argv);
}

module.exports = { main, buildProgram };
