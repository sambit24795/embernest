/**
 * app.js — PixelKiln UI logic (no build step, plain JS).
 *
 * Tabs: Edit / Generate / Models / Settings. Talks to the Express API only.
 * Edit and Generate share a reusable "forge tab" controller so progress, SSE,
 * result preview, compare slider and history behave identically.
 */
'use strict';

/* ----------------------------- helpers ----------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text before putting it in innerHTML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Only allow http(s) links through. */
function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/** Human-readable bytes. */
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** fetch + JSON + error throwing. */
async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
  if (!res.ok) throw new Error(data.error || data.detail || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind ? `is-${kind}` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

/* ----------------------------- state ----------------------------- */
const state = {
  specs: null,
  recommendation: null,
  status: null,
  config: null,
  provider: 'all',
  results: [],
  modelsLoadedOnce: false,
  downloadStreams: {},
  tabs: {},
};

// Arch family -> rough VRAM + sensible sampling size. Used for the badges.
const BASE_MODELS = [
  { id: 'SD 1.5', vram: 4, size: 768 },
  { id: 'SD 2.1', vram: 5, size: 768 },
  { id: 'SDXL 1.0', vram: 8, size: 1024 },
  { id: 'Pony', vram: 8, size: 1024 },
  { id: 'Illustrious', vram: 8, size: 1024 },
  { id: 'Flux.1 S', vram: 10, size: 1024 },
  { id: 'Flux.1 D', vram: 12, size: 1024 },
  { id: 'SD 3', vram: 12, size: 1024 },
];

function fitBadge(reqVram) {
  const vram = state.specs ? state.specs.vramGB : null;
  // Before specs are detected we don't know — show neutral rather than a wrong ❌.
  if (!vram) return { level: 'unknown', icon: '❔' };
  if (vram >= reqVram + 1.5) return { level: 'good', icon: '✅' };
  if (vram >= reqVram) return { level: 'tight', icon: '⚠️' };
  return { level: 'no', icon: '❌' };
}

/* ----------------------------- tabs ----------------------------- */
const TAB_NAMES = ['edit', 'generate', 'transform', 'models', 'settings'];

function showTab(name) {
  $$('.tab').forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  TAB_NAMES.forEach((id) => {
    $(`#tab-${id}`).hidden = id !== name;
  });
  if (location.hash !== `#${name}`) location.hash = name;

  // Lazy-load the model browser the first time it's opened.
  if (name === 'models' && !state.modelsLoadedOnce) {
    state.modelsLoadedOnce = true;
    runSearch();
  }
  if (name === 'models') loadDownloads();
  updateAllRunEnabled();
}

function bindTabs() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace('#', '') || 'edit';
    if (TAB_NAMES.includes(name)) showTab(name);
  });
}

/* ----------------------------- status ----------------------------- */
function renderStatusPill(s) {
  const dot = $('#statusDot');
  const text = $('#statusText');
  if (s && s.online) {
    dot.className = 'status-dot online';
    text.textContent = `ComfyUI ${s.version || 'online'}`;
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'ComfyUI offline';
  }
  updateAllRunEnabled();
}

async function loadStatus() {
  const s = await api('/api/status');
  state.status = s;
  renderStatusPill(s);
  populateForgeSelects(s);
  if (!s.online) toast(`ComfyUI unreachable at ${s.comfyUrl}`, 'error');
}

/* ----------------------------- specs / defaults ----------------------------- */
function renderSpecs() {
  const s = state.specs;
  const rec = state.recommendation;
  if (!s) return;
  const rows = [
    ['OS', `${s.distro || s.os} (${s.arch})`],
    ['GPU', s.gpu],
    ['VRAM', `${s.vramGB} GB`],
    ['RAM', `${s.ramGB} GB`],
  ];
  if (rec) rows.push(['Recommended', `${rec.baseModel} · max ${rec.maxSize}px (${rec.notes})`]);
  $('#specsList').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

/** Recommendation banner above the Edit form. */
function renderRecBanner() {
  const el = $('#editRecBanner');
  if (!el) return;
  const s = state.specs;
  const rec = state.recommendation;
  if (!s || !rec) { el.hidden = true; return; }
  $('#editRecText').innerHTML = `Detected <strong>${esc(s.gpu)}</strong> · ${esc(s.vramGB)} GB VRAM `
    + `→ <strong>${esc(rec.baseModel)}</strong> · max ${esc(rec.maxSize)}px · ${rec.lowvram ? 'low-vram' : 'full-vram'}`;
  el.hidden = false;
}

function renderBaseModelOptions() {
  const select = $('#baseModelSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = BASE_MODELS.map((b) => {
    const badge = fitBadge(b.vram);
    return `<option value="${esc(b.id)}">${badge.icon} ${esc(b.id)}</option>`;
  }).join('');
  // Auto-select the recommended base model (fallback: first option).
  const preferred = recommendedBaseOption();
  if (current && [...select.options].some((o) => o.value === current)) select.value = current;
  else if ([...select.options].some((o) => o.value === preferred)) select.value = preferred;
}

/** Build a shorter prompt for the base-model select based on the recommendation. */
function recommendedBaseOption() {
  const rec = (state.recommendation && state.recommendation.baseModel) || '';
  if (/flux/i.test(rec)) return 'Flux.1 D';
  if (/sdxl/i.test(rec)) return 'SDXL 1.0';
  return 'SD 1.5';
}

/** Fill a <select> with values, preserving the current choice and marking options. */
function fillSelect(select, values, fallback, label) {
  if (!select) return;
  const prev = select.value;
  const opts = values && values.length ? values : [];
  select.innerHTML = opts.length
    ? opts.map((v) => `<option value="${esc(v)}">${label ? label(v) : esc(v)}</option>`).join('')
    : `<option value="">${esc(fallback)}</option>`;
  if (opts.includes(prev)) select.value = prev;
}

/**
 * Auto-apply the spec recommendation to the Edit tab (section 6).
 * Runs on first load and when the user clicks "reset to recommended"; once the
 * user changes a field we leave it alone (state.editAutoConfigured).
 */
