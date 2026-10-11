/**
 * app.js — Embernest UI logic (no build step, plain JS).
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

/** A parsed http(s) URL, or null. javascript:, data: and anything unparsable are refused. */
function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch (_) {
    return null;
  }
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

/* Pairing is a cookie set by GET /pair; the old per-device token in localStorage
   is no longer used. Remove it once so it does not linger. */
function removeLegacyTokens() {
  try {
    localStorage.removeItem('pixelkilnToken');
    localStorage.removeItem('emberToken');
  } catch (_) { /* private mode — ignore */ }
}

/** Show the pairing card (full screen) when this device has no valid cookie. */
function showPairCard() {
  const card = $('#pairCard');
  if (card) card.hidden = false;
}

/** Pair by pasting the token: /pair sets the cookie and redirects to /. */
function pairWithToken() {
  const value = ($('#pairTokenInput').value || '').trim();
  if (!value) { toast('Paste the access token first', 'error'); return; }
  location.assign(`/pair?token=${encodeURIComponent(value)}`);
}

/** fetch + JSON + error throwing. The pairing cookie is sent automatically. */
async function api(path, options) {
  const res = await fetch(path, options || {});
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && data.pair) {
      showPairCard();
      throw new Error('This device is not paired yet.');
    }
    throw new Error(data.error || data.detail || `${res.status} ${res.statusText}`);
  }
  return data;
}

let toastTimer;
/** Show a toast. `action` ({ label, run }) adds a button, e.g. "View". */
function toast(message, kind = '', action = null) {
  const el = $('#toast');
  el.className = `toast ${kind ? `is-${kind}` : ''}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.append(' ', btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 8000 : 4200);
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

/* ----------------------------- tabs / routing -----------------------------
   Deep links: #tab=chat|create|gallery|models|settings, plus &mode=generate|transform|edit
   for Create, &q=<search> for Models and &c=<id> / &new=1 / &persona=<id>&edit=1 for Chat. Old links (#edit, #generate, #models, …) still work.
   Internally every screen is a panel (#tab-<panel>); the three Create modes are
   the panels "generate", "transform" and "edit". */
const MAIN_TABS = ['chat', 'create', 'gallery', 'models', 'settings'];
const CREATE_MODES = ['generate', 'transform', 'edit'];
const DEFAULT_TAB = 'create';
const DEFAULT_MODE = 'generate';
const PANELS = ['chat', 'edit', 'generate', 'transform', 'gallery', 'models', 'settings'];

/** Parse location.hash into { tab, mode }. Unknown values fall back to the defaults. */
function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#/, '');
  const params = new URLSearchParams(raw.includes('=') ? raw : '');
  let tab = params.get('tab');
  let mode = params.get('mode');
  if (!raw.includes('=') && raw) { tab = raw; } // legacy "#edit"
  if (CREATE_MODES.includes(tab)) { mode = tab; tab = 'create'; }
  const galleryMode = tab === 'gallery' && CREATE_MODES.includes(mode) ? mode : '';
  if (!MAIN_TABS.includes(tab)) tab = DEFAULT_TAB;
  if (!CREATE_MODES.includes(mode)) mode = DEFAULT_MODE;
  const q = tab === 'models' ? (params.get('q') || '').trim() : '';
  // Model guide deep links: &goal=<suggestion goal> and &explain=<topic> (opens a "What's this?" sheet).
  const goal = tab === 'models' ? (params.get('goal') || '') : '';
  const explain = params.get('explain') || '';
  // Chat deep links: c=<conversation id>, new=1 (persona picker), persona=<id>&edit=1, focus=memories, menu=1.
  const chat = tab === 'chat' ? {
    c: params.get('c') || '', new: params.get('new') === '1', persona: params.get('persona') || '',
    edit: params.get('edit') === '1', focus: params.get('focus') || '', menu: params.get('menu') === '1',
  } : null;
  const view = params.get('view') || ''; // open the image viewer on a result (promptId)
  return { tab, mode, q, goal, explain, chat, galleryMode, view, hash: raw };
}

/** Name of the panel that is on screen for a route. */
function panelFor(route) {
  return route.tab === 'create' ? route.mode : route.tab;
}

function currentPanel() {
  return panelFor(parseRoute());
}

function showRoute(route = parseRoute()) {
  const name = panelFor(route);
  $$('.nav-item').forEach((a) => {
    if (a.dataset.nav === route.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const modes = $('#createModes');
  if (modes) {
    modes.hidden = route.tab !== 'create';
    modes.querySelectorAll('a').forEach((a) => {
      if (a.dataset.mode === route.mode) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }
  PANELS.forEach((id) => {
    $(`#tab-${id}`).hidden = id !== name;
  });

  // Lazy-load the model browser the first time it's opened. A "&q=…" deep link
  // fills the search box and runs that search (once per distinct q).
  if (name === 'models') {
    if (route.q && route.q !== state.deepQuery) {
      state.deepQuery = route.q;
      state.modelsLoadedOnce = true;
      $('#searchQuery').value = route.q;
      runSearch();
    } else if (!state.modelsLoadedOnce) {
      state.modelsLoadedOnce = true;
      runSearch();
    }
  }
  if (name === 'models') loadDownloads();
  guideRoute(route);
  galleryRoute(route, name);
  if (name === 'chat') loadChat(route).catch((err) => showChatError(err.message, err.hint));
  updateAllRunEnabled();
}

