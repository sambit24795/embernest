'use strict';
const { getPaths } = require('../../core/paths');
const ui = require('../ui');

const PRINT = { ok: ui.ok, warn: ui.warn, fail: ui.fail };

/**
 * Print one line per check, with its fix hint under every warning and failure.
 * @param {Array<{ status: string, message: string, hint: string }>} checks
 */
function printChecks(checks) {
  for (const c of checks) {
    PRINT[c.status](c.message);
    if (c.hint && c.status !== 'ok') ui.info(`    fix: ${c.hint}`);
    else if (c.hint) ui.info(`    ${c.hint}`);
  }
  const count = (s) => checks.filter((c) => c.status === s).length;
  ui.info(`\n${count('ok')} ok, ${count('warn')} warnings, ${count('fail')} problems`);
}

/**
 * Register `embernest doctor`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('doctor')
    .description('Check the install and print a fix for every problem')
    .option('--json', 'print machine-readable JSON')
    .action(async (options) => {
      const { runDoctor } = require('../../runtime/doctor');
      const result = await runDoctor(getPaths());
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else printChecks(result.checks);
      if (!result.ok) process.exitCode = 1;
    });
}

module.exports = { register, printChecks };
