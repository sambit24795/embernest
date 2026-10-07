/**
 * comfy.js — thin, dependency-free client for the ComfyUI HTTP API.
 *
 * PixelKiln never generates images itself; it hands a workflow (see
 * workflow.js) to ComfyUI and collects the results. This file is the only
 * place that talks to ComfyUI.
 *
 * Uses the native fetch / FormData / Blob available in Node 18+.
 */
'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

/** Error type so callers can distinguish ComfyUI problems from bugs. */
class ComfyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComfyError';
  }
}

/** Strip trailing slashes so path joins are predictable. */
function normalizeBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** Promise-based sleep. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the selectable options from a ComfyUI combo input.
 *
 * ComfyUI changed formats over time, so we support BOTH:
 *   - new:    ["COMBO", { options: [...] }]
 *   - legacy: [[...options...], { ... }]
 *
 * @param {object} nodeInfo  one node's entry from /object_info/<Class>
 * @param {string} field     input name, e.g. "ckpt_name"
 * @returns {string[]}
 */
function parseComboOptions(nodeInfo, field) {
  const combo = nodeInfo && nodeInfo.input && nodeInfo.input.required
    && nodeInfo.input.required[field];
  if (!Array.isArray(combo)) return [];

  // New format: ["COMBO", { options: [...] }]
  if (combo.length === 2 && combo[0] === 'COMBO'
      && combo[1] && Array.isArray(combo[1].options)) {
    return combo[1].options;
  }
  // Legacy format: [[...options...], { ... }]
  if (Array.isArray(combo[0])) {
    return combo[0];
  }
  return [];
}

/** Best-effort human summary of ComfyUI's status.messages on failure. */
function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return 'unknown error';
  const err = messages.find((m) => m && m[0] === 'execution_error');
  if (!err) return JSON.stringify(messages).slice(0, 500);
  const d = err[1] || {};
  return `${d.node_type || 'node'} #${d.node_id || '?'}: `
    + `${d.exception_type || ''} ${d.exception_message || ''}`.trim();
}

