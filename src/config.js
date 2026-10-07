/**
 * config.js — load/save the local config.json.
 *
 * All machine-specific settings and API tokens live in config.json. That file
 * is gitignored so secrets never end up in the repo. If it's missing we create
 * it from DEFAULTS on first run.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// Everything the app understands, with safe defaults.
const DEFAULTS = {
  comfyUrl: 'http://127.0.0.1:8188',
  port: 3000,
  listenOnLan: true,
  // Optional: a shell command that stops (if needed) and starts ComfyUI.
  // Only run when allowComfyRestart is true.
  comfyRestartCommand: '',
  allowComfyRestart: false,
  tokens: {
    civitai: '',
    hf: '',
    modelscope: '',
    github: '',
  },
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

/** Simple deep merge: values from `override` win, missing keys fall back. */
function merge(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    const value = override[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = merge(base[key] || {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** Write config.json with owner-only permissions (it may hold API tokens). */
function writeConfigFile(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  // The mode above only applies on create; tighten an existing file too.
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) { /* Windows / read-only fs */ }
}

/** Read config.json, creating it from defaults if it does not exist. */
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) { /* best effort */ }
    return merge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    // Missing or unreadable -> write a fresh defaults file (ignoring failures).
    try {
      writeConfigFile(DEFAULTS);
    } catch (_) {
      /* e.g. read-only filesystem — still run with in-memory defaults */
    }
    return { ...DEFAULTS };
  }
}

/** Persist a partial config update (used by the Settings tab). */
function saveConfig(patch) {
  const next = merge(loadConfig(), patch);
  writeConfigFile(next);
  return next;
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULTS };
