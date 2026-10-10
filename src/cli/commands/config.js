'use strict';
const { getPaths } = require('../../core/paths');
const {
  loadConfig, saveConfig, redact, isSettableKey, getByPath, patchFromPath, parseSettingValue,
} = require('../../core/config');
const ui = require('../ui');

/** Settings that hold secrets: shown as set / not set only. */
const SECRET_KEY = /^(authToken|tokens(\.|$))/;

/**
 * Render a value for the terminal. Strings print bare; objects as JSON.
 * @param {*} value
 * @returns {string}
 */
function showValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/**
 * Register `embernest config get|set`.
 * @param {import('commander').Command} program
 */
function register(program) {
  const config = program.command('config').description('Show or change settings');

  config
    .command('get [key]')
    .description('Show settings, or one dotted key (secrets print as set / not set)')
    .action((key) => {
      const shown = redact(loadConfig(getPaths()));
      if (key === undefined) {
        ui.info(JSON.stringify(shown, null, 2));
        return;
      }
      const value = getByPath(shown, key);
      if (value === undefined) throw new Error(`Unknown setting "${key}"`);
      ui.info(showValue(value));
    });

  config
    .command('set <key> <value>')
    .description('Change a setting (see README for the list of keys)')
    .action((key, raw) => {
      if (!isSettableKey(key)) {
        throw new Error(`"${key}" cannot be set here. Allowed: port, listenOnLan, allowedHosts, comfy.args, defaults.<name>, tokens.<name>`);
      }
      const value = parseSettingValue(key, raw);
      saveConfig(getPaths(), patchFromPath(key, value));
      const shown = SECRET_KEY.test(key) ? (value ? 'set' : 'not set') : showValue(value);
      ui.ok(`${key} = ${shown}`);
      ui.info('  Restart Embernest for this to take effect (embernest stop, then embernest start).');
    });
}

module.exports = { register, showValue };