function autoConfigureEditTab(tab) {
  const d = (state.config && state.config.defaults) || {};
  const r = tab.refs;

  // 3. Checkpoint: prefer an inpainting checkpoint for Edit.
  const ckpts = (state.status && state.status.checkpoints) || [];
  if (ckpts.length) {
    r.checkpoint.value = ckpts.find((v) => /inpaint/i.test(v)) || ckpts[0];
  }

  // 1+2. Recommendation base model, then clamp maxSize for that family.
  const base = recommendedBaseOption();
  if (r.baseModelSelect && [...r.baseModelSelect.options].some((o) => o.value === base)) r.baseModelSelect.value = base;
  else if (r.baseModelSelect && r.baseModelSelect.options.length) r.baseModelSelect.selectedIndex = 0;
  onBaseModelChange(tab);

  // 4. Sampling defaults: sampler/scheduler forced to the plan defaults.
  if (document.activeElement !== r.denoise) r.denoise.value = d.denoise ?? 0.9;
  if (document.activeElement !== r.steps) r.steps.value = d.steps ?? 28;
  if (document.activeElement !== r.cfg) r.cfg.value = d.cfg ?? 7;
  if (document.activeElement !== r.seed) r.seed.value = d.seed ?? -1;
  const setOpt = (select, value) => { if (select && [...select.options].some((o) => o.value === value)) select.value = value; };
  setOpt(r.sampler, 'dpmpp_2m');
  setOpt(r.scheduler, 'karras');

  state.editAutoConfigured = true;
  tab.updateOutputs();
  tab.updateRunEnabled();
}

/** Defaults for the Generate tab (square spec-sized canvas + sampling defaults). */
function applyGenerateDefaults(tab) {
  const d = (state.config && state.config.defaults) || {};
  const rec = state.recommendation || {};
  const r = tab.refs;
  const size = rec.maxSize || d.maxSize || 768;
  if (document.activeElement !== r.width) r.width.value = size;
  if (document.activeElement !== r.height) r.height.value = size;
  if (document.activeElement !== r.steps) r.steps.value = d.steps ?? 28;
  if (document.activeElement !== r.cfg) r.cfg.value = d.cfg ?? 7;
  if (document.activeElement !== r.seed) r.seed.value = d.seed ?? -1;
  const setOpt = (select, value) => { if (select && [...select.options].some((o) => o.value === value)) select.value = value; };
  setOpt(r.sampler, d.sampler || 'dpmpp_2m');
  setOpt(r.scheduler, d.scheduler || 'karras');
  tab.updateOutputs();
}

/** Defaults for the Transform tab (denoise 0.6, spec maxSize). */
function applyTransformDefaults(tab) {
  const d = (state.config && state.config.defaults) || {};
  const rec = state.recommendation || {};
  const r = tab.refs;
  if (document.activeElement !== r.denoise) r.denoise.value = 0.6;
  if (document.activeElement !== r.maxSize) r.maxSize.value = rec.maxSize || d.maxSize || 768;
  if (document.activeElement !== r.steps) r.steps.value = d.steps ?? 28;
  if (document.activeElement !== r.cfg) r.cfg.value = d.cfg ?? 7;
  if (document.activeElement !== r.seed) r.seed.value = d.seed ?? -1;
  const setOpt = (select, value) => { if (select && [...select.options].some((o) => o.value === value)) select.value = value; };
  setOpt(r.sampler, d.sampler || 'dpmpp_2m');
  setOpt(r.scheduler, d.scheduler || 'karras');
  tab.updateOutputs();
}

function applyAllDefaults() {
  Object.values(state.tabs).forEach((tab) => {
    if (tab.kind === 'edit' && state.editAutoConfigured) { tab.updateOutputs(); return; }
    if (tab.opts.applyDefaults) tab.opts.applyDefaults(tab);
    else tab.updateOutputs();
  });
  updateAllRunEnabled();
}

/** When the user changes base model, pick a sensible max size for that family. */
function onBaseModelChange(tab) {
  const model = BASE_MODELS.find((b) => b.id === tab.refs.baseModelSelect.value);
  if (!model) return;
  const recMax = (state.recommendation && state.recommendation.maxSize) || 1024;
  tab.refs.maxSize.value = Math.min(model.size, recMax);
  tab.updateRunEnabled();
}

/* ----------------------------- forge selects ----------------------------- */
function populateForgeSelects(s) {
  const ckpts = s.checkpoints || [];
  for (const tab of Object.values(state.tabs)) {
    const { checkpoint, sampler, scheduler } = tab.refs;
    if (checkpoint) {
      fillSelect(checkpoint, ckpts, 'No checkpoint installed', (v) => `${esc(v)}${/inpaint/i.test(v) ? ' · inpainting' : ''}`);
    }
    fillSelect(sampler, s.samplers, 'dpmpp_2m');
    fillSelect(scheduler, s.schedulers, 'karras');
  }
  updateAllRunEnabled();
}

function updateAllRunEnabled() {
  Object.values(state.tabs).forEach((t) => t.updateRunEnabled());
}

/** Guess the base family from the checkpoint filename and sync the select. */
function inferBaseFromCheckpoint(tab) {
  const base = tab.refs.baseModelSelect;
  const name = (tab.refs.checkpoint.value || '').toLowerCase();
  if (!base || !name) return;
  let guess = 'SD 1.5';
  if (/flux/.test(name)) guess = 'Flux.1 D';
  else if (/pony/.test(name)) guess = 'Pony';
  else if (/xl|sdxl|illustrious|noob/.test(name)) guess = 'SDXL 1.0';
  base.value = guess;
}

/* ----------------------------- forge tab controller ----------------------------- */
/**
 * Wire one forge panel (Edit or Generate) so it shares job progress, SSE,
 * result preview, compare slider and history rendering.
 *
 * @param {object} opts
 * @param {string} opts.kind                'edit' | 'generate' | 'transform'
 * @param {HTMLElement} opts.root
 * @param {object} opts.sel                 role -> selector map
 * @param {boolean} opts.withImage          show an upload dropzone
 * @param {boolean} opts.withCompare        before/after slider
 * @param {Function} opts.buildRequest      (tab, refs) => { url, options }
 * @param {Function} [opts.applyDefaults]
 * @param {Function} [opts.onCheckpointChange]
 * @param {Function} [opts.readyHint]
 */
