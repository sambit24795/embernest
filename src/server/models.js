/**
 * models.js — aggregate model search across Civitai and HuggingFace,
 * normalize to one shape, and tag each result with a "fits your GPU" verdict.
 *
 * Both providers are public REST APIs. Tokens (Civitai NSFW, gated HF repos)
 * come from config.json and are only ever sent to their own host.
 */
'use strict';

const CIVITAI_BASE = 'https://civitai.com/api/v1';
const HF_BASE = 'https://huggingface.co';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** fetch JSON with a timeout, a descriptive User-Agent and clear errors. */
async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Embernest/0.1 (local personal use)',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `fn` over `items` with at most `limit` concurrent calls. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Strip HTML tags from Civitai descriptions. */
function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Lowercase text, splitting camelCase and separators into words (for tag matching). */
function flattenText(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Map a provider's raw type string to our canonical type. */
function normalizeType(raw) {
  const s = String(raw || '').toLowerCase();
  if (/checkpoint|ckpt/.test(s)) return 'checkpoint';
  if (/lora|locon|lycoris|dora/.test(s)) return 'lora';
  if (/\bvae\b/.test(s)) return 'vae';
  if (/control/.test(s)) return 'controlnet';
  if (/upscal|esrgan/.test(s)) return 'upscaler';
  if (/embedding|textualinversion/.test(s)) return 'embedding';
  return 'other';
}

// ---------------------------------------------------------------------------
// "Fits your GPU" verdict
// ---------------------------------------------------------------------------

// Rough VRAM each architecture family needs to generate at its native size.
// (SD 1.5 is fine on ~4GB+, SDXL wants ~8GB, Flux wants ~10-12GB.)
const FAMILIES = [
  { re: /flux.*(d|dev)/i, vram: 12, label: 'Flux.1 D' },
  { re: /flux/i, vram: 10, label: 'Flux' },
  { re: /sd\s*3|stable\s*diffusion\s*3/i, vram: 12, label: 'SD3' },
  { re: /sdxl|sd\s*xl|pony|illustrious|noobai/i, vram: 8, label: 'SDXL family' },
  { re: /sd\s*2|stable\s*diffusion\s*2/i, vram: 5, label: 'SD2' },
  { re: /sd\s*1|stable\s*diffusion\s*1|1\.5|1\.4/i, vram: 4, label: 'SD1.5' },
];

function familyFor(baseModel) {
  const s = String(baseModel || '');
  for (const family of FAMILIES) if (family.re.test(s)) return family;
  return null;
}

// Distilled / few-step variants (Hyper-SD, Turbo, LCM, Lightning, DMD) run
// very fast but fill masked regions poorly — important for inpainting/editing.
// Note: `hyper` alone is NOT matched because "hyper-realistic" is a style tag,
// not a speed model.
const DISTILLED_RE = /\b(turbo|lcm|lightning|dmd2?|distilled)\b|hyper[\s-]?sd/i;

/** True when the model is a speed-distilled variant (weak for inpainting). */
function isDistilled(item) {
  const haystack = [item.name, item.baseModel, ...(item.tags || [])]
    .filter(Boolean).join(' ');
  return DISTILLED_RE.test(haystack);
}

/**
 * @param {object} item normalized model
 * @param {{vramGB:number, ramGB:number}} system
 * @returns {{level:'good'|'tight'|'no'|'unknown', label:string, reason:string, distilled:boolean, note?:string}}
 */
function gpuFit(item, system = {}) {
  const vram = system.vramGB || 0;
  const ramMB = (system.ramGB || 0) * 1024;
  const sizeMB = item.fileSizeMB;
  const family = familyFor(item.baseModel);

  let level;
  let reason;
  if (family) {
    if (vram >= family.vram + 1.5) level = 'good';
    else if (vram >= family.vram) level = 'tight';
    else level = 'no';
    reason = `${family.label} needs ~${family.vram}GB VRAM`;
  } else if (['lora', 'embedding', 'vae'].includes(item.type)) {
    // Small add-ons mostly ride along with whatever base model is loaded.
    level = sizeMB == null || sizeMB < 2048 ? 'good' : 'tight';
    reason = 'Add-on; limited extra VRAM needed';
  } else {
    level = 'unknown';
    reason = 'Unknown base model';
  }

  // A file that cannot comfortably sit in RAM is a problem regardless of GPU.
  if (sizeMB != null && ramMB > 0 && sizeMB > ramMB * 0.8 && level !== 'no') {
    level = sizeMB > ramMB ? 'no' : 'tight';
    reason = `${Math.round(sizeMB)}MB file vs ~${Math.round(ramMB)}MB RAM`;
  }

  const labels = {
    good: '✅ Fits your system',
    tight: '⚠️ Slow / tight',
    no: "❌ Won't run well",
    unknown: '❔ Unknown',
  };
  const distilled = isDistilled(item);
  const note = distilled
    ? 'Speed-distilled (Hyper/Turbo/LCM/Lightning/DMD) — fast for txt2img, weak for inpainting'
    : undefined;
  return { level, label: labels[level], reason, distilled, note };
}

// ---------------------------------------------------------------------------
// Civitai  (primary source for NSFW/uncensored)
// ---------------------------------------------------------------------------

function civitaiSort(sort) {
  return {
    downloads: 'Most Downloaded',
    likes: 'Most Liked',
    newest: 'Newest',
    rating: 'Highest Rated',
  }[sort] || 'Most Downloaded';
}

function civitaiType(type) {
  return {
    checkpoint: 'Checkpoint',
    lora: 'LORA',
    vae: 'VAE',
    controlnet: 'Controlnet',
    upscaler: 'Upscaler',
    embedding: 'TextualInversion',
  }[type];
}

/** Pick the newest published version that actually has files. */
function pickCivitaiVersion(versions = []) {
  return versions.find((v) => (v.files || []).length) || versions[0] || {};
}

/** Prefer the primary fp16 safetensors file; fall back to anything. */
function pickCivitaiFile(files = []) {
  const safe = files.filter((f) => /\.safetensors$/i.test(f.name || ''));
  const fp16 = safe.find((f) => f.metadata && f.metadata.fp === 'fp16');
  return fp16 || safe[0] || files[0] || null;
}

const THUMB_WIDTH = 450;

/**
 * Rewrite an image.civitai.com URL so it asks for a small copy. The transform
 * lives in one path segment (`original=true`, `width=1024`, `anim=false,width=450`).
 * Other hosts and unrecognised shapes come back unchanged.
 * @param {string} url
 * @param {{width?:number, still?:boolean}} [opts] `still` asks for a single frame (videos)
 * @returns {string}
 */
function civitaiThumbUrl(url, { width = THUMB_WIDTH, still = false } = {}) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return url; }
  if (u.hostname !== 'image.civitai.com') return url;
  const parts = u.pathname.split('/');
  const index = parts.findIndex((seg) => /(^|,)(original=true|width=\d+)(,|$)/.test(seg));
  if (index < 0) return url;
  parts[index] = `${still ? 'anim=false,' : ''}width=${width}`;
  u.pathname = parts.join('/');
  return u.toString();
}

