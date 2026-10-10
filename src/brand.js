'use strict';
/**
 * Single source of truth for the product name. The legacy block keeps installs
 * made under the old name (PixelKiln) working: data folder, env vars, command.
 */
const brand = {
  name: 'Embernest',
  cli: 'embernest',
  envPrefix: 'EMBERNEST',
  dataDirName: { linux: 'embernest', mac: 'Embernest', win: 'Embernest' },
  legacy: {
    cli: 'pixelkiln',
    envPrefix: 'PIXELKILN',
    dataDirName: { linux: 'pixelkiln', mac: 'PixelKiln', win: 'PixelKiln' },
  },
  repo: 'sambit24795/embernest',
};

/**
 * Read an env setting by suffix: EMBERNEST_<suffix>, else PIXELKILN_<suffix>.
 * @param {string} suffix e.g. 'HOME'
 * @param {object} [env]
 * @returns {string|undefined}
 */
function getEnv(suffix, env = process.env) {
  const v = env[`${brand.envPrefix}_${suffix}`];
  if (v !== undefined && v !== '') return v;
  return env[`${brand.legacy.envPrefix}_${suffix}`];
}

module.exports = { ...brand, getEnv };