class ComfyClient {
  constructor(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  /** Low-level request helper. `path` may be a path or a full URL. */
  async _fetch(path, options = {}) {
    const url = path.startsWith('http') ? path : this.baseUrl + path;
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      throw new ComfyError(`Cannot reach ComfyUI at ${this.baseUrl}: ${err.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ComfyError(
        `ComfyUI ${options.method || 'GET'} ${path} -> ${res.status} ${res.statusText}`
        + (body ? `: ${body.slice(0, 300)}` : ''),
      );
    }
    return res;
  }

  async _getJson(path) {
    const res = await this._fetch(path);
    return res.json();
  }

  async _postJson(path, body) {
    const res = await this._fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  /** Health check. Resolves with /system_stats JSON, throws if unreachable. */
  async health() {
    return this._getJson('/system_stats');
  }

  /** Raw /object_info for one node class (or null if not installed). */
  async objectInfo(nodeName) {
    const all = await this._getJson(`/object_info/${encodeURIComponent(nodeName)}`);
    return all[nodeName] || null;
  }

  /** Read a combo input's options, handling both ComfyUI formats. */
  async comboOptions(nodeName, field) {
    const info = await this.objectInfo(nodeName);
    return parseComboOptions(info, field);
  }

  // ---- convenience wrappers for the fields PixelKiln cares about ----
  listCheckpoints() {
    return this.comboOptions('CheckpointLoaderSimple', 'ckpt_name');
  }

  listBackgroundRemovalModels() {
    return this.comboOptions('LoadBackgroundRemovalModel', 'bg_removal_name');
  }

  listFaceModels() {
    return this.comboOptions('LoadMediaPipeFaceLandmarker', 'model_name');
  }

  listSamplers() {
    return this.comboOptions('KSampler', 'sampler_name');
  }

  listSchedulers() {
    return this.comboOptions('KSampler', 'scheduler');
  }

  /**
   * Absolute ComfyUI models folder paths, e.g.
   * [{ name: 'checkpoints', folders: ['/path/models/checkpoints'], extensions: [...] }, ...]
   */
  async listModelFolders() {
    const data = await this._getJson('/experiment/models');
    return Array.isArray(data) ? data : [];
  }

  /**
   * Derive ComfyUI's absolute output directory from /experiment/models.
   * Returns null when it can't be determined.
   */
  async getOutputDirectory() {
    const entries = await this.listModelFolders();
    const candidates = new Set();
    for (const entry of entries) {
      for (const dir of entry.folders || []) {
        const m = dir.match(/^(.*\/output)\/[^/]+$/);
        if (m) candidates.add(m[1]);
        const m2 = dir.match(/^(.*)\/models\/[^/]+$/);
        if (m2) candidates.add(m2[1] + '/output');
      }
    }
    return candidates.values().next().value || null;
  }

  /** Remove one or more entries from ComfyUI's history. */
  async deleteHistoryItems(promptIds) {
    await this._fetch('/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    });
  }

  /**
   * Upload an image into ComfyUI's input folder.
   * @param {Buffer} buffer
   * @param {string} filename
   * @param {{type?:string, subfolder?:string, overwrite?:boolean}} [opts]
   * @returns {Promise<{name:string, subfolder:string, type:string}>}
   */
  async uploadImage(buffer, filename, { type = 'input', subfolder = '', overwrite = true } = {}) {
    const form = new FormData();
    form.append('image', new Blob([buffer]), filename);
    form.append('type', type);
    if (subfolder) form.append('subfolder', subfolder);
    form.append('overwrite', String(overwrite));

    const res = await this._fetch('/upload/image', { method: 'POST', body: form });
    return res.json();
  }

  /**
   * Queue a workflow. Returns the prompt_id.
   * Throws if ComfyUI reports validation errors.
   */
  async queuePrompt(workflow, clientId) {
    const body = { prompt: workflow };
    if (clientId) body.client_id = clientId;

    const res = await this._fetch('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();

    if (json.node_errors && Object.keys(json.node_errors).length) {
      throw new ComfyError(`ComfyUI rejected the workflow: ${JSON.stringify(json.node_errors).slice(0, 500)}`);
    }
    if (!json.prompt_id) {
      throw new ComfyError(`ComfyUI did not return a prompt_id: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json.prompt_id;
  }

  /** Raw /history/{prompt_id}. */
  async getHistory(promptId) {
    return this._getJson(`/history/${encodeURIComponent(promptId)}`);
  }

  /** Full execution history (all prompts). */
  async getAllHistory() {
    return this._getJson('/history');
  }

  /** ComfyUI queue state: { queue_running, queue_pending }. */
  async getQueue() {
    return this._getJson('/queue');
  }

  /** Interrupt the currently running prompt (optionally only this client's). */
  async interrupt(clientId) {
    return this._postJson('/interrupt', clientId ? { client_id: clientId } : {});
  }

  /** Remove a specific prompt from the pending queue. */
  async deleteFromQueue(promptId) {
    return this._postJson('/queue', { delete: [promptId] });
  }

  /**
   * Poll /history/{prompt_id} until the run appears, then return that entry.
   * Detects ComfyUI execution errors and throws ComfyError.
   */
  async waitForCompletion(promptId, { timeout = 600000, pollInterval = 1500 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hist = await this.getHistory(promptId);
      const entry = hist[promptId];
      if (entry) {
        const status = entry.status || {};
        if (status.status_str === 'error') {
          throw new ComfyError(`ComfyUI execution failed: ${summarizeMessages(status.messages)}`);
        }
        return entry;
      }
      await sleep(pollInterval);
    }
    throw new ComfyError(`Timed out after ${Math.round(timeout / 1000)}s waiting for prompt ${promptId}`);
  }

  /** Flatten a history entry's outputs into a list of image descriptors. */
  collectImages(historyEntry) {
    const images = [];
    const outputs = (historyEntry && historyEntry.outputs) || {};
    for (const nodeId of Object.keys(outputs)) {
      for (const img of outputs[nodeId].images || []) {
        images.push({ ...img, nodeId, url: this.viewUrl(img) });
      }
    }
    return images;
  }

  /** Build a /view URL for an image descriptor. */
  viewUrl({ filename, subfolder = '', type = 'output' }) {
    const qs = new URLSearchParams({ filename, subfolder, type }).toString();
    return `${this.baseUrl}/view?${qs}`;
  }

  /** Download one result image as a Buffer. */
  async viewImage(img) {
    const res = await this._fetch(this.viewUrl(img));
    const arrayBuffer = await res.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type') || 'image/png',
    };
  }

  /**
   * Convenience: queue + wait + list outputs.
   * @returns {Promise<{promptId:string, history:object, images:object[]}>}
   */
  async runWorkflow(workflow, opts = {}) {
    const promptId = await this.queuePrompt(workflow, opts.clientId);
    const history = await this.waitForCompletion(promptId, opts);
    return { promptId, history, images: this.collectImages(history) };
  }
}

module.exports = { ComfyClient, ComfyError, parseComboOptions, normalizeBaseUrl };
