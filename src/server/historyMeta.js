'use strict';

/**
 * historyMeta.js — turn a ComfyUI history entry into the metadata the gallery
 * shows: mode, prompt, key settings and the "before" image. Pure functions.
 */

/** Output filename prefix -> mode. Old PixelKiln names are still recognised. */
function modeFromFilename(filename) {
  const name = String(filename || '');
  if (/^(embernest|pixelkiln)_gen_/.test(name)) return 'generate';
  if (/^(embernest|pixelkiln)_tf_/.test(name)) return 'transform';
  if (/^(embernest|pixelkiln)(_|\.)/.test(name)) return 'edit';
  return null;
}

/** The stored API-format workflow of a history entry, or {}. */
function graphOf(entry) {
  const p = entry && entry.prompt;
  return Array.isArray(p) && p[2] && typeof p[2] === 'object' ? p[2] : {};
}

/** Follow a [nodeId, slot] link until a node of the wanted class (max 6 hops). */
function resolveText(graph, ref) {
  let cur = ref;
  for (let i = 0; i < 6 && Array.isArray(cur); i += 1) {
    const node = graph[cur[0]];
    if (!node) return null;
    if (node.class_type === 'CLIPTextEncode') return typeof node.inputs.text === 'string' ? node.inputs.text : null;
    const next = node.inputs && (node.inputs.conditioning || node.inputs.positive);
    cur = next;
  }
  return null;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Extract prompt + key settings from a stored ComfyUI prompt graph.
 * Every field is null/undefined-safe: a missing node just leaves it null.
 * @param {object} graph
 * @returns {{prompt:string|null, before:{filename:string,subfolder:string}|null, settings:object}}
 */
function extractFromGraph(graph) {
  const nodes = Object.entries(graph || {}).filter(([, n]) => n && typeof n === 'object' && n.inputs);
  const byClass = (cls) => nodes.filter(([, n]) => n.class_type === cls).map(([, n]) => n);
  const sampler = byClass('KSampler')[0] || byClass('KSamplerAdvanced')[0] || null;
  const si = (sampler && sampler.inputs) || {};

  let prompt = sampler ? resolveText(graph, si.positive) : null;
  let negative = sampler ? resolveText(graph, si.negative) : null;
  if (prompt == null) {
    const titled = nodes.find(([, n]) => n.class_type === 'CLIPTextEncode' && n._meta && /positive/i.test(n._meta.title || ''));
    const first = byClass('CLIPTextEncode')[0];
    const pick = titled ? titled[1] : first;
    prompt = pick && typeof pick.inputs.text === 'string' ? pick.inputs.text : null;
  }
  if (negative == null) {
    const titled = nodes.find(([, n]) => n.class_type === 'CLIPTextEncode' && n._meta && /negative/i.test(n._meta.title || ''));
    negative = titled && typeof titled[1].inputs.text === 'string' ? titled[1].inputs.text : null;
  }

  const ckpt = byClass('CheckpointLoaderSimple')[0];
  const lora = byClass('LoraLoader')[0];
  const latent = byClass('EmptyLatentImage')[0];
  let width = latent ? num(latent.inputs.width) : null;
  let height = latent ? num(latent.inputs.height) : null;
  let sampledAt = null;
  if (!latent) {
    // Edit / transform: the "Restore to WxH" scale holds the original size.
    const scales = nodes.filter(([, n]) => n.class_type === 'ImageScale');
    const restore = scales.find(([, n]) => /^Restore/.test((n._meta && n._meta.title) || ''));
    const down = scales.find(([, n]) => /^Downscale/.test((n._meta && n._meta.title) || ''));
    if (restore) { width = num(restore[1].inputs.width); height = num(restore[1].inputs.height); }
    if (down) sampledAt = Math.max(num(down[1].inputs.width) || 0, num(down[1].inputs.height) || 0) || null;
  }

  const load = byClass('LoadImage')[0];
  let before = null;
  if (load && typeof load.inputs.image === 'string' && load.inputs.image) {
    const raw = load.inputs.image.replace(/\\/g, '/');
    const cut = raw.lastIndexOf('/');
    before = { filename: raw.slice(cut + 1), subfolder: cut >= 0 ? raw.slice(0, cut) : '' };
  }

  const settings = {
    negative: negative || null,
    checkpoint: ckpt && typeof ckpt.inputs.ckpt_name === 'string' ? ckpt.inputs.ckpt_name : null,
    seed: num(si.seed), steps: num(si.steps), cfg: num(si.cfg),
    sampler: si.sampler_name || null, scheduler: si.scheduler || null,
    denoise: num(si.denoise),
    width, height, sampledAt,
    lora: lora && typeof lora.inputs.lora_name === 'string' ? lora.inputs.lora_name : null,
    loraStrength: lora ? num(lora.inputs.strength_model) : null,
  };
  return { prompt: prompt == null ? null : prompt, before, settings };
}

/** Creation time (ms) from the history entry's execution messages, or null. */
function createdAtOf(entry) {
  const msgs = (entry && entry.status && entry.status.messages) || [];
  for (const m of msgs) {
    if (Array.isArray(m) && m[1] && typeof m[1].timestamp === 'number') return m[1].timestamp;
  }
  return null;
}

module.exports = { modeFromFilename, extractFromGraph, graphOf, createdAtOf };
