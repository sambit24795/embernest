/**
 * model-meta.js — remember what each installed model is (type, base family,
 * inpainting, trigger words) so the UI can guide the user.
 *
 * Sources, best first: what the download item told us ("download"), the
 * safetensors header ("header": tensor names/shapes and __metadata__), and the
 * file name ("guess"). Only the header is ever read, never tensor data.
 *
 * The store is one JSON file, <models>/.pixelkiln-meta.json. It is a cache: a
 * corrupt or unreadable file is simply rebuilt by the next scan.
 */
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { readJson, writeJson } = require('../core/state');

const META_FILE = '.pixelkiln-meta.json';
/** Safetensors headers above this are rejected (a real one is well under 10 MB). */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;
const FAMILIES = ['sd15', 'sdxl', 'pony', 'illustrious', 'flux', 'unknown'];
const BASE_LABEL = {
  sd15: 'SD 1.5', sdxl: 'SDXL 1.0', pony: 'Pony', illustrious: 'Illustrious', flux: 'Flux.1',
};
/** Families that share the SDXL architecture (LoRAs usually load, results vary). */
const SDXL_ARCH = new Set(['sdxl', 'pony', 'illustrious']);
const MODEL_EXTS = new Set(['.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.bin']);
/** models/<folder> -> canonical type, for the folders we describe. */
const TYPE_BY_FOLDER = {
  checkpoints: 'checkpoint',
  loras: 'lora',
  vae: 'vae',
  embeddings: 'embedding',
  controlnet: 'controlnet',
  upscale_models: 'upscaler',
  background_removal: 'background_removal',
  detection: 'detection',
};
/** Folders whose header we read; the rest only get a type. */
const HEADER_TYPES = new Set(['checkpoint', 'lora', 'embedding']);

// ---------------------------------------------------------------------------
// Header reading
// ---------------------------------------------------------------------------

/**
 * Read a safetensors header: 8-byte little-endian length, then that many bytes
 * of JSON. Tensor data is never read.
 * @param {string} file
 * @returns {Promise<{ tensors: Record<string, { shape?: number[], dtype?: string }>, metadata: Record<string, string> }>}
 */
