'use strict';

/**
 * gallery-store.js — a persistent index of finished results, so the Gallery
 * survives engine restarts (ComfyUI's /history is in memory only).
 *
 * The index holds metadata and image file names, never pixels. Managed mode
 * keeps it at <data>/gallery.json; external mode at <comfy.dir>/output/
 * .embernest-gallery.json. If that file can't be written the store carries on
 * in memory only (and ComfyUI's live history still fills the gallery).
 */
const fsp = require('fs/promises');
const path = require('path');
const { readJson, writeJson } = require('../core/state');
const { modeFromFilename, extractFromGraph, graphOf, createdAtOf } = require('./historyMeta');
const { readEmbeddedGraph } = require('./png-meta');

const MAX_ENTRIES = 5000; // oldest are forgotten from the index (files stay on disk)
const OUR_FILES = /^(embernest|pixelkiln)[_.].*\.(png|jpe?g|webp)$/i;

/** Output-type images of a ComfyUI history entry (all nodes). */
function outputImages(entry) {
  const outputs = (entry && entry.outputs) || {};
  return Object.values(outputs)
    .flatMap((o) => (o && o.images) || [])
    .filter((i) => i && i.filename && (i.type || 'output') === 'output');
}

/** Entry from a ComfyUI history entry (output images only), or null without images. */
function entryFromHistory(promptId, entry, { source = 'job', mode = null, createdAt = null } = {}) {
  const images = outputImages(entry)
    .map((i) => ({ filename: i.filename, subfolder: i.subfolder || '', type: 'output' }));
  if (!images.length) return null;
  const meta = extractFromGraph(graphOf(entry));
  return {
    id: promptId,
    mode: mode || modeFromFilename(images[0].filename),
    prompt: meta.prompt,
    settings: meta.settings,
    before: meta.before,
    images,
    createdAt: createdAt || createdAtOf(entry) || Date.now(),
    source,
  };
}

const keyOf = (img) => `${img.subfolder || ''}/${img.filename}`;

/**
 * @param {{ file: string|null }} o file of the index; null = in memory only
 */
function createGalleryStore({ file }) {
  let persist = Boolean(file);
  let items = [];

  const loaded = file ? readJson(file, null) : null;
  if (loaded && Array.isArray(loaded.items)) {
    items = loaded.items.filter((e) => e && typeof e.id === 'string' && Array.isArray(e.images) && e.images.length);
  } // a missing or corrupt file starts empty; the startup scan rebuilds it

  function save() {
    if (!persist) return;
    try {
      writeJson(file, { version: 1, items }, { mode: 0o600 });
    } catch (err) {
      persist = false; // read-only folder: keep going in memory
      console.warn(`[gallery] cannot write the index (${err.code || err.message}); keeping it in memory`);
    }
  }

  function addNoSave(entry) {
    const keys = new Set(entry.images.map(keyOf));
    // The same file can arrive by scan and by job completion: keep the newer record.
    items = items.filter((e) => e.id !== entry.id && !e.images.some((i) => keys.has(keyOf(i))));
    items.push(entry);
    if (items.length > MAX_ENTRIES) {
      items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      items = items.slice(items.length - MAX_ENTRIES);
    }
  }

  return {
    get persistent() { return persist; },
    has: (id) => items.some((e) => e.id === id),
    get: (id) => items.find((e) => e.id === id) || null,
    hasFile: (img) => items.some((e) => e.images.some((i) => keyOf(i) === keyOf(img))),
    size: () => items.length,

    /** Add or replace entries. Falsy entries are ignored. */
    add(...entries) {
      let n = 0;
      for (const e of entries) if (e) { addNoSave(e); n += 1; }
      if (n) save();
      return n;
    },

    remove(id) {
      const before = items.length;
      items = items.filter((e) => e.id !== id);
      if (items.length !== before) save();
      return items.length !== before;
    },

    /**
     * One page, newest first. Entries whose first file is gone from `outputRoot`
     * are dropped from the index as they are met.
     * @returns {Promise<{items: object[], total: number}>}
     */
    async list({ mode = null, offset = 0, limit = 12, outputRoot = null, isHidden = () => false } = {}) {
      const sorted = items
        .filter((e) => (!mode || e.mode === mode) && !isHidden(e))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const page = [];
      const gone = new Set();
      let seen = 0;
      for (const e of sorted) {
        if (page.length >= limit) break;
        if (outputRoot && !(await exists(outputRoot, e.images[0]))) { gone.add(e.id); continue; }
        if (seen >= offset) page.push(e);
        seen += 1;
      }
      if (gone.size) { items = items.filter((e) => !gone.has(e.id)); save(); }
      const total = items.filter((e) => (!mode || e.mode === mode) && !isHidden(e)).length;
      return { items: page, total };
    },

    /**
     * Index image files in the output folder that carry our prefixes and are
     * not indexed yet; drop entries whose files are gone.
     * @param {string|null} outputRoot
     * @param {{ isHeldImage?: Function, checkedBusy?: Function }} [hooks]
     * @returns {Promise<{added: number, removed: number}>}
     */
    async scan(outputRoot, { isHeldImage = () => false, checkedBusy = () => false } = {}) {
      if (!outputRoot) return { added: 0, removed: 0 };
      let names;
      try { names = await fsp.readdir(outputRoot); } catch { return { added: 0, removed: 0 }; }
      const present = new Set(names);

      const stale = items.filter((e) => e.images[0].subfolder === '' && !present.has(e.images[0].filename)).map((e) => e.id);
      for (const id of stale) items = items.filter((e) => e.id !== id);

      let added = 0;
      for (const name of names.filter((n) => OUR_FILES.test(n)).sort()) {
        const img = { filename: name, subfolder: '', type: 'output' };
        if (this.hasFile(img) || isHeldImage(img)) continue;
        const mode = modeFromFilename(name);
        // A photo edit may still be waiting for its safety check: leave it to the job.
        if (mode !== 'generate' && checkedBusy()) continue;
        const full = path.join(outputRoot, name);
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        if (!st.isFile() || this.hasFile(img)) continue;
        const meta = extractFromGraph((/\.png$/i.test(name) && await readEmbeddedGraph(full)) || {});
        addNoSave({
          id: `scan:${name}`, mode, prompt: meta.prompt, settings: meta.settings, before: meta.before,
          images: [img], createdAt: Math.round(st.mtimeMs), source: 'scan',
        });
        added += 1;
      }
      if (added || stale.length) save();
      return { added, removed: stale.length };
    },
  };
}

async function exists(root, img) {
  try {
    await fsp.stat(path.join(root, img.subfolder || '', img.filename));
    return true;
  } catch {
    return false;
  }
}

/** Where the index lives, or null when external mode has no writable-by-us folder known. */
function galleryFile(paths, cfg) {
  if (cfg.comfy.mode !== 'external') return path.join(paths.data, 'gallery.json');
  return cfg.comfy.dir ? path.join(cfg.comfy.dir, 'output', '.embernest-gallery.json') : null;
}

module.exports = { createGalleryStore, entryFromHistory, galleryFile, outputImages };
