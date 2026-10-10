'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Settings schema. Path-dependent values (comfy.dir, comfy.python)
 * are left empty here; setup fills them in once the data folder is known.
 */
const DEFAULTS = {
  configVersion: 1,
  port: 3000,
  listenOnLan: true,
  allowedHosts: [],
  authToken: '',
  comfy: {
    mode: 'managed',
    url: 'http://127.0.0.1:8188',
    port: 8188,
    dir: '',
    python: '',
    args: [],
    version: '',
  },
  hardware: {},
  chat: {
    enabled: false,
    model: '',
    thinkModel: '',
    port: 8189,
    url: 'http://127.0.0.1:8189',
    device: 'auto',
    contextSize: 8192,
    threads: 0,
    search: { provider: 'auto', searxngUrl: '' },
  },
  tokens: { civitai: '', hf: '' },
  defaults: {
    denoise: 0.9,
    steps: 28,
    cfg: 7,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    seed: -1,
    maxSize: 768,
    preserveFace: true,
    restoreSize: true,
  },
};

/**
 * A fresh copy of DEFAULTS, so callers that mutate a loaded config never change
 * the shared defaults.
 * @returns {object}
 */
function defaults() {
  return structuredClone(DEFAULTS);
}

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep merge: objects merge key by key, everything else (including arrays)
 * is replaced by the override value.
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
function merge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    const value = override[key];
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key])
      ? merge(base[key], value)
      : value;
  }
  return out;
}

/**
 * Write a file atomically with owner-only permissions: write `<file>.tmp`,
 * then rename it over the target.
 * @param {string} file
 * @param {string} text
 */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    // Windows ignores POSIX modes; a read-only fs is not fatal for settings.
  }
}

/**
 * Read config.json merged over DEFAULTS. A missing file returns DEFAULTS and
 * writes nothing. A corrupt file throws, so secrets are never silently replaced.
 * @param {{ config: string }} paths result of getPaths()
 * @returns {object}
 */
function loadConfig(paths) {
  if (!fs.existsSync(paths.config)) return defaults();
  const raw = fs.readFileSync(paths.config, 'utf8');
  return merge(defaults(), JSON.parse(raw));
}

/**
 * Deep-merge a patch into the current config and write it (mode 0600).
 * @param {{ config: string }} paths
 * @param {object} patch
 * @returns {object} the config as written
 */
function saveConfig(paths, patch) {
  const next = merge(loadConfig(paths), patch);
  writeAtomic(paths.config, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * A random 64-character hex token for authToken.
 * @returns {string}
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Map a v0.1 config (flat keys) to the v2 schema. Keys not in the v2 schema
 * (comfyRestartCommand, allowComfyRestart, ...) are dropped.
 * @param {object} oldConfig
 * @returns {object} a full config built on DEFAULTS
 */
function migrateLegacy(oldConfig) {
  const old = oldConfig || {};
  const mapped = {};
  for (const key of ['port', 'listenOnLan', 'tokens', 'defaults']) {
    if (old[key] !== undefined) mapped[key] = old[key];
  }
  if (old.comfyUrl !== undefined) mapped.comfy = { url: old.comfyUrl };
  if (old.sharedToken !== undefined) mapped.authToken = old.sharedToken;
  return merge(defaults(), mapped);
}

/**
 * Copy of config with secrets replaced by 'set' / 'not set', safe to log.
 * @param {object} config
 * @returns {object}
 */
function redact(config) {
  const mark = (v) => (v ? 'set' : 'not set');
  const out = { ...config, authToken: mark(config.authToken) };
  out.tokens = Object.fromEntries(
    Object.entries(config.tokens || {}).map(([k, v]) => [k, mark(v)]),
  );
  return out;
}

/** Keys `config set` may change. `defaults.*` and `tokens.*` take their own sub-keys. */
const SETTABLE_KEYS = ['port', 'listenOnLan', 'allowedHosts', 'comfy.args'];
const SETTABLE_GROUPS = ['defaults', 'tokens'];

/**
 * Whether `config set` may write this dotted key.
 * @param {string} key e.g. 'port', 'defaults.steps', 'tokens.civitai'
 * @returns {boolean}
 */
function isSettableKey(key) {
  if (SETTABLE_KEYS.includes(key)) return true;
  const [group, sub, ...rest] = String(key).split('.');
  return SETTABLE_GROUPS.includes(group) && rest.length === 0 && Boolean(sub)
    && Object.prototype.hasOwnProperty.call(DEFAULTS[group], sub);
}

/**
 * Read a dotted key ("comfy.url") from an object. Undefined when missing.
 * @param {object} obj
 * @param {string} key
 * @returns {*}
 */
function getByPath(obj, key) {
  return key.split('.').reduce((node, part) => (isPlainObject(node) ? node[part] : undefined), obj);
}

/**
 * Build a nested patch from a dotted key: 'defaults.steps', 5 → { defaults: { steps: 5 } }.
 * @param {string} key
 * @param {*} value
 * @returns {object}
 */
function patchFromPath(key, value) {
  return key.split('.').reduceRight((inner, part) => ({ [part]: inner }), value);
}

/** Default value for a settable key, used to know what type to parse. */
function defaultFor(key) {
  return getByPath(DEFAULTS, key);
}

/**
 * Turn the text the user typed into a value of the right type for `key`.
 * Numbers and booleans are parsed as JSON. Array keys take a JSON array or a
 * comma-separated list. String keys are kept as typed (so "123" stays a string).
 * @param {string} key a settable key
 * @param {string} raw
 * @returns {*} the parsed value
 * @throws {Error} when the text does not fit the key's type
 */
function parseSettingValue(key, raw) {
  const sample = defaultFor(key);
  const text = String(raw).trim();
  if (typeof sample === 'string') return text;
  if (Array.isArray(sample)) {
    if (text.startsWith('[')) {
      const list = parseJsonOr(text, `${key} must be a JSON array or a comma-separated list`);
      if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
        throw new Error(`${key} must be a list of strings`);
      }
      return list;
    }
    return text.split(',').map((v) => v.trim()).filter(Boolean);
  }
  const value = parseJsonOr(text, `${key} must be a ${typeof sample}`);
  if (typeof value !== typeof sample || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`${key} must be a ${typeof sample}`);
  }
  if (key === 'port' && !(Number.isInteger(value) && value >= 1 && value <= 65535)) {
    throw new Error('port must be a whole number from 1 to 65535');
  }
  return value;
}

/** JSON.parse that reports `message` instead of the parser's error. */
function parseJsonOr(text, message) {
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(message);
  }
}

module.exports = {
  DEFAULTS, loadConfig, saveConfig, generateToken, migrateLegacy, redact,
  isSettableKey, getByPath, patchFromPath, parseSettingValue,
};