function createForgeTab(opts) {
  const refs = {};
  for (const [role, selector] of Object.entries(opts.sel || {})) {
    refs[role] = opts.root.querySelector(selector);
  }

  const tab = { kind: opts.kind, opts, refs, busy: false, imageFile: null, job: null, es: null };

  tab.updateOutputs = () => {
    if (refs.denoise && refs.denoiseOut) refs.denoiseOut.textContent = Number(refs.denoise.value).toFixed(2);
    if (refs.steps && refs.stepsOut) refs.stepsOut.textContent = refs.steps.value;
    if (refs.cfg && refs.cfgOut) refs.cfgOut.textContent = Number(refs.cfg.value).toFixed(1);
  };

  tab.updateRunEnabled = () => {
    if (!refs.runBtn) return;
    const ready = (!opts.withImage || Boolean(tab.imageFile))
      && Boolean(state.status && state.status.online) && !tab.busy;
    refs.runBtn.disabled = !ready;
    if (!refs.hint) return;
    if (!state.status || !state.status.online) refs.hint.textContent = 'ComfyUI is offline — check Settings.';
    else if (opts.withImage && !tab.imageFile) refs.hint.textContent = 'Choose an image to enable forging.';
    else refs.hint.textContent = opts.readyHint ? opts.readyHint(tab) : 'Ready.';
  };

  tab.setProgress = (job) => {
    if (refs.phase) refs.phase.textContent = job.phaseLabel || 'Working…';
    if (!refs.progressFill) return;
    if (job.step && job.step.max) {
      refs.progressFill.style.width = `${Math.round((job.step.value / job.step.max) * 100)}%`;
      if (refs.progressText) refs.progressText.textContent = `${job.nodeTitle || 'Sampling'} · step ${job.step.value}/${job.step.max}`;
    } else {
      refs.progressFill.style.width = `${job.percent || 0}%`;
      if (refs.progressText) refs.progressText.textContent = job.phaseLabel || '';
    }
  };

  tab.finishError = (message) => {
    tab.busy = false;
    if (refs.resultLoading) refs.resultLoading.hidden = true;
    if (refs.resultPlaceholder) refs.resultPlaceholder.hidden = true;
    if (refs.compare) refs.compare.hidden = true;
    if (refs.outputMeta) refs.outputMeta.hidden = true;
    if (refs.runBtn) refs.runBtn.querySelector('.spinner-mini').hidden = true;
    if (refs.resultErrorText) refs.resultErrorText.textContent = message;
    if (refs.resultError) refs.resultError.hidden = false;
    tab.updateRunEnabled();
    toast(`${opts.errorToast || 'Job failed'}: ${message}`, 'error');
  };

  tab.showResult = (job) => {
    const after = job.after || (job.images[0] && job.images[0].url) || '';
    if (refs.compareAfter) refs.compareAfter.src = after;
    if (refs.compare) {
      if (opts.withCompare && job.before && refs.compareBefore) {
        refs.compareBefore.src = job.before;
        refs.compareBefore.hidden = false;
        if (refs.compareBeforeTag) refs.compareBeforeTag.hidden = false;
        if (refs.compareHandle) refs.compareHandle.hidden = false;
      } else {
        if (refs.compareBefore) { refs.compareBefore.hidden = true; refs.compareBefore.removeAttribute('src'); }
        if (refs.compareBeforeTag) refs.compareBeforeTag.hidden = true;
        if (refs.compareHandle) refs.compareHandle.hidden = true;
      }
      refs.compare.style.setProperty('--pos', '50%');
      refs.compare.hidden = false;
    }
    if (refs.metaList) {
      refs.metaList.innerHTML = renderJobMeta(job);
      if (refs.outputMeta) refs.outputMeta.hidden = false;
    }
    if (refs.downloadBtn) {
      refs.downloadBtn.hidden = !after;
      refs.downloadBtn.onclick = () => downloadResult(after, opts.downloadPrefix || 'pixelkiln');
    }
  };

  tab.track = (jobId) => {
    const apply = (job) => {
      tab.job = job;
      tab.setProgress(job);
      if (!['done', 'error', 'cancelled'].includes(job.status)) return;

      if (tab.es) { tab.es.close(); tab.es = null; }
      tab.busy = false;
      if (refs.resultLoading) refs.resultLoading.hidden = true;
      if (refs.runBtn) refs.runBtn.querySelector('.spinner-mini').hidden = true;
      tab.updateRunEnabled();

      if (job.status === 'done') {
        tab.showResult(job);
        toast(opts.doneToast || 'Done 🔥', 'ok');
      } else if (job.status === 'error') {
        tab.finishError(job.error || 'Unknown error');
      } else {
        if (refs.resultPlaceholder) refs.resultPlaceholder.hidden = false;
        toast('Cancelled');
      }
      loadQueue();
      loadHistory();
    };

    if (tab.es) tab.es.close();
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    tab.es = es;
    es.onmessage = (ev) => { try { apply(JSON.parse(ev.data)); } catch (_) { /* ignore */ } };
  };

  tab.run = async () => {
    if (tab.busy) return;
    if (opts.withImage && !tab.imageFile) return;
    tab.busy = true;
    tab.updateRunEnabled();

    if (refs.resultPlaceholder) refs.resultPlaceholder.hidden = true;
    if (refs.compare) refs.compare.hidden = true;
    if (refs.outputMeta) refs.outputMeta.hidden = true;
    if (refs.resultError) refs.resultError.hidden = true;
    if (refs.resultLoading) refs.resultLoading.hidden = false;
    if (refs.runBtn) {
      refs.runBtn.disabled = true;
      const spin = refs.runBtn.querySelector('.spinner-mini');
      if (spin) spin.hidden = false;
    }
    tab.setProgress({ phaseLabel: opts.uploadingLabel || 'Starting', percent: 3, step: null });

    try {
      const { url, options } = opts.buildRequest(tab, refs);
      const data = await api(url, options);
      tab.track(data.job.id);
    } catch (err) {
      tab.finishError(err.message);
    }
  };

  // Image dropzone (Edit/Transform).
  if (opts.withImage) {
    const { dropzone, fileInput, inputPreview, dropzoneHint } = refs;
    const setImage = (file) => {
      tab.imageFile = file;
      inputPreview.src = URL.createObjectURL(file);
      inputPreview.hidden = false;
      dropzoneHint.hidden = true;
      tab.updateRunEnabled();
    };
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) setImage(fileInput.files[0]); });
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('is-drag'); }));
    dropzone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) setImage(file);
      else toast('Please drop an image file', 'error');
    });
  }

  if (refs.runBtn) refs.runBtn.addEventListener('click', tab.run);
  if (refs.cancelBtn) refs.cancelBtn.addEventListener('click', async () => {
    if (!tab.job || !tab.job.id) return;
    try { await api(`/api/jobs/${tab.job.id}`, { method: 'DELETE' }); }
    catch (err) { toast(err.message, 'error'); }
  });
  if (refs.refreshQueue) refs.refreshQueue.addEventListener('click', () => { loadQueue(); loadHistory(); });
  if (refs.interruptBtn) refs.interruptBtn.addEventListener('click', interruptQueue);

  ['denoise', 'steps', 'cfg'].forEach((role) => {
    if (refs[role]) refs[role].addEventListener('input', tab.updateOutputs);
  });
  if (refs.checkpoint && opts.onCheckpointChange) {
    refs.checkpoint.addEventListener('change', () => opts.onCheckpointChange(tab));
  }
  if (refs.compare && refs.compareHandle) bindCompare(refs.compare, refs.compareHandle);

  return tab;
}

