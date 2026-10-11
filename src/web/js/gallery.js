/**
 * gallery.js — the live feed on Create (running/queued jobs + recent results),
 * the image viewer and the Gallery tab. Classic script, loaded before app.js; it
 * uses the helpers defined there ($, $$, esc, api, toast, state, bindCompare,
 * downloadResult, showRoute) when its functions run.
 * Everything that reaches innerHTML goes through esc(); image URLs must be our own /api/image proxy.
 */
'use strict';

const TERMINAL_STATUS = ['done', 'error', 'cancelled', 'blocked'];
const MODE_LABEL = { generate: 'Generate', transform: 'Transform', edit: 'Edit' };
const FEED_LIMIT = 12;
const GALLERY_PAGE = 24;
const POLL_MS = 4000;

/** Only same-origin image proxy URLs are ever used as an <img> source. */
function proxyUrl(url) {
  return typeof url === 'string' && url.startsWith('/api/image?') ? url : '';
}

const modeLabel = (mode) => MODE_LABEL[mode] || 'Image';

/** One thumbnail (feed and gallery). `item` is a /api/history item. */
function thumbHtml(item, { selectable = false, selected = false, isNew = false } = {}) {
  const img = item.images[0];
  const label = `${modeLabel(item.mode)} result${item.prompt ? `: ${item.prompt.slice(0, 60)}` : ''}`;
  return `<div class="thumb${isNew ? ' is-new' : ''}${selected ? ' is-selected' : ''}" data-id="${esc(item.promptId)}">
    <button class="thumb-btn" type="button" aria-label="${esc(label)}"${selectable ? ` aria-pressed="${selected}"` : ''}>
      <img src="${esc(proxyUrl(img.url))}" alt="" loading="lazy" decoding="async" />
    </button>
    ${item.mode ? `<span class="badge thumb-badge">${esc(modeLabel(item.mode))}</span>` : ''}
    ${selectable ? `<span class="thumb-check" aria-hidden="true">${selected ? '&#10003;' : ''}</span>` : ''}
  </div>`;
}

/* ============================== live feed ============================== */
const feed = {
  jobs: new Map(), // id -> latest job snapshot (active, or finished while we watched)
  streams: new Map(), // id -> EventSource
  failed: new Map(), // id -> job (dismissable error cards)
  recent: [], recentIds: null, timer: null,
};

function feedInit() {
  $('#feedJobs').addEventListener('click', (e) => {
    const card = e.target.closest('[data-job]');
    if (!card) return;
    if (e.target.closest('[data-cancel]')) feedCancel(card.dataset.job);
    if (e.target.closest('[data-dismiss]')) { feed.failed.delete(card.dataset.job); renderJobs(); }
  });
  $('#feedRecent').addEventListener('click', (e) => {
    const thumb = e.target.closest('.thumb');
    if (thumb) viewer.open(feed.recent, feed.recent.findIndex((i) => i.promptId === thumb.dataset.id));
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) feedPoll(); });
  feedPoll();
  loadRecent();
}

/** Start following a job (from a submit, or one found on the server). */
function feedTrack(job) {
  if (!job || !job.id) return;
  if (TERMINAL_STATUS.includes(job.status)) { if (feed.jobs.has(job.id)) feedJobUpdate(job); return; }
  feed.jobs.set(job.id, job);
  if (!feed.streams.has(job.id)) {
    const es = new EventSource(`/api/jobs/${job.id}/events`);
    feed.streams.set(job.id, es);
    es.onmessage = (ev) => { try { feedJobUpdate(JSON.parse(ev.data)); } catch (_) { /* ignore */ } };
    es.onerror = () => { /* the poll catches anything the stream misses */ };
  }
  renderJobs();
}