const VIDEO_EXT = /\.(mp4|webm)$/i;

function isCivitaiVideo(image) {
  if (!image || !image.url) return false;
  return image.type === 'video' || VIDEO_EXT.test(new URL(image.url, 'https://x.invalid').pathname);
}

/**
 * Choose the card preview: the first *image*, else the first video (with a
 * still frame as poster). Returns null when there are no previews.
 * @param {object[]} images Civitai image objects ({url, type})
 * @returns {{url:string, type:'image'|'video', poster:string|null}|null}
 */
function pickCivitaiPreview(images = []) {
  const list = images.filter((i) => i && typeof i.url === 'string' && i.url);
  const image = list.find((i) => !isCivitaiVideo(i));
  if (image) return { url: civitaiThumbUrl(image.url), type: 'image', poster: null };
  const video = list[0];
  if (!video) return null;
  return {
    url: civitaiThumbUrl(video.url),
    type: 'video',
    poster: civitaiThumbUrl(video.url, { still: true }),
  };
}

/**
 * Deterministic placeholder colours for cards without a picture. Two hues
 * derived from an FNV-1a hash of the id, so the same model always looks the same.
 * @param {string} id
 * @returns {{hue:number, hue2:number}}
 */
function placeholderSpec(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id || '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hue = h % 360;
  return { hue, hue2: (hue + 40 + ((h >>> 9) % 60)) % 360 };
}

/**
 * Trigger words from a Civitai version's `trainedWords` (an array of strings,
 * each often a comma-separated list). Civitai exposes no recommended weight.
 * @param {unknown} trained
 * @returns {string[]}
 */
function civitaiTriggerWords(trained) {
  const words = [];
  for (const entry of Array.isArray(trained) ? trained : []) {
    for (const w of String(entry || '').split(',')) {
      const t = w.trim();
      if (t && !words.includes(t)) words.push(t);
    }
  }
  return words.slice(0, 40);
}

