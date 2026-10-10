/**
 * explain.js — the short "What's this?" texts and the sheet that shows them.
 * All wording lives in EXPLAIN so it is easy to find and edit.
 * A body entry is a paragraph (string) or a function returning one (for GPU-specific text).
 */
'use strict';

const EXPLAIN = {
  checkpoint: {
    title: 'Checkpoint',
    body: [
      'A checkpoint is the main model. It is the file that actually draws the picture, and it decides the overall look: photo, anime, painting and so on.',
      'You need one checkpoint to make or edit images. Everything else (LoRAs, embeddings, VAEs) is an add-on that works on top of it.',
      'Checkpoints are big, usually 2 to 7 GB. Embernest never downloads one unless you press Download.',
    ],
  },
  inpainting: {
    title: 'Inpainting checkpoint',
    body: [
      'An inpainting checkpoint is trained to repaint just one part of a picture so the new part blends with the rest.',
      'Edit uses it to change the area you describe while keeping the person and the background. A normal checkpoint can do this too, but the seams are usually easier to see.',
      'For Generate and Transform a normal checkpoint is the better choice. Inpainting ones are tuned for repairs, not for starting from nothing.',
    ],
  },
  lora: {
    title: 'LoRA',
    body: [
      'A LoRA is a small add-on file that nudges a checkpoint toward a style, a face, a detail or a subject. Most are 10 to 200 MB.',
      'It only works with checkpoints of the same family. An SDXL LoRA does nothing useful on an SD 1.5 checkpoint, so Embernest hides the ones that do not match.',
      'Many LoRAs have trigger words: type them in your prompt to switch the effect on. Strength sets how strongly it applies; 0.6 to 1.0 is a good start.',
    ],
  },
  embedding: {
    title: 'Embedding',
    body: [
      'An embedding (also called textual inversion) is a tiny file that teaches the model one new word.',
      'Negative embeddings such as EasyNegative are the most popular. Put their word in the negative prompt to avoid common flaws like bad hands or blur.',
      'Like LoRAs, an embedding is made for one family, usually SD 1.5 or SDXL.',
    ],
  },
  vae: {
    title: 'VAE',
    body: [
      'The VAE turns the model\'s internal picture into the final pixels. A better VAE gives cleaner colours and finer detail.',
      'Most checkpoints already include one. You only need a separate VAE when the checkpoint page says so, or when images look washed out.',
    ],
  },
  families: {
    title: 'Base models and families',
    body: [
      'Every checkpoint is built on a base model, called its family. The main ones are SD 1.5, SDXL, Pony, Illustrious and Flux.',
      'LoRAs, embeddings and VAEs must match the family of your checkpoint. SD 1.5 is small and quick, SDXL is sharper but needs a stronger GPU. Pony and Illustrious are SDXL-based.',
      () => {
        const base = typeof state !== 'undefined' && state.recommendation && state.recommendation.baseModel;
        return base ? `Your GPU can run: ${base}.` : 'Embernest picks the family your GPU can run once it has checked your hardware.';
      },
    ],
  },
};

let explainReturnFocus = null;
let explainOpenKey = null;

/** Fill the paragraphs of an open sheet (dynamic parts, such as your GPU, are read at this moment). */
function fillExplainer(sheet, topic) {
  sheet.querySelectorAll('p').forEach((p) => p.remove());
  for (const part of topic.body) {
    const p = document.createElement('p');
    p.textContent = typeof part === 'function' ? part() : part;
    sheet.append(p);
  }
}

/** Re-read the dynamic text of the open explainer (called when hardware details arrive). */
function refreshExplainer() {
  const scrim = document.getElementById('explainScrim');
  if (scrim && explainOpenKey) fillExplainer(scrim.querySelector('.sheet'), EXPLAIN[explainOpenKey]);
}

/** Close the explainer sheet, if one is open. */
function closeExplainer() {
  const scrim = document.getElementById('explainScrim');
  if (!scrim) return;
  scrim.remove();
  explainOpenKey = null;
  document.removeEventListener('keydown', onExplainKey);
  if (explainReturnFocus && document.contains(explainReturnFocus)) explainReturnFocus.focus();
  explainReturnFocus = null;
}

function onExplainKey(e) {
  if (e.key === 'Escape') closeExplainer();
}

/**
 * Open the explainer sheet for a topic key from EXPLAIN. Unknown keys are ignored.
 * @param {string} key
 */
function openExplainer(key) {
  const topic = EXPLAIN[key];
  if (!topic) return;
  closeExplainer();
  explainReturnFocus = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'scrim is-side';
  scrim.id = 'explainScrim';
  const sheet = document.createElement('section');
  sheet.className = 'sheet explain-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'explainTitle');
  const head = document.createElement('header');
  head.className = 'explain-head';
  const h = document.createElement('h2');
  h.id = 'explainTitle';
  h.textContent = topic.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost btn-icon';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', closeExplainer);
  head.append(h, close);
  sheet.append(head);
  explainOpenKey = key;
  fillExplainer(sheet, topic);
  scrim.append(sheet);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeExplainer(); });
  document.body.append(scrim);
  document.addEventListener('keydown', onExplainKey);
  close.focus();
}

/** A small round ⓘ button that opens an explainer; returns HTML for a template string. */
function infoButtonHtml(key, label) {
  const text = label || `What is this? ${EXPLAIN[key] ? EXPLAIN[key].title : ''}`;
  return `<button class="info-btn" type="button" data-explain="${String(key).replace(/[^\w-]/g, '')}" aria-label="${String(text).replace(/[&<>"']/g, '')}" title="${String(text).replace(/[&<>"']/g, '')}">i</button>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-explain]');
  if (btn) { e.preventDefault(); openExplainer(btn.dataset.explain); }
});
