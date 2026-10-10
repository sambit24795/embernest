/**
 * models-guide.js — the model guide in the UI: welcome screen, "Suggested for you",
 * Create hints, checkpoint badges, the LoRA picker with trigger words, and warnings
 * before a download. Embernest only suggests; nothing downloads without a click.
 *
 * Plain script (no build step). The pure helpers at the top are also loaded by
 * test/models-guide.test.js; the UI part below only runs in a browser.
 */
'use strict';

/* ----------------------------- pure helpers ----------------------------- */
const GUIDE_FAMILY_LABEL = { sd15: 'SD 1.5', sdxl: 'SDXL', pony: 'Pony', illustrious: 'Illustrious', flux: 'Flux', unknown: 'unknown' };
const GUIDE_SDXL_ARCH = new Set(['sdxl', 'pony', 'illustrious']);
const DEFAULT_LORA_STRENGTH = 0.8;
/** Family -> the base-model text the server stores with a download. */
const BASE_LABEL = { sd15: 'SD 1.5', sdxl: 'SDXL 1.0', pony: 'Pony', illustrious: 'Illustrious', flux: 'Flux.1' };

/** Same rules as familyFromText in src/server/model-meta.js (the server is the source of truth). */
function guideFamily(text) {
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

/** yes | no | unknown, same rules as compatible() on the server. */
function guideCompat(a, b) {
  if (!GUIDE_FAMILY_LABEL[a] || !GUIDE_FAMILY_LABEL[b] || a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === b) return 'yes';
  if (GUIDE_SDXL_ARCH.has(a) && GUIDE_SDXL_ARCH.has(b)) return 'unknown';
  return 'no';
}

/** True when `word` is already in the prompt (whole comma-separated item or phrase, case-insensitive). */
function promptHasWord(text, word) {
  const w = String(word).trim().toLowerCase();
  if (!w) return false;
  return String(text).toLowerCase().split(/[,\n]/).some((part) => part.trim() === w)
    || String(text).toLowerCase().includes(w);
}

/**
 * Append a trigger word to the end of a prompt, so a phrase is never split.
 * @param {string} text current prompt
 * @param {string} word trigger word
 * @returns {{ text: string, caret: number, added: boolean }} added=false when it was already there
 */
function insertTriggerWord(text, word) {
  const w = String(word).trim();
  const base = String(text || '').replace(/[\s,]+$/, '');
  if (!w || promptHasWord(text, w)) return { text: String(text || ''), caret: String(text || '').length, added: false };
  const out = base ? `${base}, ${w}` : w;
  return { text: out, caret: out.length, added: true };
}

/**
 * Options for the LoRA dropdown. Incompatible LoRAs are hidden unless showAll.
 * @param {string[]} loras file names
 * @param {Record<string,string>} compat lora name -> yes|no|unknown (missing = unknown)
 * @param {boolean} showAll
 * @returns {{ options: Array<{value:string,label:string,compat:string}>, hidden: number }}
 */
function loraChoices(loras, compat, showAll) {
  const options = [];
  let hidden = 0;
  for (const name of loras) {
    const c = (compat && compat[name]) || 'unknown';
    if (c === 'no' && !showAll) { hidden += 1; continue; }
    const label = c === 'unknown' ? `❔ ${name}` : (c === 'no' ? `${name} (may not work)` : name);
    options.push({ value: name, label, compat: c });
  }
  return { options, hidden };
}

/** Badge text for a checkpoint in a dropdown: known inpainting flag only. */
function checkpointBadge(meta) {
  if (!meta || typeof meta.inpainting !== 'boolean') return '';
  return meta.inpainting ? 'best for Edit' : 'best for Generate';
}

/**
 * The non-blocking hint for a Create mode, or null.
 * @param {'edit'|'generate'|'transform'} kind
 * @param {{inpainting?: boolean|null}|null} meta metadata of the chosen checkpoint
 * @returns {{ id: string, text: string, goal: string }|null}
 */
function guideHint(kind, meta) {
  if (!meta || typeof meta.inpainting !== 'boolean') return null;
  if (kind === 'edit' && !meta.inpainting) {
    return { id: 'edit-regular', goal: 'edit-photos', text: 'Inpainting checkpoints give cleaner edits than the checkpoint you picked.' };
  }
  if (kind !== 'edit' && meta.inpainting) {
    return { id: 'create-inpainting', goal: 'realistic', text: 'This is an inpainting checkpoint. It is made for Edit; a regular checkpoint usually gives better pictures here.' };
  }
  return null;
}

/** One top checkpoint per goal (realistic, edit, anime), preferring the family this GPU runs. */
function pickWelcome(entries, baseModel) {
  const fam = guideFamily(baseModel);
  const want = fam === 'unknown' ? 'sd15' : fam;
  const pool = entries.filter((e) => e.type === 'checkpoint' && !e.nsfw);
  const out = [];
  for (const goal of ['realistic', 'edit-photos', 'anime']) {
    const inGoal = pool.filter((e) => e.goal === goal);
    const pick = inGoal.find((e) => e.family === want) || inGoal[0];
    if (pick) out.push(pick);
  }
  return out;
}

/**
 * A warning to show before downloading a search result, or '' when it looks fine.
 * @param {{type?:string, baseModel?:string, fit?:{level:string,reason?:string}}} item
 * @param {{ checkpointFamilies: string[] }} ctx families of the installed checkpoints
 */
function downloadWarning(item, ctx) {
  const notes = [];
  if (item.fit && item.fit.level === 'no') {
    notes.push(`This looks too big for your GPU${item.fit.reason ? ` (${item.fit.reason})` : ''}. It may be very slow or fail.`);
  }
  const addon = ['lora', 'embedding', 'vae'].includes(String(item.type || '').toLowerCase());
  const fam = guideFamily(item.baseModel);
  const have = (ctx && ctx.checkpointFamilies) || [];
  if (addon && fam !== 'unknown' && have.length && have.every((f) => guideCompat(f, fam) === 'no')) {
    notes.push(`It is for ${GUIDE_FAMILY_LABEL[fam]} checkpoints, but none of your installed checkpoints are. It would not work with them.`);
  }
  return notes.join(' ');
}

/** One plain line: what a search result is and what it works with. */
function whatItIs(item) {
  const type = String(item.type || '').toLowerCase();
  const fam = guideFamily(item.baseModel);
  const label = GUIDE_FAMILY_LABEL[fam];
  const inpaint = /inpaint/i.test([item.name, (item.tags || []).join(' ')].join(' '));
  if (type === 'checkpoint') {
    if (fam === 'unknown') return inpaint ? 'Inpainting checkpoint: best for Edit.' : 'Checkpoint: a full model that draws the picture.';
    return inpaint ? `Inpainting checkpoint (${label}): best for Edit.` : `Checkpoint (${label}): a full model that draws the picture.`;
  }
  const noun = { lora: 'LoRA: a style or detail add-on', embedding: 'Embedding: a tiny add-on word', vae: 'VAE: improves colours and detail' }[type];
  if (!noun) return '';
  return fam === 'unknown' ? `${noun}. Check its page for the base model.` : `${noun}. Use with ${label} checkpoints.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    guideFamily, guideCompat, promptHasWord, insertTriggerWord, loraChoices, checkpointBadge,
    guideHint, pickWelcome, downloadWarning, whatItIs, DEFAULT_LORA_STRENGTH,
  };
}

/* ----------------------------- UI (browser only) ----------------------------- */
if (typeof document !== 'undefined') {
  const guide = {
    meta: {},               // 'folder/name' -> metadata from /api/models/installed
    checkpointFiles: null,  // number of checkpoint files on disk (null = not known yet)
    compat: {},             // checkpoint name -> { checkpoint: family, loras: {name: yes|no|unknown} }
    compatPending: new Set(),
    showAllLoras: false,
    suggest: null,          // { tier, baseModel, goals, suggestions }
    suggestLoading: false,
    goal: null,
    welcomeHidden: false,   // hidden for this page view (Browse) without remembering
  };

  /* ---- per-device memory (hints, welcome); never throws ---- */
  const GUIDE_KEY = 'pixelkilnGuide';
  function guideRead() {
    try { return JSON.parse(localStorage.getItem(GUIDE_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function guideDismissed(id) { return Boolean(guideRead()[id]); }
  function guideDismiss(id) {
    try {
      const all = guideRead();
      all[id] = true;
      localStorage.setItem(GUIDE_KEY, JSON.stringify(all));
    } catch (_) { /* private mode: the hint just comes back next visit */ }
  }

  const metaFor = (folder, name) => guide.meta[`${folder}/${name}`] || null;
  const famName = (f) => GUIDE_FAMILY_LABEL[f] || 'unknown';

  /** Is this checkpoint an inpainting one? Metadata first, file name as a fallback. */
  function isInpaintCheckpoint(name) {
    const m = metaFor('checkpoints', name);
    if (m && typeof m.inpainting === 'boolean') return m.inpainting;
    return /inpaint/i.test(name);
  }

  /** <option> label for a checkpoint, with the best-for badge when it is known. */
  function checkpointOptionLabel(name) {
    const badge = checkpointBadge(metaFor('checkpoints', name));
    return `${esc(name)}${badge ? ` · ${esc(badge)}` : ''}`;
  }

  /* ---- installed metadata ---- */
  function guideSetInstalled(folders) {
    guide.meta = {};
    for (const [folder, files] of Object.entries(folders || {})) {
      for (const f of files) if (f.meta) guide.meta[`${folder}/${f.name}`] = f.meta;
    }
    guide.checkpointFiles = ((folders && folders.checkpoints) || []).filter((f) => /\.(safetensors|ckpt|pt|pth|bin|sft)$/i.test(f.name)).length;
    guide.compat = {};
    refreshGuide();
    loadSuggestions();
  }

  /** Re-render everything that depends on installed models or the engine status. */
  function refreshGuide() {
    if (typeof state !== 'undefined' && state.status && state.status.checkpoints) populateForgeSelects(state.status);
    else Object.values(state.tabs || {}).forEach(refreshTabGuide);
    renderWelcome();
  }

  async function fetchCompat(checkpoint) {
    if (!checkpoint || guide.compat[checkpoint] || guide.compatPending.has(checkpoint)) return;
    guide.compatPending.add(checkpoint);
    try {
      guide.compat[checkpoint] = await api(`/api/models/compatibility?checkpoint=${encodeURIComponent(checkpoint)}`);
    } catch (_) {
      guide.compat[checkpoint] = { checkpoint: null, loras: {} };
    }
    guide.compatPending.delete(checkpoint);
    Object.values(state.tabs).forEach((tab) => {
      if (tab.refs.checkpoint && tab.refs.checkpoint.value === checkpoint) refreshTabGuide(tab);
    });
  }

  /* ---- Create tabs: hint, LoRA picker, trigger chips ---- */
  const promptOf = (tab) => tab.refs.positive || tab.refs.prompt;

  function setupTabGuide(tab) {
    const { checkpoint, lora } = tab.refs;
    if (!checkpoint) return;
    const hint = document.createElement('div');
    hint.className = 'guide-hint note note-info';
    hint.hidden = true;
    checkpoint.closest('.field').after(hint);
    tab.guideHint = hint;
    if (lora) {
      const box = document.createElement('div');
      box.className = 'lora-guide';
      lora.closest('.field-row').after(box);
      tab.guideLora = box;
      lora.addEventListener('change', () => onLoraChosen(tab));
      const p = promptOf(tab);
      if (p) p.addEventListener('input', () => renderTriggerChips(tab));
    }
    checkpoint.addEventListener('change', () => refreshTabGuide(tab));
    hint.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-dismiss-hint]');
      if (!btn) return;
      guideDismiss(btn.dataset.dismissHint);
      hint.hidden = true;
    });
    tab.guideLora && tab.guideLora.addEventListener('click', (e) => {
      if (e.target.closest('[data-lora-all]')) {
        guide.showAllLoras = !guide.showAllLoras;
        Object.values(state.tabs).forEach(refreshTabGuide);
        return;
      }
      const chip = e.target.closest('[data-word]');
      if (chip) addTriggerWord(tab, chip.dataset.word);
    });
  }

  function refreshTabGuide(tab) {
    renderTabHint(tab);
    renderLoraOptions(tab);
  }

  function renderTabHint(tab) {
    const el = tab.guideHint;
    if (!el) return;
    const meta = metaFor('checkpoints', tab.refs.checkpoint.value);
    const h = guideHint(tab.kind, meta);
    if (!h || guideDismissed(h.id)) { el.hidden = true; return; }
    el.innerHTML = `<p>${esc(h.text)}</p>
      <div class="guide-hint-actions">
        <a class="btn btn-sm" href="#tab=models&amp;goal=${esc(h.goal)}">See suggestions</a>
        <button class="btn btn-ghost btn-sm" type="button" data-dismiss-hint="${esc(h.id)}">Dismiss</button>
      </div>`;
    el.hidden = false;
  }

  function renderLoraOptions(tab) {
    const sel = tab.refs.lora;
    if (!sel) return;
    const loras = (state.status && state.status.loras) || [];
    const ckpt = tab.refs.checkpoint ? tab.refs.checkpoint.value : '';
    const compat = ckpt ? guide.compat[ckpt] : null;
    if (ckpt && !compat) fetchCompat(ckpt);
    const { options, hidden } = loraChoices(loras, compat ? compat.loras : {}, guide.showAllLoras);
    const prev = sel.value;
    sel.innerHTML = ['<option value="">None</option>']
      .concat(options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)).join('');
    sel.value = options.some((o) => o.value === prev) ? prev : '';

    const box = tab.guideLora;
    if (!box) return;
    const fam = compat && compat.checkpoint ? famName(compat.checkpoint) : '';
    const notes = [];
    if (!options.length) {
      const what = !loras.length ? 'No LoRAs installed yet.' : `No LoRAs for ${fam || 'this checkpoint'} yet.`;
      notes.push(`<span>${esc(what)} <a href="#tab=models&amp;goal=faces-skin">See suggestions</a></span>`);
    } else if (compat && options.some((o) => o.compat === 'unknown')) {
      notes.push('<span>❔ means Embernest cannot tell if it fits this checkpoint.</span>');
    }
    if (hidden || guide.showAllLoras) {
      const n = hidden ? ` (${hidden} hidden)` : '';
      notes.push(`<button class="chip" type="button" data-lora-all aria-pressed="${guide.showAllLoras}">Show all (may not work)${esc(n)}</button>`);
    }
    box.innerHTML = `<div class="lora-notes">${notes.join('')}</div><div class="trigger-chips" data-triggers></div>`;
    box.classList.toggle('is-empty', !notes.length);
    renderTriggerChips(tab);
  }

  function renderTriggerChips(tab) {
    const box = tab.guideLora && tab.guideLora.querySelector('[data-triggers]');
    if (!box) return;
    const name = tab.refs.lora.value;
    const meta = name ? metaFor('loras', name) : null;
    const words = (meta && meta.triggerWords) || [];
    if (!words.length) { box.innerHTML = ''; box.hidden = true; return; }
    const text = promptOf(tab).value;
    box.hidden = false;
    box.innerHTML = `<span class="trigger-label">Trigger words, tap to add:</span>${words.map((w) => (
      `<button class="chip" type="button" data-word="${esc(w)}" aria-pressed="${promptHasWord(text, w)}">${esc(w)}</button>`
    )).join('')}`;
  }

  function addTriggerWord(tab, word) {
    const el = promptOf(tab);
    const r = insertTriggerWord(el.value, word);
    if (!r.added) { toast('That trigger word is already in your prompt'); return; }
    el.value = r.text;
    el.focus();
    el.setSelectionRange(r.caret, r.caret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onLoraChosen(tab) {
    const name = tab.refs.lora.value;
    if (name && tab.refs.loraStrength) {
      const meta = metaFor('loras', name);
      const rec = meta && Number(meta.recommendedStrength);
      tab.refs.loraStrength.value = rec > 0 ? rec : DEFAULT_LORA_STRENGTH;
      tab.updateOutputs();
    }
    renderTriggerChips(tab);
  }

  /* ---- suggestions ---- */
  async function loadSuggestions() {
    if (guide.suggestLoading) { guide.suggestAgain = true; return; }
    guide.suggestLoading = true;
    guide.suggestAgain = false;
    try {
      guide.suggest = await api('/api/models/suggestions');
      if (!guide.goal || !guide.suggest.goals[guide.goal]) guide.goal = Object.keys(guide.suggest.goals)[0];
    } catch (err) {
      guide.suggest = { error: err.message, goals: {}, suggestions: [] };
    }
    guide.suggestLoading = false;
    renderSuggested();
    renderWelcome();
    if (guide.suggestAgain) loadSuggestions();
  }

  /** Is a download in progress inside this container? Re-rendering would wipe its progress bar. */
  function downloadRunning(root) {
    return [...root.querySelectorAll('.dl:not([hidden]) .dl-status')].some((el) => /^(queued|downloading|starting)/i.test(el.textContent));
  }

  function suggestionItem(s) {
    return {
      downloadUrl: s.downloadUrl, type: s.type, fileName: s.fileName, fileSizeMB: s.sizeMB, provider: s.provider,
      name: s.name, baseModel: BASE_LABEL[s.family] || '',
      homeUrl: s.homeUrl, triggerWords: s.triggerWords || [], recommendedStrength: s.recommendedStrength || null,
      tags: s.inpainting ? ['inpainting'] : [], inpainting: Boolean(s.inpainting),
    };
  }

  function fitLabel(family) {
    const vram = { sd15: 4, sdxl: 8, pony: 8, illustrious: 8, flux: 12 }[family] || 4;
    const fit = fitBadge(vram);
    const text = { good: 'Runs well on your GPU', tight: 'Tight fit for your GPU', no: 'Too big for your GPU', unknown: 'Fit unknown' }[fit.level];
    return `<span class="badge fit-${esc(fit.level)}">${esc(text)}</span>`;
  }

  function suggestCardHtml(s, compact) {
    const home = safeUrl(s.homeUrl);
    const type = `<span class="pill">${esc(s.type)}</span>${infoButtonHtml(s.type === 'checkpoint' && s.inpainting ? 'inpainting' : s.type)}`;
    const tags = [
      `<span class="pill">${esc(famName(s.family))}</span>`,
      s.inpainting ? '<span class="pill pill-inpaint">inpainting</span>' : '',
    ].join('');
    const action = s.installed
      ? '<span class="badge badge-success">Installed</span>'
      : `<button class="btn btn-primary btn-sm" type="button" data-suggest="${esc(s.id)}">Download</button>`;
    const token = s.needsToken ? '<p class="suggest-note">Needs an access token: add it in Settings first.</p>' : '';
    return `
      <article class="card suggest-card" data-sid="${esc(s.id)}">
        <div class="suggest-top"><span class="suggest-type">${type}</span>${tags}${fitLabel(s.family)}</div>
        <h3 class="suggest-title">${esc(s.name)}</h3>
        <p class="suggest-what">${esc(s.what)}</p>
        ${compact ? '' : `<details class="suggest-how"><summary>How to use it</summary><p>${esc(s.howToUse)}</p></details>`}
        <div class="model-meta"><span>${esc(s.sizeMB)} MB</span><span class="suggest-license">${esc(s.license)}</span></div>
        ${token}
        <div class="model-actions">
          ${action}
          ${home ? `<a class="btn btn-ghost btn-sm" href="${esc(home)}" target="_blank" rel="noopener">Open page</a>` : ''}
        </div>
        <div class="dl" hidden>
          <div class="progress"><div class="progress-fill"></div></div>
          <div class="dl-status">Starting…</div>
        </div>
      </article>`;
  }

  function renderSuggested() {
    const sec = document.getElementById('suggestSection');
    if (!sec) return;
    const list = document.getElementById('suggestList');
    const chips = document.getElementById('goalChips');
    const intro = document.getElementById('suggestIntro');
    const data = guide.suggest;
    if (!data) return;
    if (data.error) {
      intro.textContent = `Suggestions are not available right now: ${data.error}`;
      chips.innerHTML = ''; list.innerHTML = '';
      return;
    }
    intro.textContent = `Hand-picked for your GPU (${data.baseModel} class). Nothing is downloaded until you press Download.`;
    chips.innerHTML = Object.entries(data.goals).map(([id, label]) => (
      `<button class="chip" type="button" data-goal="${esc(id)}" aria-pressed="${id === guide.goal}">${esc(label)}</button>`
    )).join('');
    if (downloadRunning(list)) return;
    const items = data.suggestions.filter((s) => s.goal === guide.goal);
    list.innerHTML = items.length
      ? items.map((s) => suggestCardHtml(s, false)).join('')
      : '<div class="empty empty-sm"><p>Nothing suggested here for your GPU yet.</p></div>';
  }

  /* ---- welcome screen ---- */
  function welcomeWanted() {
    const s = typeof state !== 'undefined' ? state.status : null;
    return Boolean(s && s.online && Array.isArray(s.checkpoints) && !s.checkpoints.length
      && guide.checkpointFiles === 0 && !guide.welcomeHidden && !guideDismissed('welcome'));
  }

  function renderWelcome() {
    const el = document.getElementById('welcome');
    if (!el) return;
    const show = welcomeWanted();
    if (!show) { el.hidden = true; document.body.classList.remove('has-welcome'); return; }
    el.hidden = false;
    document.body.classList.add('has-welcome');
    const data = guide.suggest;
    const cards = document.getElementById('welcomeCards');
    if (!data || data.error) {
      cards.innerHTML = data
        ? `<p class="muted">Suggestions are not available right now (${esc(data.error)}). You can still search all models.</p>`
        : '<div class="skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
      return;
    }
    if (downloadRunning(cards)) return;
    cards.innerHTML = pickWelcome(data.suggestions, data.baseModel).map((s) => suggestCardHtml(s, true)).join('');
  }

  /* ---- downloads from suggestion cards ---- */
  function onSuggestClick(e) {
    const goal = e.target.closest('[data-goal]');
    if (goal) { guide.goal = goal.dataset.goal; renderSuggested(); return; }
    const btn = e.target.closest('[data-suggest]');
    if (!btn || !guide.suggest) return;
    const s = guide.suggest.suggestions.find((x) => x.id === btn.dataset.suggest);
    if (!s) return;
    btn.disabled = true;
    downloadModel(suggestionItem(s), btn.closest('.suggest-card'));
  }

  /* ---- warning before downloading a search result ---- */
  function installedCheckpointFamilies() {
    return Object.entries(guide.meta)
      .filter(([k]) => k.startsWith('checkpoints/')).map(([, m]) => m.family).filter(Boolean);
  }

  /** Returns true when the download may start now; false while a warning is being shown. */
  function guideConfirmDownload(item, card) {
    if (card.dataset.warned === '1') return true;
    const warning = downloadWarning(item, { checkpointFamilies: installedCheckpointFamilies() });
    if (!warning) return true;
    card.dataset.warned = '1';
    const box = card.querySelector('.dl-warn');
    box.querySelector('.dl-warn-text').textContent = warning;
    box.hidden = false;
    const btn = card.querySelector('[data-action="download"]');
    btn.textContent = 'Download anyway';
    return false;
  }

  function onWarnCancel(e) {
    const cancel = e.target.closest('[data-warn-cancel]');
    if (!cancel) return;
    const card = cancel.closest('.model-card');
    card.dataset.warned = '';
    card.querySelector('.dl-warn').hidden = true;
    card.querySelector('[data-action="download"]').textContent = 'Download';
  }

  /* ---- deep links and wiring ---- */
  function guideRoute(route) {
    if (route.goal && guide.suggest && guide.suggest.goals[route.goal] && guide.goal !== route.goal) {
      guide.goal = route.goal;
      renderSuggested();
    } else if (route.goal) {
      guide.goal = route.goal; // applied when the suggestions arrive
    }
    if (route.tab === 'models' && route.goal) {
      const sec = document.getElementById('suggestSection');
      if (sec) sec.scrollIntoView({ block: 'start' });
    }
    if (route.explain) openExplainer(route.explain);
  }

  function bindGuide() {
    Object.values(state.tabs).forEach(setupTabGuide);
    const sec = document.getElementById('suggestSection');
    if (sec) sec.addEventListener('click', onSuggestClick);
    const welcome = document.getElementById('welcome');
    if (welcome) {
      welcome.addEventListener('click', (e) => {
        onSuggestClick(e);
        if (e.target.closest('[data-welcome-skip]')) { guideDismiss('welcome'); renderWelcome(); }
        if (e.target.closest('[data-welcome-browse]')) { guide.welcomeHidden = true; renderWelcome(); }
      });
    }
    const results = document.getElementById('modelResults');
    if (results) results.addEventListener('click', onWarnCancel);
    loadSuggestions();
  }

  window.guide = guide;
  window.bindGuide = bindGuide;
  window.guideSetInstalled = guideSetInstalled;
  window.guideRoute = guideRoute;
  window.guideConfirmDownload = guideConfirmDownload;
  window.isInpaintCheckpoint = isInpaintCheckpoint;
  window.checkpointOptionLabel = checkpointOptionLabel;
  window.refreshTabGuide = refreshTabGuide;
  window.renderLoraOptions = renderLoraOptions;
  window.renderWelcome = renderWelcome;
}