function feedJobUpdate(job) {
  const prev = feed.jobs.get(job.id);
  const terminal = TERMINAL_STATUS.includes(job.status);
  if (!prev && terminal) return; // already handled (duplicate final event) or never tracked
  feed.jobs.set(job.id, job);
  if (!terminal) { renderJobs(); return; }
  const es = feed.streams.get(job.id);
  if (es) { es.close(); feed.streams.delete(job.id); }
  feed.jobs.delete(job.id);
  if (job.status === 'done') feedDone(job);
  else if (job.status === 'cancelled') toast('Cancelled');
  else {
    feed.failed.set(job.id, job);
    toast(`${modeLabel(job.kind)} failed: ${job.error || 'unknown error'}`, 'error');
  }
  renderJobs();
}

/** A job finished while we were watching: refresh Recent, highlight it, offer to view it. */
async function feedDone(job) {
  await loadRecent(job.promptId);
  const item = feed.recent.find((i) => i.promptId === job.promptId);
  toast('Image ready', 'ok', item ? { label: 'View', run: () => viewer.open(feed.recent, feed.recent.indexOf(item)) } : null);
  if (gallery.active) galleryLoad(true);
}

async function feedCancel(id) {
  try { await api(`/api/jobs/${id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, 'error'); }
}

/** Discover jobs from other devices/tabs/chat and catch finishes the streams missed. */
async function feedPoll() {
  clearTimeout(feed.timer);
  try {
    if (!document.hidden) {
      const { jobs } = await api('/api/jobs');
      for (const job of jobs) {
        if (TERMINAL_STATUS.includes(job.status)) { if (feed.jobs.has(job.id)) feedJobUpdate(job); } else feedTrack(job);
      }
    }
  } catch (_) { /* offline or unpaired: try again later */ }
  feed.timer = setTimeout(feedPoll, POLL_MS);
}

/** Load the newest results into the Recent grid. `highlightId` marks one as new. */
async function loadRecent(highlightId) {
  try {
    const data = await api(`/api/history?limit=${FEED_LIMIT}`);
    const before = feed.recentIds;
    feed.recent = data.items;
    feed.recentIds = new Set(data.items.map((i) => i.promptId));
    renderRecent((id) => id === highlightId || (before && !before.has(id)));
  } catch (err) {
    $('#feedRecent').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

function renderRecent(isNew = () => false) {
  const el = $('#feedRecent');
  el.innerHTML = feed.recent.length
    ? feed.recent.map((item) => thumbHtml(item, { isNew: isNew(item.promptId) })).join('')
    : `<div class="empty empty-sm"><h3>Nothing here yet</h3><p>Your creations show up here as soon as they finish.</p></div>`;
}

/** Position text for a job that is waiting its turn. */
function jobStatusText(job, ahead) {
  if (job.status === 'uploading') return 'Uploading image';
  if (job.status === 'queued') return ahead > 0 ? `Queued (${ahead} ahead)` : 'Queued';
  return job.step && job.step.max ? 'Generating' : (job.phaseLabel || 'Working');
}

function renderJobs() {
  const active = [...feed.jobs.values()].filter((j) => !TERMINAL_STATUS.includes(j.status)).sort((a, b) => a.createdAt - b.createdAt);
  const failed = [...feed.failed.values()];
  $('#feedActive').hidden = !active.length && !failed.length;
  const list = $('#feedJobs');
  const wanted = [...active.map((j) => j.id), ...failed.map((j) => j.id)];
  list.querySelectorAll('[data-job]').forEach((el) => { if (!wanted.includes(el.dataset.job)) el.remove(); });

  const ensure = (job) => {
    let el = list.querySelector(`[data-job="${CSS.escape(job.id)}"]`);
    if (!el) {
      el = document.createElement('article');
      el.className = 'job-card';
      el.dataset.job = job.id;
      el.innerHTML = `<div class="job-top"><span class="badge badge-accent job-mode"></span><span class="job-phase"></span>
        <button class="btn btn-ghost btn-sm job-btn" type="button"></button></div>
        <p class="job-prompt"></p><div class="progress"><div class="progress-fill"></div></div><p class="hint job-sub"></p>`;
      list.appendChild(el);
    }
    return el;
  };
  active.forEach((job, ahead) => {
    const el = ensure(job);
    el.classList.remove('is-failed');
    el.querySelector('.job-mode').textContent = modeLabel(job.kind);
    el.querySelector('.job-phase').textContent = jobStatusText(job, ahead);
    const btn = el.querySelector('.job-btn');
    btn.textContent = 'Cancel'; btn.dataset.cancel = ''; delete btn.dataset.dismiss; btn.setAttribute('aria-label', 'Cancel this job');
    el.querySelector('.job-prompt').textContent = (job.settings && job.settings.positive) || 'No prompt';
    const pct = job.step && job.step.max ? Math.round((job.step.value / job.step.max) * 100) : (job.percent || 0);
    const bar = el.querySelector('.progress');
    bar.hidden = job.status === 'queued' && !job.step && ahead > 0;
    el.querySelector('.progress-fill').style.width = `${pct}%`;
    el.querySelector('.job-sub').textContent = job.step && job.step.max
      ? `Step ${job.step.value} of ${job.step.max}` : '';
    el.querySelector('.job-sub').hidden = !job.step;
  });
  failed.forEach((job) => {
    const el = ensure(job);
    el.classList.add('is-failed');
    el.querySelector('.job-mode').textContent = modeLabel(job.kind);
    el.querySelector('.job-phase').textContent = job.status === 'blocked' ? 'Blocked' : 'Failed';
    const btn = el.querySelector('.job-btn');
    btn.textContent = 'Dismiss'; btn.dataset.dismiss = ''; delete btn.dataset.cancel; btn.setAttribute('aria-label', 'Dismiss this message');
    el.querySelector('.job-prompt').textContent = job.error || 'Unknown error';
    el.querySelector('.progress').hidden = true;
    el.querySelector('.job-sub').hidden = true;
  });
  // Keep DOM order = run order, errors last.
  wanted.forEach((id) => list.appendChild(list.querySelector(`[data-job="${CSS.escape(id)}"]`)));
}

/** Move the shared feed into the active Create mode's slot (or hide it elsewhere). */
function mountFeed(panel) {
  const el = $('#createFeed');
  const slot = $(`#tab-${panel} [data-feed-slot]`);
  if (!slot) { el.hidden = true; return; }
  if (el.parentNode !== slot) slot.appendChild(el);
  el.hidden = false;
}

/* ============================== viewer ============================== */
const viewer = {
  items: [], index: 0, opener: null, more: null, confirming: false, busy: false,

  /** Open the viewer on `items[index]`. `more` (optional) loads further items; resolves true if any arrived. */
  open(items, index, more = null) {
    if (!items.length || index < 0) return;
    this.items = items; this.index = index; this.more = more;
    this.opener = document.activeElement;
    $('#viewer').hidden = false;
    document.documentElement.classList.add('viewer-open');
    this.render();
    $('#viewerClose').focus();
  },

  close() {
    if (this.busy) return;
    $('#viewer').hidden = true;
    document.documentElement.classList.remove('viewer-open');
    if (this.opener && this.opener.isConnected) this.opener.focus();
  },

  get item() { return this.items[this.index]; },

  async step(delta) {
    if (this.confirming) this.setConfirm(false);
    let next = this.index + delta;
    if (next >= this.items.length && this.more && await this.more()) next = this.index + delta;
    if (next < 0 || next >= this.items.length) return;
    this.index = next;
    this.render();
  },

  setConfirm(on) {
    this.confirming = on;
    $('#viewerConfirm').hidden = !on;
    $('#viewerActions').hidden = on;
  },

  render() {
    const item = this.item;
    if (!item) { this.close(); return; }
    const img = item.images[0];
    const after = proxyUrl(img.url);
    const before = proxyUrl(item.before);
    const media = $('#viewerMedia');
    if (before && item.mode && item.mode !== 'generate') {
      media.innerHTML = `<div class="compare viewer-compare" id="viewerCompare" style="--pos:50%">
        <img class="compare-img after" alt="After" src="${esc(after)}" />
        <img class="compare-img before" alt="Before (original)" src="${esc(before)}" />
        <div class="compare-handle" id="viewerHandle" role="slider" aria-label="Compare before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" tabindex="0"><span class="compare-knob">&#8660;</span></div>
        <span class="compare-tag before-tag">Before</span><span class="compare-tag after-tag">After</span></div>`;
      bindCompare($('#viewerCompare'), $('#viewerHandle'));
    } else {
      media.innerHTML = `<img class="viewer-img" alt="${esc(item.prompt || `${modeLabel(item.mode)} result`)}" src="${esc(after)}" />`;
    }
    $('#viewerMode').textContent = modeLabel(item.mode);
    $('#viewerMode').hidden = !item.mode;
    $('#viewerDate').textContent = item.createdAt ? new Date(item.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    $('#viewerCount').textContent = `${this.index + 1} / ${this.items.length}`;
    const prompt = $('#viewerPrompt');
    prompt.textContent = item.prompt || 'No prompt recorded';
    prompt.classList.toggle('is-empty', !item.prompt);
    $('#viewerSpecs').innerHTML = specRows(item).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#viewerPrev').disabled = this.index === 0;
    $('#viewerNext').disabled = this.index >= this.items.length - 1 && !(this.more && this.moreAvailable());
    this.setConfirm(false);
  },

  moreAvailable() { return gallery.hasMore && this.items === gallery.items; },

  download() {
    const item = this.item;
    downloadResult(proxyUrl(item.images[0].url), `embernest_${item.mode || 'image'}_${item.promptId.slice(0, 8)}`);
  },

  async remove() {
    const item = this.item;
    this.busy = true;
    try {
      await deleteResults([item.promptId]);
      toast('Deleted', 'ok');
    } catch (err) {
      toast(err.message, 'error');
      this.busy = false; this.setConfirm(false);
      return;
    }
    this.busy = false;
    const at = this.items.indexOf(item); // shared lists were already trimmed by deleteResults
    if (at >= 0) this.items.splice(at, 1);
    this.index = Math.min(this.index, this.items.length - 1);
    if (this.items.length === 0) this.close(); else this.render();
  },
};

/** Key settings shown under the prompt. */
function specRows(item) {
  const s = item.settings || {};
  const rows = [['Checkpoint', s.checkpoint]];
  if (s.width && s.height) rows.push(['Size', `${s.width}×${s.height}`]);
  rows.push(['Steps', s.steps], ['CFG', s.cfg], ['Sampler', s.sampler], ['Seed', s.seed]);
  if (item.mode !== 'generate' && s.denoise != null) rows.push(['Denoise', s.denoise]);
  if (s.lora) rows.push(['LoRA', s.loraStrength != null ? `${s.lora} (${s.loraStrength})` : s.lora]);
  return rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
}

function bindViewer() {
  $('#viewerClose').addEventListener('click', () => viewer.close());
  $('#viewerPrev').addEventListener('click', () => viewer.step(-1));
  $('#viewerNext').addEventListener('click', () => viewer.step(1));
  $('#viewerDownload').addEventListener('click', () => viewer.download());
  $('#viewerReuse').addEventListener('click', () => { const item = viewer.item; viewer.close(); reuseSettings(item); });
  $('#viewerDelete').addEventListener('click', () => viewer.setConfirm(true));
  $('#viewerConfirmNo').addEventListener('click', () => viewer.setConfirm(false));
  $('#viewerConfirmYes').addEventListener('click', () => viewer.remove());
  $('#viewerStage').addEventListener('click', (e) => { if (e.target === e.currentTarget || e.target.id === 'viewerMedia') viewer.close(); });

  document.addEventListener('keydown', (e) => {
    if ($('#viewer').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); if (viewer.confirming) viewer.setConfirm(false); else viewer.close(); return; }
    if (e.target.id === 'viewerHandle' || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return; // the slider owns the arrows
    if (e.key === 'ArrowLeft') { e.preventDefault(); viewer.step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); viewer.step(1); }
    else if (e.key === 'Tab') { // keep focus inside the dialog
      const f = $$('button:not([disabled]), [tabindex="0"]', $('#viewer')).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Swipe left/right on touch (the before/after slider keeps its own drag).
  let sx = null; let sy = 0;
  const stage = $('#viewerStage');
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.compare')) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) viewer.step(dx < 0 ? 1 : -1);
  }, { passive: true });
}

/* ============================== delete / reuse ============================== */
/** Delete results on the server and drop them from every list. Throws on the first failure. */
async function deleteResults(ids) {
  const gone = [];
  try {
    for (const id of ids) {
      await api(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
      gone.push(id);
    }
  } finally {
    if (gone.length) {
      const drop = (list) => { for (let i = list.length - 1; i >= 0; i -= 1) if (gone.includes(list[i].promptId)) list.splice(i, 1); };
      drop(feed.recent); drop(gallery.items);
      renderRecent(); renderGallery();
      loadRecent();
    }
  }
}

/** Switch to the item's Create mode and fill its form from the stored settings. */
async function reuseSettings(item) {
  const mode = item.mode || 'generate';
  location.hash = `#tab=create&mode=${mode}`;
  showRoute();
  const tab = state.tabs[mode];
  if (!tab) return;
  const s = item.settings || {};
  const refs = tab.refs;
  const setSelect = (el, value) => {
    if (!el || value == null || value === '') return;
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(value))) return;
    el.value = String(value);
  };
  setSelect(refs.prompt || refs.positive, item.prompt || '');
  if (refs.negative && s.negative != null) refs.negative.value = s.negative;
  setSelect(refs.checkpoint, s.checkpoint);
  if (refs.checkpoint && refs.checkpoint.value && tab.opts.onCheckpointChange) tab.opts.onCheckpointChange(tab);
  ['steps', 'cfg', 'seed', 'denoise', 'width', 'height'].forEach((k) => setSelect(refs[k], s[k]));
  setSelect(refs.maxSize, s.sampledAt);
  setSelect(refs.sampler, s.sampler);
  setSelect(refs.scheduler, s.scheduler);
  setSelect(refs.lora, s.lora || '');
  setSelect(refs.loraStrength, s.loraStrength);
  tab.updateOutputs();
  tab.updateRunEnabled();
  // Edit and Transform need the original photo again.
  const before = proxyUrl(item.before);
  if (tab.setImage && before) {
    try {
      const blob = await (await fetch(before)).blob();
      tab.setImage(new File([blob], 'original.png', { type: blob.type || 'image/png' }));
    } catch (_) { toast('Settings restored. Add the photo again.', 'ok'); return; }
  }
  toast('Settings restored', 'ok');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============================== gallery tab ============================== */
const gallery = {
  mode: '', items: [], total: 0, hasMore: false, loading: false, selecting: false, selected: new Set(),
  active: false, seq: 0, observer: null,
};

function bindGallery() {
  $('#galleryGrid').addEventListener('click', (e) => {
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    const id = thumb.dataset.id;
    if (gallery.selecting) { toggleSelect(id); return; }
    viewer.open(gallery.items, gallery.items.findIndex((i) => i.promptId === id), galleryMore);
  });
  $('#gallerySelectBtn').addEventListener('click', () => setSelecting(!gallery.selecting));
  $('#galleryCancelSel').addEventListener('click', () => setSelecting(false));
  $('#galleryDeleteSel').addEventListener('click', () => {
    $('#galleryConfirmText').textContent = `Delete ${gallery.selected.size} image${gallery.selected.size === 1 ? '' : 's'}? This can't be undone.`;
    $('#galleryConfirm').hidden = false; $('#gallerySelectBar').hidden = true;
  });
  $('#galleryConfirmNo').addEventListener('click', () => { $('#galleryConfirm').hidden = true; $('#gallerySelectBar').hidden = false; });
  $('#galleryConfirmYes').addEventListener('click', async () => {
    const ids = [...gallery.selected];
    $('#galleryConfirm').hidden = true;
    try { await deleteResults(ids); toast(`Deleted ${ids.length}`, 'ok'); } catch (err) { toast(err.message, 'error'); }
    setSelecting(false);
    galleryLoad(true);
  });
  $('#galleryMoreBtn').addEventListener('click', () => galleryMore());
  if ('IntersectionObserver' in window) {
    gallery.observer = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) galleryMore();
    }, { rootMargin: '400px' });
    gallery.observer.observe($('#galleryMore'));
  }
}