function normalizeCivitai(item) {
  const version = pickCivitaiVersion(item.modelVersions);
  const file = pickCivitaiFile(version.files);
  const stats = item.stats || {};
  const preview = pickCivitaiPreview(version.images) || pickCivitaiPreview(item.images);
  return {
    id: `civitai:${item.id}`,
    provider: 'civitai',
    name: item.name,
    description: stripHtml(item.description).slice(0, 400),
    baseModel: version.baseModel || (item.baseModels || [])[0] || null,
    type: normalizeType(item.type),
    typeRaw: item.type || '',
    nsfw: item.nsfw === true,
    tags: item.tags || [],
    downloads: stats.downloadCount ?? null,
    likes: stats.thumbsUpCount ?? null,
    fileSizeMB: file ? Math.round((file.sizeKB || 0) / 1024 * 10) / 10 : null,
    fileName: file ? file.name : null,
    downloadUrl: file ? file.downloadUrl : (version.downloadUrl || null),
    homeUrl: `https://civitai.com/models/${item.id}`,
    thumbnail: preview ? preview.url : null,
    thumbnailType: preview ? preview.type : null,
    thumbnailPoster: preview ? preview.poster : null,
    placeholder: placeholderSpec(`civitai:${item.id}`),
    updatedAt: version.publishedAt || version.createdAt || null,
    versionId: version.id ?? null,
    versionName: version.name || null,
    triggerWords: civitaiTriggerWords(version.trainedWords),
    recommendedStrength: null,
    inpainting: /inpaint/i.test([item.name, version.name, ...(item.tags || [])].filter(Boolean).join(' ')),
  };
}

async function searchCivitai({ query, type, baseModel, nsfw, sort, limit, period, token }) {
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  params.set('limit', String(limit));
  params.set('sort', civitaiSort(sort));
  if (nsfw) params.set('nsfw', 'true');
  if (period) params.set('period', period);
  const mappedType = civitaiType(type);
  if (mappedType) params.set('types', mappedType);
  if (baseModel) params.set('baseModels', baseModel);

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const data = await fetchJson(`${CIVITAI_BASE}/models?${params}`, { headers });
  return (data.items || []).map(normalizeCivitai);
}

// ---------------------------------------------------------------------------
// HuggingFace  (SFW models + helper models)
// ---------------------------------------------------------------------------

const HF_MODEL_EXT = /\.(safetensors|ckpt|bin|pt)$/i;

/** Pick the largest model-weights file from a repo's siblings list. */
function pickHFFile(siblings = []) {
  const files = siblings.filter((s) => HF_MODEL_EXT.test(s.rfilename || ''));
  if (!files.length) return null;
  return files.reduce((best, f) => {
    const size = (f.lfs && f.lfs.size) || f.size || 0;
    const bestSize = (best.lfs && best.lfs.size) || best.size || 0;
    return size > bestSize ? f : best;
  });
}

/** Best-effort architecture guess from a lowercased, camelCase-split blob. */
function inferBaseFromBlob(blob) {
  if (/flux/.test(blob)) return 'Flux.1 D';
  if (/pony|illustrious|noobai/.test(blob)) return 'Pony';
  if (/sd ?3|stable diffusion 3/.test(blob)) return 'SD 3';
  if (/sdxl|stable diffusion xl|\bxl\b/.test(blob)) return 'SDXL 1.0';
  if (/sd ?2|stable diffusion 2/.test(blob)) return 'SD 2.1';
  if (/sd ?15|sd ?1\b|stable diffusion|v1[-.]5|v1[-.]4/.test(blob)) return 'SD 1.5';
  return null;
}

/** Best-effort guess at the base architecture from tags/card metadata. */
function inferHFBaseModel(item, detail) {
  detail = detail || {};
  const card = detail.cardData || {};
  const config = detail.config || {};
  const blob = flattenText([
    item.id,
    item.modelId,
    (item.tags || []).join(' '),
    item.pipeline_tag,
    detail.library_name,
    config.model_type,
    [].concat(config.architectures || []).join(' '),
    [].concat(card.base_model || []).join(' '),
    [].concat(card.base_model_relation || []).join(' '),
  ].join(' '));
  return inferBaseFromBlob(blob);
}

function inferHFType(item) {
  const tags = (item.tags || []).join(' ').toLowerCase();
  if (/lora/.test(tags)) return 'lora';
  if (/textual-inversion|embedding/.test(tags)) return 'embedding';
  if (/\bvae\b/.test(tags)) return 'vae';
  if (/controlnet/.test(tags)) return 'controlnet';
  return 'checkpoint';
}

