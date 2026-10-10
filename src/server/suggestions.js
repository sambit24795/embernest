'use strict';
/**
 * suggestions.js — the curated model list (src/install/suggestions.json),
 * filtered for a machine and marked with what is already installed.
 * Embernest only suggests these; the user decides what to download.
 */
const fs = require('node:fs');
const path = require('node:path');
const { FOLDER_BY_TYPE } = require('./downloads');

const FILE = path.join(__dirname, '..', 'install', 'suggestions.json');
const TIER_ORDER = ['cpu', 'tiny', 'low', 'mid', 'high', 'ultra'];
const GOALS = ['edit-photos', 'realistic', 'anime', 'faces-skin', 'quality'];
const TYPES = ['checkpoint', 'lora', 'embedding', 'vae'];
const FAMILIES = ['sd15', 'sdxl', 'pony', 'illustrious', 'flux'];

/**
 * Load the curated list.
 * @returns {{ goals: Record<string,string>, suggestions: object[] }}
 */
function loadSuggestions() {
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

/**
 * Entries that fit a hardware tier: the tier is at least the entry's minTier.
 * @param {object[]} entries
 * @param {string} tierId cpu | tiny | low | mid | high | ultra
 * @returns {object[]}
 */
function forTier(entries, tierId) {
  const have = TIER_ORDER.indexOf(tierId);
  return entries.filter((e) => have >= TIER_ORDER.indexOf(e.minTier));
}

/**
 * Copy entries with `installed: true` when a file of that name is in the
 * matching models folder.
 * @param {object[]} entries
 * @param {Record<string, Array<{ name: string }>>} folders result of downloads.listInstalled()
 * @returns {object[]}
 */
function markInstalled(entries, folders) {
  return entries.map((e) => {
    const files = (folders && folders[FOLDER_BY_TYPE[e.type]]) || [];
    return { ...e, installed: files.some((f) => f.name === e.fileName) };
  });
}

module.exports = { loadSuggestions, forTier, markInstalled, TIER_ORDER, GOALS, TYPES, FAMILIES };