function setSelecting(on) {
  gallery.selecting = on;
  gallery.selected.clear();
  $('#gallerySelectBtn').setAttribute('aria-pressed', String(on));
  $('#gallerySelectBtn').hidden = on;
  $('#gallerySelectBar').hidden = !on;
  $('#galleryConfirm').hidden = true;
  renderGallery();
}

function toggleSelect(id) {
  if (gallery.selected.has(id)) gallery.selected.delete(id); else gallery.selected.add(id);
  renderGallery();
}

/** Called by showRoute for every route change. */
function galleryRoute(route, panel) {
  mountFeed(panel);
  const was = gallery.active;
  gallery.active = panel === 'gallery';
  if (gallery.active) {
    $$('#galleryFilters .chip').forEach((c) => {
      const on = c.dataset.gmode === route.galleryMode;
      c.classList.toggle('is-active', on);
      if (on) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
    });
    if (!was || gallery.mode !== route.galleryMode) {
      gallery.mode = route.galleryMode;
      setSelecting(false);
      galleryLoad(true);
    }
  }
  if (route.view && route.view !== state.deepView) {
    state.deepView = route.view;
    openById(route.view);
  }
}

/** Open the viewer on a result by id (deep link #…&view=<promptId>). */
async function openById(id) {
  try {
    const data = await api('/api/history?limit=100');
    const idx = data.items.findIndex((i) => i.promptId === id);
    if (idx >= 0) viewer.open(data.items, idx);
    else toast('That image is no longer available', 'error');
  } catch (err) { toast(err.message, 'error'); }
}