function normalizeHF(item, detail) {
  const file = pickHFFile((detail && detail.siblings) || []);
  const sizeBytes = file ? ((file.lfs && file.lfs.size) || file.size || 0) : 0;
  return {
    id: `huggingface:${item.id}`,
    provider: 'huggingface',
    name: item.id,
    description: (item.pipeline_tag ? `${item.pipeline_tag} · ` : '') + (item.tags || []).slice(0, 6).join(', '),
    baseModel: inferHFBaseModel(item, detail),
    type: inferHFType(item),
    typeRaw: (item.tags || []).join(', '),
    nsfw: false,
    tags: item.tags || [],
    downloads: item.downloads ?? null,
    likes: item.likes ?? null,
    fileSizeMB: sizeBytes ? Math.round(sizeBytes / 1048576 * 10) / 10 : null,
    fileName: file ? file.rfilename : null,
    downloadUrl: file
      ? `${HF_BASE}/${item.id}/resolve/main/${file.rfilename}`
      : `${HF_BASE}/${item.id}`,
    homeUrl: `${HF_BASE}/${item.id}`,
    thumbnail: null,
    thumbnailType: null,
    thumbnailPoster: null,
    placeholder: placeholderSpec(`huggingface:${item.id}`),
    updatedAt: item.lastModified || item.createdAt || null,
    gated: item.gated === true || (detail && detail.gated === true),
  };
}

async function searchHuggingFace({ query, limit, task, token }) {
  const params = new URLSearchParams({ search: query || '', limit: String(limit) });
  if (task) params.set('filter', task);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const list = await fetchJson(`${HF_BASE}/api/models?${params}`, { headers });
  const results = Array.isArray(list) ? list.slice(0, limit) : [];

  // The search endpoint omits file sizes, so fetch details (with blobs) for
  // each repo to find the main weights file. Limited concurrency keeps it quick.
  const details = await mapLimit(results, 6, async (item) => {
    try {
      return await fetchJson(`${HF_BASE}/api/models/${item.id}?blobs=true`, { headers });
    } catch (_) {
      return null; // still return the model, just without a size
    }
  });

  return results.map((item, i) => normalizeHF(item, details[i]));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const PROVIDERS = {
  civitai: searchCivitai,
  huggingface: searchHuggingFace,
};

/** Await one provider, capturing its error instead of failing the whole search. */
async function runProvider(name, args) {
  try {
    return { provider: name, items: await PROVIDERS[name](args) };
  } catch (err) {
    return { provider: name, items: [], error: err.message };
  }
}

/** Sort the merged list. */
function sortItems(items, sort) {
  const byDate = (i) => (i.updatedAt ? Date.parse(i.updatedAt) : 0);
  const copy = items.slice();
  if (sort === 'likes') copy.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  else if (sort === 'newest') copy.sort((a, b) => byDate(b) - byDate(a));
  else copy.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  return copy;
}

/**
 * Search all (or one) providers and return normalized, fit-tagged results.
 *
 * @param {object} options
 * @param {'all'|'civitai'|'huggingface'} options.provider
 * @param {string} options.query
 * @param {string} [options.type]       canonical type filter
 * @param {string} [options.baseModel]  Civitai baseModel filter
 * @param {boolean} [options.nsfw]
 * @param {'downloads'|'likes'|'newest'} [options.sort]
 * @param {number} [options.limit]      per-provider limit
 * @param {string} [options.period]     Civitai period
 * @param {object} [options.tokens]     { civitai, hf }
 * @param {object} [options.system]     { vramGB, ramGB }
 */
async function searchModels(options = {}) {
  const {
    provider = 'all',
    query = '',
    type = '',
    baseModel = '',
    nsfw = false,
    sort = 'downloads',
    limit = 20,
    period = '',
    task = '',
    tokens = {},
    system = {},
  } = options;

  const args = {
    query, type, baseModel, nsfw, sort, limit, period, task,
    token: '',
  };
  const selected = provider === 'all' ? Object.keys(PROVIDERS) : [provider];
  const unknown = selected.filter((p) => !PROVIDERS[p]);
  if (unknown.length) throw new Error(`Unknown provider "${unknown[0]}"`);

  const settled = await Promise.all(selected.map((name) => {
    const providerArgs = { ...args, token: tokens[name] || tokens[name === 'huggingface' ? 'hf' : name] || '' };
    return runProvider(name, providerArgs);
  }));

  const items = settled.flatMap((r) => r.items).map((item) => ({
    ...item,
    fit: gpuFit(item, system),
  }));

  return {
    items: sortItems(items, sort),
    providers: settled.map((r) => ({ provider: r.provider, count: r.items.length, error: r.error || null })),
  };
}

module.exports = {
  searchModels,
  gpuFit,
  isDistilled,
  inferBaseFromBlob,
  normalizeType,
  familyFor,
  // exported for tests / future download manager
  normalizeCivitai,
  civitaiTriggerWords,
  normalizeHF,
  PROVIDER_NAMES: Object.keys(PROVIDERS),
  civitaiThumbUrl,
  pickCivitaiPreview,
  placeholderSpec,
};