function bindTabs() {
  // Nav items and mode links are plain #hash links, so back/forward just work.
  window.addEventListener('hashchange', () => showRoute());
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
  $('#editRecText').innerHTML = `Recommended for <strong>${esc(s.gpu)}</strong> (${esc(s.vramGB)} GB): `
    + `<strong>${esc(rec.baseModel)}</strong>, max ${esc(rec.maxSize)}px, ${rec.lowvram ? 'low-vram' : 'full-vram'}`;
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
    r.checkpoint.value = ckpts.find(isInpaintCheckpoint) || ckpts[0];
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
  refreshTabGuide(tab);
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
/** Order checkpoints for a tab: Edit prefers inpainting, others prefer regular. */
function sortCheckpointsForTab(tab, ckpts) {
  const isInpaint = (v) => isInpaintCheckpoint(v);
  return [...ckpts].sort((a, b) => {
    const ai = isInpaint(a) ? 1 : 0;
    const bi = isInpaint(b) ? 1 : 0;
    return tab.kind === 'edit' ? bi - ai : ai - bi;
  });
}

function populateForgeSelects(s) {
  const ckpts = s.checkpoints || [];
  for (const tab of Object.values(state.tabs)) {
    const { checkpoint, sampler, scheduler } = tab.refs;
    if (checkpoint) {
      fillSelect(checkpoint, sortCheckpointsForTab(tab, ckpts), 'No checkpoint installed', checkpointOptionLabel);
    }
    fillSelect(sampler, s.samplers, 'dpmpp_2m');
    fillSelect(scheduler, s.schedulers, 'karras');
  }
  const mergeA = $('#mergeA');
  const mergeB = $('#mergeB');
  if (mergeA) fillSelect(mergeA, ckpts, 'No checkpoint', checkpointOptionLabel);
  if (mergeB) fillSelect(mergeB, ckpts, 'No checkpoint', checkpointOptionLabel);

  // LoRA dropdowns, hints and trigger chips come from the model guide (compatible LoRAs only).
  const loras = s.loras || [];
  Object.values(state.tabs).forEach(refreshTabGuide);
  renderWelcome();

  // LoRA merge panel.
  const mlA = $('#mergeLoraA');
  const mlB = $('#mergeLoraB');
  if (mlA) fillSelect(mlA, loras, 'No LoRA');
  if (mlB) fillSelect(mlB, loras, 'No LoRA');

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

  const tab = { kind: opts.kind, opts, refs, busy: false, imageFile: null };

  tab.updateOutputs = () => {
    if (refs.denoise && refs.denoiseOut) refs.denoiseOut.textContent = Number(refs.denoise.value).toFixed(2);
    if (refs.steps && refs.stepsOut) refs.stepsOut.textContent = refs.steps.value;
    if (refs.cfg && refs.cfgOut) refs.cfgOut.textContent = Number(refs.cfg.value).toFixed(1);
    if (refs.loraStrength && refs.loraStrengthOut) refs.loraStrengthOut.textContent = Number(refs.loraStrength.value).toFixed(2);
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

  tab.run = async () => {
    if (tab.busy) return;
    if (opts.withImage && !tab.imageFile) return;
    // busy only covers the hand-off; the job then lives in the feed, so more can be queued.
    tab.busy = true;
    tab.updateRunEnabled();
    if (refs.runBtn) {
      const spin = refs.runBtn.querySelector('.spinner-mini');
      if (spin) spin.hidden = false;
    }
    try {
      const { url, options } = opts.buildRequest(tab, refs);
      const data = await api(url, options);
      feedTrack(data.job);
      if (isPhone()) toast('Started: progress is below the form');
    } catch (err) {
      toast(`${opts.errorToast || 'Job failed'}: ${err.message}`, 'error');
    } finally {
      tab.busy = false;
      if (refs.runBtn) refs.runBtn.querySelector('.spinner-mini').hidden = true;
      tab.updateRunEnabled();
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
    tab.setImage = setImage; // exposed for the global clipboard-paste handler
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
  ['denoise', 'steps', 'cfg', 'loraStrength'].forEach((role) => {
    if (refs[role]) refs[role].addEventListener('input', tab.updateOutputs);
  });
  if (refs.checkpoint && opts.onCheckpointChange) {
    refs.checkpoint.addEventListener('change', () => opts.onCheckpointChange(tab));
  }
  return tab;
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
  $$('#typeChips .chip').forEach((chip) => chip.addEventListener('click', () => {
    $('#filterType').value = chip.dataset.type || '';
    $$('#typeChips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    runSearch();
  }));
  ['#filterNsfw', '#filterInpainting', '#filterSort', '#filterBaseModel', '#filterLimit']
    .forEach((id) => $(id).addEventListener('change', runSearch));
  $('#refreshInstalled').addEventListener('click', loadInstalled);
  $('#modelResults').addEventListener('click', onModelResultsClick);
  $('#installedList').addEventListener('click', (e) => {
    const btn = e.target.closest('.installed-delete');
    if (btn) deleteInstalledModel(btn.dataset.folder, btn.dataset.name);
  });

  const ratioSlider = $('#mergeRatio');
  const ratioVal = $('#mergeRatioVal');
  if (ratioSlider && ratioVal) {
    ratioSlider.addEventListener('input', () => { ratioVal.textContent = `${Math.round(ratioSlider.value * 100)}%`; });
  }
  $('#mergeBtn').addEventListener('click', mergeCheckpoints);

  const saSlider = $('#mergeLoraStrengthA');
  const sbSlider = $('#mergeLoraStrengthB');
  const saVal = $('#mergeLoraStrengthAVal');
  const sbVal = $('#mergeLoraStrengthBVal');
  if (saSlider && saVal) saSlider.addEventListener('input', () => { saVal.textContent = Number(saSlider.value).toFixed(2); });
  if (sbSlider && sbVal) sbSlider.addEventListener('input', () => { sbVal.textContent = Number(sbSlider.value).toFixed(2); });
  const mlBtn = $('#mergeLoraBtn');
  if (mlBtn) mlBtn.addEventListener('click', mergeLoras);
}

/** Guess the architecture family from a checkpoint filename. */
function guessCheckpointFamily(name) {
  const n = String(name || '').toLowerCase();
  if (/flux/.test(n)) return 'Flux';
  if (/sd ?3|sd3/.test(n)) return 'SD 3';
  if (/pony|illustrious|noob|sdxl|\bxl\b/.test(n)) return 'SDXL';
  if (/sd ?2|sd2/.test(n)) return 'SD 2';
  return 'SD 1.5';
}

/** Merge two same-base checkpoints and save the result. */
async function mergeCheckpoints() {
  const btn = $('#mergeBtn');
  const status = $('#mergeStatus');
  const ckptA = $('#mergeA').value;
  const ckptB = $('#mergeB').value;
  if (!ckptA || !ckptB) { toast('Pick two checkpoints', 'error'); return; }

  const famA = guessCheckpointFamily(ckptA);
  const famB = guessCheckpointFamily(ckptB);
  if (famA !== famB) {
    const proceed = confirm(
      `⚠️ Different base models — this merge will most likely fail.\n\n` +
      `A: ${ckptA} (${famA})\nB: ${ckptB} (${famB})\n\nContinue anyway?`
    );
    if (!proceed) return;
  }

  btn.disabled = true;
  status.textContent = 'Merging… (can take a minute)';
  try {
    const data = await api('/api/models/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ckptA, ckptB, ratio: Number($('#mergeRatio').value), filename: $('#mergeName').value }),
    });
    status.textContent = '';
    toast(data.message || 'Merged — restart ComfyUI to use it', 'ok');
    loadInstalled();
  } catch (err) {
    status.textContent = '';
    toast(`Merge failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

/** Merge two same-base LoRAs into a single .safetensors LoRA. */
async function mergeLoras() {
  const btn = $('#mergeLoraBtn');
  const status = $('#mergeLoraStatus');
  const loraA = $('#mergeLoraA').value;
  const loraB = $('#mergeLoraB').value;
  if (!loraA || !loraB) { toast('Pick two LoRAs', 'error'); return; }

  btn.disabled = true;
  status.textContent = 'Merging…';
  try {
    const data = await api('/api/models/merge-loras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loraA,
        loraB,
        strengthA: Number($('#mergeLoraStrengthA').value),
        strengthB: Number($('#mergeLoraStrengthB').value),
        filename: $('#mergeLoraName').value,
      }),
    });
    status.textContent = '';
    toast(data.message || 'Merged — restart ComfyUI to use it', 'ok');
    loadInstalled();
  } catch (err) {
    status.textContent = '';
    toast(`LoRA merge failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
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

/** True when a model looks like an inpainting variant. */
function isInpaintingModel(item) {
  return /inpaint/i.test([item.name, item.type, (item.tags || []).join(' ')].join(' '));
}

function renderModels(data) {
  const errors = (data.providers || []).filter((p) => p.error);
  let items = data.items;
  const inpaintingOnly = Boolean($('#filterInpainting') && $('#filterInpainting').checked);
  if (inpaintingOnly) items = items.filter(isInpaintingModel);

  $('#modelsHint').textContent = `${items.length} result${items.length === 1 ? '' : 's'}`
    + (inpaintingOnly ? ' · inpainting only' : '');
  const note = errors.length
    ? `${errors.map((e) => e.provider).join(', ')} didn't respond, showing the other results (${errors.map((e) => `${e.provider}: ${e.error}`).join('; ')})`
    : '';
  const noteEl = $('#modelsNote');
  noteEl.textContent = note;
  noteEl.hidden = !note;

  if (!items.length) {
    $('#modelResults').innerHTML = '<div class="empty model-empty"><h3>No models found</h3><p>Try another search, a different type, or another provider.</p></div>';
    return;
  }
  $('#modelResults').innerHTML = items.map((item, index) => modelCardHtml(item, index)).join('');
  wireModelThumbs($('#modelResults'));
}

const TYPE_ICONS = { checkpoint: '◈', lora: '✦', vae: '◐', controlnet: '⌖', upscaler: '⤢', embedding: '❖' };

/** Gradient + type icon + base model label, used when a card has no (working) picture. */
function placeholderHtml(item) {
  const p = item.placeholder || {};
  const hue = Math.round(Number(p.hue)) || 0;
  const hue2 = Math.round(Number(p.hue2)) || 40;
  const icon = TYPE_ICONS[item.type] || '▧';
  return `<div class="model-thumb model-thumb-ph" style="background:linear-gradient(135deg,hsl(${hue} 45% 30%),hsl(${hue2} 50% 18%))">
      <span class="ph-icon">${esc(icon)}</span>${item.baseModel ? `<span class="ph-label">${esc(item.baseModel)}</span>` : ''}</div>`;
}

/** Swap broken images/videos for the placeholder; play preview videos on hover/touch. */
function wireModelThumbs(root) {
  root.querySelectorAll('.model-card').forEach((card) => {
    const media = card.querySelector('img.model-thumb, video.model-thumb');
    if (!media) return;
    const item = state.results[Number(card.querySelector('[data-index]')?.dataset.index)];
    media.addEventListener('error', () => {
      const tpl = document.createElement('template');
      tpl.innerHTML = placeholderHtml(item || {});
      media.replaceWith(tpl.content.firstElementChild);
    }, { once: true });
    if (media.tagName === 'VIDEO') {
      const play = () => { media.play().catch(() => {}); };
      card.addEventListener('mouseenter', play);
      card.addEventListener('touchstart', play, { passive: true });
      card.addEventListener('mouseleave', () => media.pause());
    }
  });
}

function modelCardHtml(item, index) {
  const thumb = safeUrl(item.thumbnail);
  const home = safeUrl(item.homeUrl);
  const fit = item.fit || null;
  const tags = [];
  if (item.type) tags.push(`<span class="pill">${esc(item.type)}</span>`);
  if (item.baseModel) tags.push(`<span class="pill">${esc(item.baseModel)}</span>`);
  if (isInpaintingModel(item)) tags.push('<span class="pill pill-inpaint">inpainting</span>');
  const stats = [];
  if (item.fileSizeMB != null) stats.push(`<span title="File size">${esc(item.fileSizeMB)} MB</span>`);
  if (item.downloads != null) stats.push(`<span title="Downloads">&#11015; ${Number(item.downloads).toLocaleString()}</span>`);
  if (item.likes != null) stats.push(`<span title="Likes">&#9829; ${Number(item.likes).toLocaleString()}</span>`);

  return `
    <article class="model-card">
      ${thumb && item.thumbnailType === 'video'
        ? `<video class="model-thumb" src="${esc(thumb)}"${safeUrl(item.thumbnailPoster) ? ` poster="${esc(item.thumbnailPoster)}"` : ''} muted loop playsinline preload="none"></video>`
        : thumb
          ? `<img class="model-thumb" src="${esc(thumb)}" alt="" loading="lazy" />`
          : placeholderHtml(item)}
      <div class="model-body">
        <div class="model-top">
          <span class="model-prov">${esc(item.provider)}</span>
          <span class="badge fit-${esc(fit ? fit.level : 'unknown')}" title="${esc(fit ? fit.reason : '')}">${esc(fit ? fit.label : 'Unknown fit')}</span>
        </div>
        <h3 class="model-title">${esc(item.name)}</h3>
        <p class="model-what">${esc(whatItIs(item))}</p>
        <div class="model-tags">${tags.join('')}</div>
        <p class="model-desc">${esc(item.description || '')}</p>
        <div class="model-meta">${stats.join('')}</div>
        <div class="model-actions">
          <button class="btn btn-primary btn-sm" type="button" data-index="${index}" data-action="download"${item.downloadUrl ? '' : ' disabled'}>Download</button>
          ${home ? `<a class="btn btn-ghost btn-sm" href="${esc(home)}" target="_blank" rel="noopener">Open</a>` : ''}
        </div>
        <div class="dl-warn note" hidden>
          <p class="dl-warn-text"></p>
          <button class="btn btn-ghost btn-sm" type="button" data-warn-cancel>Cancel</button>
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
  const card = btn.closest('.model-card');
  // A mismatch (too big for the GPU, wrong family) warns first; pressing again downloads anyway.
  if (item && guideConfirmDownload(item, card)) downloadModel(item, card);
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
        // Remembered with the file so the guide knows what it is (family, trigger words, strength).
        name: item.name,
        baseModel: item.baseModel,
        homeUrl: item.homeUrl,
        tags: item.tags,
        triggerWords: item.triggerWords || item.trainedWords,
        recommendedStrength: item.recommendedStrength,
        inpainting: item.inpainting === true || isInpaintingModel(item),
      }),
    });
    trackDownload(data.job, card);
    loadDownloads();
  } catch (err) {
    const again = card.querySelector('[data-suggest]');
    if (again) again.disabled = false;
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
      if (j.status === 'done') { toast(`Installed ${j.fileName} — restart ComfyUI to use it`, 'ok'); loadInstalled(); loadStatus().catch(() => {}); }
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
      if (j.status === 'done') { toast(`Installed ${j.fileName} — restart ComfyUI to use it`, 'ok'); loadInstalled(); loadStatus().catch(() => {}); }
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
      $('#downloadsList').innerHTML = '<div class="empty empty-sm"><p>No downloads yet. Pick a model above and press Download.</p></div>';
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
    guideSetInstalled(data.folders);
    const groups = Object.entries(data.folders).filter(([, files]) => files.length);
    if (!groups.length) {
      $('#installedList').innerHTML = '<div class="empty empty-sm"><p>No models installed yet. Download one above.</p></div>';
      return;
    }
    $('#installedList').innerHTML = groups.map(([folder, files]) => `
      <div class="installed-group card">
        <h4>${esc(folder)} <span class="count">${files.length}</span></h4>
        ${files.map((f) => `
          <div class="installed-item">
            <span class="installed-name">${esc(f.name)}${installedPills(f.meta)}</span>
            <span class="installed-actions">
              <span class="mono">${esc(f.sizeMB)} MB</span>
              <button class="installed-delete btn btn-ghost btn-sm btn-icon-sm" type="button" data-folder="${esc(folder)}" data-name="${esc(f.name)}" title="Delete ${esc(f.name)}" aria-label="Delete ${esc(f.name)}">&times;</button>
            </span>
          </div>`).join('')}
      </div>`).join('');
  } catch (err) {
    $('#installedList').innerHTML = `<p class="muted">Could not list installed models: ${esc(err.message)}</p>`;
  }
}

/** Small family / inpainting / trigger-word pills for an installed file (nothing when unknown). */
function installedPills(meta) {
  if (!meta) return '';
  const pills = [];
  if (meta.family && meta.family !== 'unknown') pills.push(`<span class="pill">${esc(meta.baseModel || meta.family)}</span>`);
  if (meta.inpainting) pills.push('<span class="pill pill-inpaint">inpainting</span>');
  const words = meta.triggerWords || [];
  if (words.length) pills.push(`<span class="pill" title="${esc(words.join(', '))}">${words.length} trigger word${words.length === 1 ? '' : 's'}</span>`);
  return pills.length ? ` <span class="installed-pills">${pills.join('')}</span>` : '';
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
  $('#signOutBtn').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch (err) {
      toast(`Sign out failed: ${err.message}`, 'error');
      return;
    }
    showPairCard();
  });
}

/** Offline app shell. Browsers only allow service workers on secure origins (https or localhost). */
function registerServiceWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker not registered:', err));
}

/** Pairing card: paste-token button and Enter key. */
function bindPairCard() {
  $('#pairTokenBtn').addEventListener('click', pairWithToken);
  $('#pairTokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pairWithToken();
  });
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
  $('#cfgComfyUrl').textContent = cfg.comfyUrl || '—';
  $('#cfgComfyMode').textContent = cfg.comfyMode ? `(${cfg.comfyMode})` : '';
  const restartBtn = $('#restartComfyBtn');
  if (restartBtn) restartBtn.hidden = cfg.comfyMode !== 'managed';
  $('#cfgPort').value = cfg.port || 3000;
  $('#cfgLan').checked = Boolean(cfg.listenOnLan);
  $('#cfgSearxng').value = cfg.chat?.search?.searxngUrl || '';
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
}

async function saveSettings() {
  const tokens = {
    civitai: $('#tokCivitai').value.trim(),
    hf: $('#tokHf').value.trim(),
  };
  const body = {
    port: Number($('#cfgPort').value),
    listenOnLan: $('#cfgLan').checked,
    chat: { search: { searxngUrl: $('#cfgSearxng').value.trim() } },
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
    ['#tokCivitai', '#tokHf'].forEach((id) => { $(id).value = ''; });
    fillSettingsForm(res.config);
    state.config = res.config;
    toast(res.restartRequired ? 'Saved — restart Embernest for port/LAN changes' : 'Settings saved', 'ok');
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
  downloadPrefix: 'embernest',
  sel: {
    dropzone: '#dropzone', fileInput: '#fileInput', inputPreview: '#inputPreview', dropzoneHint: '#dropzoneHint',
    positive: '#positive', negative: '#negative', checkpoint: '#checkpointSelect',
    maxSize: '#maxSize', denoise: '#denoise', denoiseOut: '#denoiseOut',
    steps: '#steps', stepsOut: '#stepsOut', cfg: '#cfg', cfgOut: '#cfgOut',
    seed: '#seed', sampler: '#sampler', scheduler: '#scheduler',
    lora: '#lora', loraStrength: '#loraStrength', loraStrengthOut: '#loraStrengthOut',
    preserveFace: '#preserveFace', restoreSize: '#restoreSize', baseModelSelect: '#baseModelSelect',
    runBtn: '#runBtn', hint: '#editHint',
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
    if (refs.lora && refs.lora.value) {
      fd.append('loraName', refs.lora.value);
      fd.append('loraStrength', refs.loraStrength.value);
    }
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
  downloadPrefix: 'embernest_gen',
  sel: {
    prompt: '#genPrompt', negative: '#genNegative', checkpoint: '#genCheckpoint',
    width: '#genWidth', height: '#genHeight',
    steps: '#genSteps', stepsOut: '#genStepsOut', cfg: '#genCfg', cfgOut: '#genCfgOut',
    seed: '#genSeed', sampler: '#genSampler', scheduler: '#genScheduler',
    lora: '#genLora', loraStrength: '#genLoraStrength', loraStrengthOut: '#genLoraStrengthOut',
    runBtn: '#genRunBtn', hint: '#genHint',
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
    if (refs.lora && refs.lora.value) {
      payload.loraName = refs.lora.value;
      payload.loraStrength = Number(refs.loraStrength.value);
    }
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
  downloadPrefix: 'embernest_tf',
  sel: {
    dropzone: '#tfDropzone', fileInput: '#tfFileInput', inputPreview: '#tfInputPreview', dropzoneHint: '#tfDropzoneHint',
    positive: '#tfPrompt', negative: '#tfNegative', checkpoint: '#tfCheckpoint',
    maxSize: '#tfMaxSize', denoise: '#tfDenoise', denoiseOut: '#tfDenoiseOut',
    steps: '#tfSteps', stepsOut: '#tfStepsOut', cfg: '#tfCfg', cfgOut: '#tfCfgOut',
    seed: '#tfSeed', sampler: '#tfSampler', scheduler: '#tfScheduler', restoreSize: '#tfRestoreSize',
    lora: '#tfLora', loraStrength: '#tfLoraStrength', loraStrengthOut: '#tfLoraStrengthOut',
    runBtn: '#tfRunBtn', hint: '#tfHint',
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
    if (refs.lora && refs.lora.value) {
      fd.append('loraName', refs.lora.value);
      fd.append('loraStrength', refs.loraStrength.value);
    }
    fd.append('restoreSize', refs.restoreSize.checked);
    return { url: '/api/transform', options: { method: 'POST', body: fd } };
  },
  applyDefaults: (tab) => applyTransformDefaults(tab),
  readyHint: (tab) => `Denoise ${Number(tab.refs.denoise.value).toFixed(2)} · up to ${tab.refs.maxSize.value}px.`,
});

state.tabs = { edit: editTab, generate: generateTab, transform: transformTab };

/* ----------------------------- init ----------------------------- */
async function init() {
  removeLegacyTokens();
  bindPairCard();
  registerServiceWorker();
  bindTabs();
  bindModels();
  bindSettings();
  bindChat();
  bindGuide();
  bindViewer();
  bindGallery();
  renderBaseModelOptions();

  // Switch to the tab named in the hash immediately (not only after the
  // async status/config fetches finish), so a reload on #generate stays put.
  showRoute();
  feedInit();

  // "Reset to recommended" re-applies the Edit auto-config on demand.
  $('#resetRecommendedBtn').addEventListener('click', () => {
    autoConfigureEditTab(state.tabs.edit);
    toast('Applied recommended settings', 'ok');
  });

  // Paste a clipboard image straight into the active image tab (Edit/Transform).
  document.addEventListener('paste', (e) => {
    const tab = state.tabs[currentPanel()];
    if (!tab || typeof tab.setImage !== 'function') return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          tab.setImage(file);
          toast('Image pasted', 'ok');
        }
        break;
      }
    }
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
}

async function loadSpecs() {
  const rec = await api('/api/recommend');
  state.specs = rec.specs;
  state.recommendation = rec.recommendation;
  renderSpecs();
  renderRecBanner();
  renderBaseModelOptions();
  refreshExplainer();
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