async function galleryLoad(reset) {
  if (gallery.loading && !reset) return false;
  const seq = ++gallery.seq;
  gallery.loading = true;
  if (reset) {
    gallery.items = [];
    $('#galleryGrid').innerHTML = skeletonThumbs(8);
    $('#galleryMore').hidden = true;
  }
  try {
    const qs = new URLSearchParams({ limit: GALLERY_PAGE, offset: gallery.items.length });
    if (gallery.mode) qs.set('mode', gallery.mode);
    const data = await api(`/api/history?${qs}`);
    if (seq !== gallery.seq) return false; // a newer load replaced this one
    gallery.items = gallery.items.concat(data.items);
    gallery.total = data.total;
    gallery.hasMore = data.hasMore;
    gallery.loading = false;
    renderGallery();
    return data.items.length > 0;
  } catch (err) {
    if (seq === gallery.seq) $('#galleryGrid').innerHTML = `<div class="empty"><h3>Could not load the gallery</h3><p>${esc(err.message)}</p></div>`;
    return false;
  } finally {
    if (seq === gallery.seq) gallery.loading = false;
  }
}

const galleryMore = async () => (gallery.hasMore && !gallery.loading ? galleryLoad(false) : false);

function skeletonThumbs(n) {
  return Array.from({ length: n }, () => '<div class="thumb skeleton"><div class="sk-thumb"></div></div>').join('');
}

function renderGallery() {
  const grid = $('#galleryGrid');
  if (!gallery.items.length && !gallery.loading) {
    const label = gallery.mode ? `No ${MODE_LABEL[gallery.mode].toLowerCase()} results yet` : 'Nothing here yet';
    grid.innerHTML = `<div class="empty"><svg class="empty-art" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/></svg>
      <h3>${esc(label)}</h3><p>Images you create show up here.</p><a class="btn btn-primary" href="#tab=create">Start creating</a></div>`;
  } else {
    grid.innerHTML = gallery.items.map((item) => thumbHtml(item, {
      selectable: gallery.selecting, selected: gallery.selected.has(item.promptId),
    })).join('');
  }
  $('#galleryMore').hidden = !gallery.hasMore;
  $('#gallerySelectBtn').hidden = gallery.selecting || !gallery.items.length;
  $('#gallerySelectCount').textContent = `${gallery.selected.size} selected`;
  $('#galleryDeleteSel').disabled = gallery.selected.size === 0;
}