/** Details panel rows for a finished job. */
function renderJobMeta(job) {
  const s = job.settings || {};
  const rows = [['Prompt ID', job.promptId], ['Checkpoint', s.checkpoint]];
  if (job.kind === 'generate') {
    rows.push(['Size', `${s.width}×${s.height}`]);
  } else {
    if (job.kind === 'edit') rows.push(['Original', s.width && s.height ? `${s.width}×${s.height}` : '—']);
    rows.push(['Sampled at', s.maxSize ? `${s.maxSize}px` : '—']);
    if (job.kind === 'edit') rows.push(['Preserve face', s.preserveFace ? 'yes' : 'no']);
    if (job.kind !== 'generate') rows.push(['Restore size', s.restoreSize ? 'yes' : 'no']);
  }
  rows.push(['Steps', s.steps], ['CFG', s.cfg], ['Sampler', s.sampler], ['Scheduler', s.scheduler], ['Seed', s.seed]);
  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

/** Trigger a browser download for a result URL. */
function downloadResult(url, prefix) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}_${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ----------------------------- queue / history ----------------------------- */
/** Refresh the queue status line in every forge tab. */
async function loadQueue() {
  const statuses = Object.values(state.tabs).map((t) => t.refs.queueStatus).filter(Boolean);
  if (!statuses.length) return;
  try {
    const q = await api('/api/queue');
    const parts = [`${q.running.length} running`, `${q.pending.length} pending`];
    if (q.activeEdits.length) parts.push(`${q.activeEdits.length} active`);
    statuses.forEach((el) => { el.textContent = parts.join(' · '); });
  } catch (err) {
    statuses.forEach((el) => { el.textContent = `Queue unavailable: ${err.message}`; });
  }
}

/** Show recent results as thumbnails with a delete button in every forge tab. */
async function loadHistory() {
  const grids = Object.values(state.tabs).map((t) => t.refs.historyGrid).filter(Boolean);
  if (!grids.length) return;
  try {
    const data = await api('/api/history?limit=12');
    const html = data.items.length
      ? data.items.flatMap((item) => item.images.map((img) => (
        `<div class="history-item">
          <a href="${esc(img.url)}" target="_blank" rel="noopener"><img class="history-thumb" src="${esc(img.url)}" alt="Recent result" loading="lazy" /></a>
          <button class="history-delete" data-prompt-id="${esc(item.promptId)}" title="Delete" aria-label="Delete this result">✕</button>
        </div>`
      ))).join('')
      : '<p class="muted">No results yet.</p>';
    grids.forEach((g) => { g.innerHTML = html; });
  } catch (err) {
    grids.forEach((g) => { g.innerHTML = `<p class="muted">${esc(err.message)}</p>`; });
  }
}

/** Delete a result's files + history entry, then refresh the grids. */
async function deleteHistory(promptId) {
  try {
    await api(`/api/history/${encodeURIComponent(promptId)}`, { method: 'DELETE' });
    toast('Deleted', 'ok');
    loadHistory();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Interrupt whatever ComfyUI is currently running. */
async function interruptQueue() {
  try {
    await api('/api/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast('Interrupt sent', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
  setTimeout(loadQueue, 1000);
}

/* ----------------------------- compare slider ----------------------------- */
function bindCompare(compare, handle) {
  let dragging = false;

  const setPos = (clientX) => {
    const rect = compare.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    compare.style.setProperty('--pos', `${pct}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  const start = (e) => { dragging = true; setPos(e.clientX); e.preventDefault(); };

  compare.addEventListener('pointerdown', start);
  compare.addEventListener('pointermove', (e) => { if (dragging) setPos(e.clientX); });
  window.addEventListener('pointerup', () => { dragging = false; });
  handle.addEventListener('pointerdown', start);
  handle.addEventListener('keydown', (e) => {
    let pct = parseFloat(compare.style.getPropertyValue('--pos')) || 50;
    if (e.key === 'ArrowLeft') pct -= 3;
    else if (e.key === 'ArrowRight') pct += 3;
    else return;
    e.preventDefault();
    compare.style.setProperty('--pos', `${Math.max(0, Math.min(100, pct))}%`);
  });
}

/* ----------------------------- models ----------------------------- */
function bindModels() {
  $$('#providerTabs .chip').forEach((chip) => chip.addEventListener('click', () => {
    state.provider = chip.dataset.provider;
    $$('#providerTabs .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    runSearch();
  }));
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); runSearch(); });
  $('#refreshInstalled').addEventListener('click', loadInstalled);
  $('#modelResults').addEventListener('click', onModelResultsClick);
  $('#installedList').addEventListener('click', (e) => {
    const btn = e.target.closest('.installed-delete');
    if (btn) deleteInstalledModel(btn.dataset.folder, btn.dataset.name);
  });
}

async function runSearch() {
  const params = new URLSearchParams({
    provider: state.provider,
    query: $('#searchQuery').value.trim(),
    sort: $('#filterSort').value,
    limit: $('#filterLimit').value || '20',
  });
  if ($('#filterType').value) params.set('type', $('#filterType').value);
  if ($('#filterBaseModel').value.trim()) params.set('baseModel', $('#filterBaseModel').value.trim());
  if ($('#filterNsfw').checked) params.set('nsfw', 'true');

  $('#modelsHint').textContent = 'Searching…';
  renderSkeletons();
  try {
    const data = await api(`/api/models/search?${params}`);
    state.results = data.items;
    renderModels(data);
  } catch (err) {
    $('#modelResults').innerHTML = '';
    $('#modelsHint').textContent = `Search failed: ${err.message}`;
  }
}

function renderSkeletons() {
  $('#modelResults').innerHTML = Array.from({ length: 6 }, () => `
    <div class="skeleton"><div class="sk-thumb"></div><div class="sk-line"></div><div class="sk-line short"></div></div>
  `).join('');
}

function renderModels(data) {
  const errors = (data.providers || []).filter((p) => p.error);
  $('#modelsHint').textContent = `${data.items.length} result(s)`
    + (errors.length ? ` · ${errors.map((e) => `${e.provider}: ${e.error}`).join(' · ')}` : '');

  if (!data.items.length) {
    $('#modelResults').innerHTML = '<div class="card"><p class="muted">No models found. Try another search or provider.</p></div>';
    return;
  }
  $('#modelResults').innerHTML = data.items.map((item, index) => modelCardHtml(item, index)).join('');
}

function modelCardHtml(item, index) {
  const thumb = safeUrl(item.thumbnail);
  const home = safeUrl(item.homeUrl);
  const meta = [];
  if (item.baseModel) meta.push(`<span class="pill">${esc(item.baseModel)}</span>`);
  if (item.type) meta.push(`<span class="pill">${esc(item.type)}</span>`);
  if (/inpaint/i.test([item.name, item.type, (item.tags || []).join(' ')].join(' '))) {
    meta.push('<span class="pill pill-inpaint">inpainting</span>');
  }
  if (item.fileSizeMB != null) meta.push(`<span>${esc(item.fileSizeMB)} MB</span>`);
  if (item.downloads != null) meta.push(`<span>⬇ ${Number(item.downloads).toLocaleString()}</span>`);
  if (item.likes != null) meta.push(`<span>♥ ${Number(item.likes).toLocaleString()}</span>`);

  return `
    <article class="model-card">
      ${thumb
        ? `<img class="model-thumb" src="${esc(thumb)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'model-thumb model-thumb-empty',textContent:'▧'}))" />`
        : `<div class="model-thumb model-thumb-empty">▧</div>`}
      <div class="model-body">
        <span class="model-prov">${esc(item.provider)}</span>
        <h3 class="model-title">${esc(item.name)}</h3>
        <p class="model-desc">${esc(item.description || '')}</p>
        <div class="model-meta">${meta.join('')}</div>
        <span class="badge fit-${esc(item.fit ? item.fit.level : 'unknown')}" title="${esc(item.fit ? item.fit.reason : '')}">${esc(item.fit ? item.fit.label : '❔ Unknown')}</span>
        <div class="model-actions">
          <button class="btn btn-primary" data-index="${index}" data-action="download"${item.downloadUrl ? '' : ' disabled'}>Download</button>
          ${home ? `<a class="btn btn-ghost" href="${esc(home)}" target="_blank" rel="noopener">Open</a>` : ''}
        </div>
        <div class="dl" hidden>
          <div class="progress"><div class="progress-fill"></div></div>
          <div class="dl-status">Starting…</div>
        </div>
      </div>
    </article>`;
}

function onModelResultsClick(e) {
  const btn = e.target.closest('[data-action="download"]');
  if (!btn) return;
  const item = state.results[Number(btn.dataset.index)];
  if (item) downloadModel(item, btn.closest('.model-card'));
}

async function downloadModel(item, card) {
  const dl = card.querySelector('.dl');
  dl.hidden = false;
  try {
    const data = await api('/api/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        downloadUrl: item.downloadUrl,
        type: item.type,
        fileName: item.fileName || `${item.name}.safetensors`,
        fileSizeMB: item.fileSizeMB,
        provider: item.provider,
      }),
    });
    trackDownload(data.job, card);
    loadDownloads();
  } catch (err) {
    dl.hidden = true;
    toast(`Download failed: ${err.message}`, 'error');
  }
}

function trackDownload(job, card) {
  updateDownloadUI(card, job);
  const es = new EventSource(`/api/models/downloads/${job.id}/events`);
  es.onmessage = (ev) => {
    const j = JSON.parse(ev.data);
    updateDownloadUI(card, j);
    if (['done', 'error', 'cancelled'].includes(j.status)) {
      es.close();
      if (j.status === 'done') { toast(`Installed ${j.fileName} — restart ComfyUI to use it`, 'ok'); loadInstalled(); }
      else if (j.status === 'error') toast(`Download failed: ${j.error}`, 'error');
    }
  };
  es.onerror = () => es.close();
}

function updateDownloadUI(card, job) {
  const fill = card.querySelector('.progress-fill');
  const status = card.querySelector('.dl-status');
  if (!fill || !status) return;
  const pct = job.status === 'done' ? 100 : (job.percent || 0);
  fill.style.width = `${pct}%`;
  status.textContent = `${job.status} ${pct}% · ${fmtBytes(job.received)} / ${fmtBytes(job.total)}`
    + (job.speed ? ` · ${fmtBytes(job.speed)}/s` : '')
    + (job.folder ? ` · → ${job.folder}` : '');
}

/** Render one row in the Downloads panel. */
function downloadRowHtml(job) {
  const pct = job.status === 'done' ? 100 : (job.percent || 0);
  const bits = [`${job.status} ${pct}%`];
  if (job.speed) bits.push(`${fmtBytes(job.speed)}/s`);
  if (job.folder) bits.push(`→ ${job.folder}`);
  if (job.status === 'error' && job.error) bits.push(job.error);
  return `
    <div class="dl-row" data-job-id="${esc(job.id)}">
      <div class="dl-row-head">
        <span class="dl-name" title="${esc(job.fileName)}">${esc(job.fileName)}</span>
        <span class="dl-pct">${pct}%</span>
      </div>
      <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="dl-status">${esc(bits.join(' · '))}</div>
    </div>`;
}

/** Replace a single Downloads-panel row with fresh job data. */
function updateDownloadRow(job) {
  const row = document.querySelector(`[data-job-id="${CSS.escape(job.id)}"]`);
  if (row) row.outerHTML = downloadRowHtml(job);
}

/** Re-attach a live progress stream for an active download (idempotent). */
function attachDownloadStream(jobId) {
  if (state.downloadStreams[jobId]) return;
  const es = new EventSource(`/api/models/downloads/${jobId}/events`);
  state.downloadStreams[jobId] = es;
  es.onmessage = (ev) => {
    let j; try { j = JSON.parse(ev.data); } catch (_) { return; }
    updateDownloadRow(j);
    if (['done', 'error', 'cancelled'].includes(j.status)) {
      es.close();
      delete state.downloadStreams[jobId];
      if (j.status === 'done') { toast(`Installed ${j.fileName} — restart ComfyUI to use it`, 'ok'); loadInstalled(); }
      else if (j.status === 'error') toast(`Download failed: ${j.error}`, 'error');
    }
  };
  es.onerror = () => { es.close(); delete state.downloadStreams[jobId]; };
}

/** List all download jobs and re-attach live streams to any still running. */
async function loadDownloads() {
  try {
    const data = await api('/api/models/downloads');
    const jobs = data.jobs || (Array.isArray(data) ? data : []);
    if (!jobs.length) {
      $('#downloadsList').innerHTML = '<p class="muted">No downloads yet.</p>';
      return;
    }
    $('#downloadsList').innerHTML = jobs.map(downloadRowHtml).join('');
    jobs.filter((j) => ['queued', 'downloading'].includes(j.status))
      .forEach((j) => attachDownloadStream(j.id));
  } catch (err) {
    $('#downloadsList').innerHTML = `<p class="muted">Could not list downloads: ${esc(err.message)}</p>`;
  }
}

async function loadInstalled() {
  try {
    const data = await api('/api/models/installed');
    const groups = Object.entries(data.folders);
    $('#installedList').innerHTML = groups.map(([folder, files]) => `
      <div class="installed-group">
        <h4>${esc(folder)} · ${files.length}</h4>
        ${files.length
          ? files.map((f) => `
            <div class="installed-item">
              <span class="installed-name">${esc(f.name)}</span>
              <span class="installed-actions">
                <span class="mono">${esc(f.sizeMB)} MB</span>
                <button class="installed-delete" data-folder="${esc(folder)}" data-name="${esc(f.name)}" title="Delete ${esc(f.name)}" aria-label="Delete ${esc(f.name)}">✕</button>
              </span>
            </div>`).join('')
          : '<p class="muted">empty</p>'}
      </div>`).join('');
  } catch (err) {
    $('#installedList').innerHTML = `<p class="muted">Could not list installed models: ${esc(err.message)}</p>`;
  }
}

/** Delete one installed model file, then refresh the list. */
async function deleteInstalledModel(folder, name) {
  if (!window.confirm(`Delete ${folder}/${name}?\n\nComfyUI must be restarted before it disappears from the dropdown.`)) return;
  try {
    const res = await api(`/api/models/installed/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(res.restartRequired ? 'Deleted — restart ComfyUI to finish removing' : 'Deleted', 'ok');
    loadInstalled();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

/* ----------------------------- settings ----------------------------- */
function bindSettings() {
  $('#saveSettings').addEventListener('click', saveSettings);
  $('#statusPill').addEventListener('click', () => loadStatus().catch(() => {}));
  $('#restartComfyBtn').addEventListener('click', restartComfy);
}

/** Ask the server to restart ComfyUI (only works when configured). */
async function restartComfy() {
  if (!window.confirm('Restart ComfyUI now? Any running generation will be lost.')) return;
  toast('Restarting ComfyUI…');
  try {
    const res = await api('/api/comfy/restart', { method: 'POST' });
    toast(res.restarted ? 'ComfyUI restarted' : 'Restart did not complete', res.restarted ? 'ok' : 'error');
  } catch (err) {
    toast(err.message, 'error');
  }
  setTimeout(() => loadStatus().catch(() => {}), 1500);
}

function fillSettingsForm(cfg) {
  $('#cfgComfyUrl').value = cfg.comfyUrl || '';
  $('#cfgPort').value = cfg.port || 3000;
  $('#cfgLan').checked = Boolean(cfg.listenOnLan);
  const d = cfg.defaults || {};
  $('#defDenoise').value = d.denoise ?? 0.9;
  $('#defSteps').value = d.steps ?? 28;
  $('#defCfg').value = d.cfg ?? 7;
  $('#defSeed').value = d.seed ?? -1;
  $('#defMaxSize').value = d.maxSize ?? 768;

  const set = cfg.tokensSet || {};
  const mark = (id, key) => { $(id).textContent = set[key] ? '(saved)' : '(not set)'; };
  mark('#tokCivitaiState', 'civitai');
  mark('#tokHfState', 'hf');
  mark('#tokModelscopeState', 'modelscope');
  mark('#tokGithubState', 'github');

  $('#cfgRestartCommand').value = cfg.comfyRestartCommand || '';
  $('#cfgAllowRestart').checked = Boolean(cfg.allowComfyRestart);
}

async function saveSettings() {
  const tokens = {
    civitai: $('#tokCivitai').value.trim(),
    hf: $('#tokHf').value.trim(),
    modelscope: $('#tokModelscope').value.trim(),
    github: $('#tokGithub').value.trim(),
  };
  const body = {
    comfyUrl: $('#cfgComfyUrl').value.trim(),
    port: Number($('#cfgPort').value),
    listenOnLan: $('#cfgLan').checked,
    comfyRestartCommand: $('#cfgRestartCommand').value.trim(),
    allowComfyRestart: $('#cfgAllowRestart').checked,
    defaults: {
      denoise: Number($('#defDenoise').value),
      steps: Number($('#defSteps').value),
      cfg: Number($('#defCfg').value),
      seed: Number($('#defSeed').value),
      maxSize: Number($('#defMaxSize').value),
    },
    tokens: Object.fromEntries(Object.entries(tokens).filter(([, v]) => v.length)),
  };
  try {
    const res = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Clear the token fields so saved secrets aren't left on screen.
    ['#tokCivitai', '#tokHf', '#tokModelscope', '#tokGithub'].forEach((id) => { $(id).value = ''; });
    fillSettingsForm(res.config);
    state.config = res.config;
    toast(res.restartRequired ? 'Saved — restart PixelKiln for port/LAN changes' : 'Settings saved', 'ok');
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'error');
  }
}

/* ----------------------------- forge tab instances ----------------------------- */
const editTab = createForgeTab({
  kind: 'edit',
  root: document.getElementById('tab-edit'),
  withImage: true,
  withCompare: true,
  uploadingLabel: 'Uploading image',
  doneToast: 'Image forged 🔥',
  errorToast: 'Edit failed',
  downloadPrefix: 'pixelkiln',
  sel: {
    dropzone: '#dropzone', fileInput: '#fileInput', inputPreview: '#inputPreview', dropzoneHint: '#dropzoneHint',
    positive: '#positive', negative: '#negative', checkpoint: '#checkpointSelect',
    maxSize: '#maxSize', denoise: '#denoise', denoiseOut: '#denoiseOut',
    steps: '#steps', stepsOut: '#stepsOut', cfg: '#cfg', cfgOut: '#cfgOut',
    seed: '#seed', sampler: '#sampler', scheduler: '#scheduler',
    preserveFace: '#preserveFace', restoreSize: '#restoreSize', baseModelSelect: '#baseModelSelect',
    runBtn: '#runBtn', hint: '#editHint', cancelBtn: '#cancelEditBtn',
    resultPlaceholder: '#resultPlaceholder', resultLoading: '#resultLoading', resultError: '#resultError',
    resultErrorText: '#resultErrorText', phase: '#editPhase', progressFill: '#editProgressFill',
    progressText: '#editProgressText', compare: '#compare', compareBefore: '#compareBefore',
    compareAfter: '#compareAfter', compareHandle: '#compareHandle', compareBeforeTag: '#compareBeforeTag',
    outputMeta: '#outputMeta', metaList: '#outputMetaList', downloadBtn: '#downloadResultBtn',
    queueStatus: '#queueStatus', historyGrid: '#historyGrid',
    refreshQueue: '#refreshQueue', interruptBtn: '#interruptBtn',
  },
  buildRequest: (tab, refs) => {
    const fd = new FormData();
    fd.append('image', tab.imageFile);
    fd.append('positive', refs.positive.value);
    fd.append('negative', refs.negative.value);
    fd.append('checkpoint', refs.checkpoint.value);
    fd.append('maxSize', refs.maxSize.value);
    fd.append('denoise', refs.denoise.value);
    fd.append('steps', refs.steps.value);
    fd.append('cfg', refs.cfg.value);
    fd.append('sampler', refs.sampler.value);
    fd.append('scheduler', refs.scheduler.value);
    fd.append('seed', refs.seed.value);
    fd.append('preserveFace', refs.preserveFace.checked);
    fd.append('restoreSize', refs.restoreSize.checked);
    if (state.status) {
      if (state.status.bgRemovalModels[0]) fd.append('bgRemovalModel', state.status.bgRemovalModels[0]);
      if (state.status.faceModels[0]) fd.append('faceModel', state.status.faceModels[0]);
    }
    return { url: '/api/edit', options: { method: 'POST', body: fd } };
  },
  onCheckpointChange: (tab) => inferBaseFromCheckpoint(tab),
  applyDefaults: (tab) => autoConfigureEditTab(tab),
  readyHint: (tab) => `Will sample up to ${tab.refs.maxSize.value}px, then restore.`,
});

const generateTab = createForgeTab({
  kind: 'generate',
  root: document.getElementById('tab-generate'),
  withImage: false,
  withCompare: false,
  uploadingLabel: 'Starting',
  doneToast: 'Image generated 🔥',
  errorToast: 'Generate failed',
  downloadPrefix: 'pixelkiln_gen',
  sel: {
    prompt: '#genPrompt', negative: '#genNegative', checkpoint: '#genCheckpoint',
    width: '#genWidth', height: '#genHeight',
    steps: '#genSteps', stepsOut: '#genStepsOut', cfg: '#genCfg', cfgOut: '#genCfgOut',
    seed: '#genSeed', sampler: '#genSampler', scheduler: '#genScheduler',
    runBtn: '#genRunBtn', hint: '#genHint', cancelBtn: '#genCancelBtn',
    resultPlaceholder: '#genResultPlaceholder', resultLoading: '#genResultLoading', resultError: '#genResultError',
    resultErrorText: '#genResultErrorText', phase: '#genPhase', progressFill: '#genProgressFill',
    progressText: '#genProgressText', compare: '#genCompare', compareAfter: '#genCompareAfter',
    compareHandle: '#genCompareHandle',
    outputMeta: '#genOutputMeta', metaList: '#genOutputMetaList', downloadBtn: '#genDownloadBtn',
    queueStatus: '#genQueueStatus', historyGrid: '#genHistoryGrid',
    refreshQueue: '#genRefreshQueue', interruptBtn: '#genInterruptBtn',
  },
  buildRequest: (tab, refs) => {
    const payload = {
      prompt: refs.prompt.value,
      negative: refs.negative.value,
      checkpoint: refs.checkpoint.value,
      width: refs.width.value,
      height: refs.height.value,
      steps: refs.steps.value,
      cfg: refs.cfg.value,
      sampler: refs.sampler.value,
      scheduler: refs.scheduler.value,
      seed: refs.seed.value,
    };
    return {
      url: '/api/generate',
      options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    };
  },
  applyDefaults: (tab) => applyGenerateDefaults(tab),
  readyHint: (tab) => `${tab.refs.width.value}×${tab.refs.height.value} · ${tab.refs.steps.value} steps.`,
});

const transformTab = createForgeTab({
  kind: 'transform',
  root: document.getElementById('tab-transform'),
  withImage: true,
  withCompare: true,
  uploadingLabel: 'Uploading image',
  doneToast: 'Image transformed 🔥',
  errorToast: 'Transform failed',
  downloadPrefix: 'pixelkiln_tf',
  sel: {
    dropzone: '#tfDropzone', fileInput: '#tfFileInput', inputPreview: '#tfInputPreview', dropzoneHint: '#tfDropzoneHint',
    positive: '#tfPrompt', negative: '#tfNegative', checkpoint: '#tfCheckpoint',
    maxSize: '#tfMaxSize', denoise: '#tfDenoise', denoiseOut: '#tfDenoiseOut',
    steps: '#tfSteps', stepsOut: '#tfStepsOut', cfg: '#tfCfg', cfgOut: '#tfCfgOut',
    seed: '#tfSeed', sampler: '#tfSampler', scheduler: '#tfScheduler', restoreSize: '#tfRestoreSize',
    runBtn: '#tfRunBtn', hint: '#tfHint', cancelBtn: '#tfCancelBtn',
    resultPlaceholder: '#tfResultPlaceholder', resultLoading: '#tfResultLoading', resultError: '#tfResultError',
    resultErrorText: '#tfResultErrorText', phase: '#tfPhase', progressFill: '#tfProgressFill',
    progressText: '#tfProgressText', compare: '#tfCompare', compareBefore: '#tfCompareBefore',
    compareAfter: '#tfCompareAfter', compareHandle: '#tfCompareHandle', compareBeforeTag: '#tfCompareBeforeTag',
    outputMeta: '#tfOutputMeta', metaList: '#tfOutputMetaList', downloadBtn: '#tfDownloadBtn',
    queueStatus: '#tfQueueStatus', historyGrid: '#tfHistoryGrid',
    refreshQueue: '#tfRefreshQueue', interruptBtn: '#tfInterruptBtn',
  },
  buildRequest: (tab, refs) => {
    const fd = new FormData();
    fd.append('image', tab.imageFile);
    fd.append('prompt', refs.positive.value);
    fd.append('negative', refs.negative.value);
    fd.append('checkpoint', refs.checkpoint.value);
    fd.append('maxSize', refs.maxSize.value);
    fd.append('denoise', refs.denoise.value);
    fd.append('steps', refs.steps.value);
    fd.append('cfg', refs.cfg.value);
    fd.append('sampler', refs.sampler.value);
    fd.append('scheduler', refs.scheduler.value);
    fd.append('seed', refs.seed.value);
    fd.append('restoreSize', refs.restoreSize.checked);
    return { url: '/api/transform', options: { method: 'POST', body: fd } };
  },
  applyDefaults: (tab) => applyTransformDefaults(tab),
  readyHint: (tab) => `Denoise ${Number(tab.refs.denoise.value).toFixed(2)} · up to ${tab.refs.maxSize.value}px.`,
});

state.tabs = { edit: editTab, generate: generateTab, transform: transformTab };

/* ----------------------------- init ----------------------------- */
async function init() {
  bindTabs();
  bindModels();
  bindSettings();
  renderBaseModelOptions();

  // Switch to the tab named in the hash immediately (not only after the
  // async status/config fetches finish), so a reload on #generate stays put.
  const initial = location.hash.replace('#', '') || 'edit';
  showTab(TAB_NAMES.includes(initial) ? initial : 'edit');

  // "Reset to recommended" re-applies the Edit auto-config on demand.
  $('#resetRecommendedBtn').addEventListener('click', () => {
    autoConfigureEditTab(state.tabs.edit);
    toast('Applied recommended settings', 'ok');
  });

  // History delete buttons appear in multiple tabs — delegate globally.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.history-delete');
    if (btn && btn.dataset.promptId) deleteHistory(btn.dataset.promptId);
  });

  // Load independently so one failure doesn't block the rest.
  const [specsRes, statusRes, configRes] = await Promise.allSettled([
    loadSpecs(),
    loadStatus().catch((err) => { state.status = { online: false }; renderStatusPill({ online: false }); throw err; }),
    loadConfig(),
  ]);
  if (specsRes.status === 'rejected') toast(`Specs: ${specsRes.reason.message}`, 'error');
  if (statusRes.status === 'rejected') { /* already toasted */ }
  if (configRes.status === 'rejected') toast(`Config: ${configRes.reason.message}`, 'error');

  applyAllDefaults();
  loadInstalled();
  loadDownloads();
  loadNetwork();
  loadQueue();
  loadHistory();
}

async function loadSpecs() {
  const rec = await api('/api/recommend');
  state.specs = rec.specs;
  state.recommendation = rec.recommendation;
  renderSpecs();
  renderRecBanner();
  renderBaseModelOptions();
}

async function loadConfig() {
  const cfg = await api('/api/config');
  state.config = cfg;
  fillSettingsForm(cfg);
}

/** Show the local + LAN URLs so a phone can be pointed at the right address. */
async function loadNetwork() {
  try {
    const n = await api('/api/network');
    const rows = [['Local', `<a href="${esc(n.localUrl)}">${esc(n.localUrl)}</a>`]];
    if (n.listenOnLan && n.lanUrls.length) {
      n.lanUrls.forEach((x) => rows.push(['LAN', `<a href="${esc(x.url)}">${esc(x.url)}</a> <span class="muted">(${esc(x.iface)})</span>`]));
    } else {
      rows.push(['LAN', n.listenOnLan ? 'no address found' : 'disabled in config']);
    }
    $('#networkList').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  } catch (err) {
    $('#networkList').innerHTML = `<dt>Network</dt><dd>${esc(err.message)}</dd>`;
  }
}

init();