async function readSafetensorsHeader(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const lenBuf = Buffer.alloc(8);
    const got = await fh.read(lenBuf, 0, 8, 0);
    if (got.bytesRead < 8) throw new Error('file too small for a safetensors header');
    const len = Number(lenBuf.readBigUInt64LE());
    if (len < 2 || len > MAX_HEADER_BYTES) throw new Error(`implausible header size ${len}`);
    if (8 + len > size) throw new Error('header runs past the end of the file');
    const buf = Buffer.alloc(len);
    const read = await fh.read(buf, 0, len, 8);
    if (read.bytesRead < len) throw new Error('truncated header');
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('header is not an object');
    const { __metadata__: meta, ...tensors } = parsed;
    const metadata = {};
    if (meta && typeof meta === 'object') {
      for (const [k, v] of Object.entries(meta)) if (typeof v === 'string') metadata[k] = v;
    }
    return { tensors, metadata };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Map a base-model string (Civitai "SD 1.5", kohya "sdxl_base_v1-0",
 * modelspec "stable-diffusion-xl-v1-base", a file name…) to a family.
 * @param {unknown} text
 * @returns {'sd15'|'sdxl'|'pony'|'illustrious'|'flux'|'unknown'}
 */
function familyFromText(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return 'unknown';
  if (/pony|score_9/.test(s)) return 'pony';
  if (/illustrious|noobai|noob-ai/.test(s)) return 'illustrious';
  if (/flux/.test(s)) return 'flux';
  if (/sdxl|sd[\s_-]?xl|stable[\s_-]?diffusion[\s_-]?xl/.test(s)) return 'sdxl';
  if (/sd[\s_-]?(2|3)|stable[\s_-]?diffusion[\s_-]?(v?2|3)/.test(s)) return 'unknown';
  if (/(^|[^a-z])sd[\s_-]?v?1|sd15|stable[\s_-]?diffusion[\s_-]?v?1|(^|[^0-9])1\.[45]($|[^0-9])/.test(s)) return 'sd15';
  return 'unknown';
}

/** Context width of the first cross-attention key projection: 768 = SD 1.5, 2048 = SDXL. */
function contextWidthFamily(tensors, keys, loraStyle) {
  const re = loraStyle ? /attn2[._]to_k.*(lora_down|lora_A)/ : /attn2\.to_k\.weight$/;
  const key = keys.find((k) => re.test(k));
  const shape = key && tensors[key] && tensors[key].shape;
  if (!Array.isArray(shape) || shape.length < 2) return 'unknown';
  if (shape[1] === 768) return 'sd15';
  if (shape[1] === 2048) return 'sdxl';
  return 'unknown';
}

/** Architecture family from tensor names/shapes alone (sd15 | sdxl | flux | unknown). */
function archFromTensors(type, tensors) {
  const keys = Object.keys(tensors);
  const has = (re) => keys.some((k) => re.test(k));
  if (type === 'checkpoint') {
    if (has(/(^|\.)double_blocks\./) && has(/(^|\.)single_blocks\./)) return 'flux';
    if (has(/conditioner\.embedders\.1/) || has(/diffusion_model\.label_emb\.0\.0\.weight$/)) return 'sdxl';
    if (has(/^cond_stage_model\.transformer\.text_model/)) return 'sd15';
    if (has(/^cond_stage_model\.model\./)) return 'unknown'; // SD 2.x
    return contextWidthFamily(tensors, keys, false);
  }
  if (type === 'lora') {
    if (has(/double_blocks|single_blocks|single_transformer_blocks/)) return 'flux';
    if (has(/lora_te2_|text_encoder_2/)) return 'sdxl';
    const byShape = contextWidthFamily(tensors, keys, true);
    if (byShape !== 'unknown') return byShape;
    if (has(/^lora_te_/)) return 'sd15'; // SDXL names its text encoders lora_te1_/lora_te2_
    return 'unknown';
  }
  if (type === 'embedding') {
    if (tensors.clip_g && tensors.clip_l) return 'sdxl';
    const first = tensors.emb_params || tensors.clip_l || Object.values(tensors)[0];
    const width = first && Array.isArray(first.shape) ? first.shape[first.shape.length - 1] : 0;
    return width === 768 ? 'sd15' : 'unknown';
  }
  return 'unknown';
}

/** True when the checkpoint's first UNet conv takes 9 channels (latent + mask + masked image). */
function inpaintingFromTensors(tensors) {
  for (const [k, t] of Object.entries(tensors)) {
    if (k.startsWith('first_stage_model.')) continue;
    if (/(^|\.)input_blocks\.0\.0\.weight$/.test(k) || /(^|\.)unet\.conv_in\.weight$/.test(k)
      || /^conv_in\.weight$/.test(k)) {
      return Array.isArray(t.shape) && t.shape[1] === 9;
    }
  }
  return false;
}

/** Text hints (file name + training metadata) used to tell Pony/Illustrious from plain SDXL. */
function hintText(fileName, metadata) {
  const keys = ['ss_base_model_version', 'ss_sd_model_name', 'ss_output_name', 'modelspec.title',
    'modelspec.architecture', 'modelspec.description'];
  const parts = [fileName, ...keys.map((k) => metadata[k])];
  if (/score_9/.test(metadata.ss_tag_frequency || '')) parts.push('pony');
  return parts.filter(Boolean).join(' ');
}

/** Pull an SDXL-architecture refinement (pony/illustrious) out of hint text, else keep sdxl. */
function refineSdxl(fileName, metadata) {
  const f = familyFromText(hintText(fileName, metadata));
  return f === 'pony' || f === 'illustrious' ? f : 'sdxl';
}

/**
 * Describe a model from its parsed header.
 * @param {{ type: string, fileName: string, header: { tensors: object, metadata: Record<string,string> } }} o
 * @returns {{ family: string, baseModel: string|null, inpainting: boolean, source: 'header' }}
 */
function inferFromHeader({ type, fileName, header }) {
  const { tensors, metadata } = header;
  let family = archFromTensors(type, tensors);
  if (family === 'unknown') {
    // Tensors didn't say; trust what the trainer or author wrote.
    family = familyFromText(`${metadata.ss_base_model_version || ''} ${metadata['modelspec.architecture'] || ''}`);
  }
  if (family === 'sdxl') family = refineSdxl(fileName, metadata);
  const inpainting = type === 'checkpoint' && inpaintingFromTensors(tensors);
  return {
    family,
    baseModel: BASE_LABEL[family] || null,
    inpainting,
    source: 'header',
  };
}

/**
 * Best effort from the file name alone (non-safetensors files, or unreadable headers).
 * @param {string} fileName
 * @returns {{ family: string, baseModel: string|null, inpainting: boolean, source: 'guess' }}
 */
function inferFromName(fileName) {
  const family = familyFromText(fileName);
  return {
    family,
    baseModel: BASE_LABEL[family] || null,
    inpainting: /inpaint/i.test(fileName),
    source: 'guess',
  };
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/**
 * Will this LoRA work with this checkpoint? Same family is a yes; different
 * architectures (SD 1.5 vs SDXL vs Flux) are a no; anything unclear is unknown.
 * @param {{ family?: string|null }|null|undefined} checkpointMeta
 * @param {{ family?: string|null }|null|undefined} loraMeta
 * @returns {'yes'|'no'|'unknown'}
 */
function compatible(checkpointMeta, loraMeta) {
  const a = checkpointMeta && checkpointMeta.family;
  const b = loraMeta && loraMeta.family;
  if (!FAMILIES.includes(a) || !FAMILIES.includes(b) || a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === b) return 'yes';
  if (SDXL_ARCH.has(a) && SDXL_ARCH.has(b)) return 'unknown'; // same architecture, different training base
  return 'no';
}

// ---------------------------------------------------------------------------
// Download metadata
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Clean the metadata a client sends with a download (never trust the body).
 * @param {object} raw
 * @returns {object|null} null when there is nothing useful
 */
function sanitizeDownloadMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const words = Array.isArray(raw.triggerWords) ? raw.triggerWords : [];
  const triggerWords = [...new Set(words.map((w) => str(w, 100)).filter(Boolean))].slice(0, 40);
  const strength = Number(raw.recommendedStrength);
  const homeUrl = str(raw.homeUrl, 500);
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : [];
  return {
    name: str(raw.name, 200),
    baseModel: str(raw.baseModel, 80),
    provider: str(raw.provider, 40),
    homeUrl: homeUrl && /^https?:\/\//i.test(homeUrl) ? homeUrl : null,
    triggerWords,
    recommendedStrength: Number.isFinite(strength) && strength > 0 && strength <= 2 ? strength : null,
    inpainting: raw.inpainting === true || /inpaint/i.test(`${raw.name || ''} ${tags.join(' ')}`),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Complete an entry so every documented field exists (null when unknown). */
function publicEntry(e) {
  return {
    type: e.type || null,
    baseModel: e.baseModel || null,
    family: e.family || 'unknown',
    inpainting: e.inpainting === true,
    triggerWords: Array.isArray(e.triggerWords) ? e.triggerWords : [],
    recommendedStrength: typeof e.recommendedStrength === 'number' ? e.recommendedStrength : null,
    name: e.name || null,
    provider: e.provider || null,
    homeUrl: e.homeUrl || null,
    source: e.source || null,
  };
}

/** Walk <modelsDir>/<folder> (real subfolders only) and yield model files. */
async function* walkFolder(root, rel = '', depth = 0) {
  let entries;
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && depth < 3) {
      yield* walkFolder(root, relPath, depth + 1);
    } else if ((e.isFile() || e.isSymbolicLink()) && MODEL_EXTS.has(path.extname(e.name).toLowerCase())) {
      yield relPath;
    }
  }
}

/**
 * Metadata store for one models folder.
 * @param {string} modelsDir
 */
function createMetaStore(modelsDir) {
  const file = path.join(modelsDir, META_FILE);
  /** @type {Record<string, object>} */
  let data = {};
  let loaded = false;
  let scanning = null;
  let dirty = false;

  function load() {
    if (loaded) return;
    loaded = true;
    const raw = readJson(file, null);
    // Anything but a plain object (missing, corrupt, hand-edited) is rebuilt by the next scan.
    data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    for (const [k, v] of Object.entries(data)) if (!v || typeof v !== 'object') delete data[k];
  }

  async function save() {
    if (!dirty) return;
    dirty = false;
    try {
      await fsp.access(modelsDir);
      writeJson(file, data, { mode: 0o600 });
    } catch { /* a missing/read-only models folder must never break anything */ }
  }

  /** Header (or name) description of one file. */
  async function describe(folder, rel) {
    const type = TYPE_BY_FOLDER[folder];
    const fileName = path.basename(rel);
    if (!HEADER_TYPES.has(type)) return { type, family: 'unknown', baseModel: null, inpainting: false, source: 'guess' };
    if (path.extname(fileName).toLowerCase() === '.safetensors' || path.extname(fileName).toLowerCase() === '.sft') {
      try {
        const header = await readSafetensorsHeader(path.join(modelsDir, folder, rel));
        return { type, ...inferFromHeader({ type, fileName, header }) };
      } catch { /* fall through to the name */ }
    }
    return { type, ...inferFromName(fileName) };
  }

  /** Merge download-provided metadata over a described file. */
  function mergeDownload(described, dl) {
    const dlFamily = familyFromText(dl.baseModel);
    const family = described.family !== 'unknown' ? described.family : dlFamily;
    return {
      ...described,
      family,
      baseModel: dl.baseModel || described.baseModel,
      inpainting: described.inpainting || dl.inpainting === true,
      triggerWords: dl.triggerWords || [],
      recommendedStrength: dl.recommendedStrength ?? null,
      name: dl.name || null,
      provider: dl.provider || null,
      homeUrl: dl.homeUrl || null,
      source: 'download',
    };
  }

  async function statOf(abs) {
    const st = await fsp.stat(abs);
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  }

  async function scanOnce() {
    load();
    const seen = new Set();
    let sinceSave = 0;
    for (const folder of Object.keys(TYPE_BY_FOLDER)) {
      for await (const rel of walkFolder(path.join(modelsDir, folder))) {
        const key = `${folder}/${rel}`;
        seen.add(key);
        let st;
        try { st = await statOf(path.join(modelsDir, key)); } catch { continue; } // dangling link
        const old = data[key];
        if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) continue; // cached
        let entry = await describe(folder, rel);
        if (old && old.source === 'download') {
          // The file changed under a downloaded entry; keep what the provider told us.
          entry = mergeDownload(entry, old);
        }
        data[key] = { ...entry, size: st.size, mtimeMs: st.mtimeMs };
        dirty = true;
        sinceSave += 1;
        if (sinceSave >= 50) { sinceSave = 0; await save(); }
      }
    }
    for (const key of Object.keys(data)) {
      if (!seen.has(key)) { delete data[key]; dirty = true; }
    }
    await save();
  }

  return {
    file,
    /**
     * Scan the models folders in the background; later calls share the running scan.
     * Never rejects.
     * @returns {Promise<void>}
     */
    scan() {
      if (!scanning) {
        scanning = scanOnce().catch(() => {}).finally(() => { scanning = null; });
      }
      return scanning;
    },
    /** True while a scan is running (the data may be partial). */
    get scanning() { return scanning !== null; },
    /**
     * Metadata for one file key like "loras/foo.safetensors", or null.
     * @param {string} key
     */
    get(key) {
      load();
      return data[key] ? publicEntry(data[key]) : null;
    },
    /** All entries keyed by "folder/relative/path". */
    all() {
      load();
      return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, publicEntry(v)]));
    },
    /**
     * Record a finished download. Header facts fill what the provider left out.
     * Never throws.
     * @param {string} folder  models subfolder, e.g. "loras"
     * @param {string} fileName
     * @param {object} rawMeta  metadata from the search item
     */
    async recordDownload(folder, fileName, rawMeta) {
      try {
        load();
        const dl = sanitizeDownloadMeta(rawMeta);
        if (!dl || !TYPE_BY_FOLDER[folder]) return;
        const key = `${folder}/${fileName}`;
        const st = await statOf(path.join(modelsDir, key));
        const entry = mergeDownload(await describe(folder, fileName), dl);
        data[key] = { ...entry, size: st.size, mtimeMs: st.mtimeMs };
        dirty = true;
        await save();
      } catch { /* the download itself already succeeded */ }
    },
  };
}

const stores = new Map();

/**
 * Shared store per models folder (one scan cache per process).
 * @param {string} modelsDir
 */
function getMetaStore(modelsDir) {
  const dir = path.resolve(modelsDir);
  if (!stores.has(dir)) stores.set(dir, createMetaStore(dir));
  return stores.get(dir);
}

module.exports = {
  META_FILE,
  MAX_HEADER_BYTES,
  FAMILIES,
  readSafetensorsHeader,
  familyFromText,
  inferFromHeader,
  inferFromName,
  compatible,
  sanitizeDownloadMeta,
  createMetaStore,
  getMetaStore,
};
