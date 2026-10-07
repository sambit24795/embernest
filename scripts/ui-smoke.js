#!/usr/bin/env node
'use strict';
/**
 * scripts/ui-smoke.js — interactive PixelKiln UI smoke test.
 *
 * Drives a real headless Firefox over the WebDriver BiDi protocol (Node's
 * built-in WebSocket + fetch, no npm dependencies) and clicks through the DOM:
 *   - Edit tab auto-config banner / base model / inpaint checkpoint (M5)
 *   - "Reset to recommended" overriding a manual change (M5)
 *   - Generate + Transform tab defaults (M2/M3)
 *   - installed-model delete button (M4)
 *
 * Requirements:
 *   - PixelKiln running (default http://127.0.0.1:3000)
 *   - firefox on PATH, and a writable ComfyUI models/vae folder for the delete test
 *
 * Usage:
 *   node scripts/ui-smoke.js
 *   PK_URL=http://127.0.0.1:3000 PK_COMFY_MODELS=/path/to/ComfyUI/models node scripts/ui-smoke.js
 *
 * Exits 0 on success, 1 on check failure, 2 on harness error.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = process.env.PK_URL || 'http://127.0.0.1:3000';
const MODELS_ROOT = process.env.PK_COMFY_MODELS || '/home/sambit/sd-nsfw-edit/ComfyUI/models';
const BIDI_PORT = Number(process.env.PK_BIDI_PORT || 9224);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-bidi-'));
const TEMP_NAME = '__pk_ui_test__.safetensors';
const TEMP_PATH = path.join(MODELS_ROOT, 'vae', TEMP_NAME);
const results = [];
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', err.message);
  try { fs.rmSync(TEMP_PATH, { force: true }); } catch (_) { /* ignore */ }
  process.exit(2);
});
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  (${detail})` : ''}`);
};

const ff = spawn('firefox', [
  '--headless', '--no-remote', '--profile', PROFILE,
  '--remote-debugging-port', String(BIDI_PORT), 'about:blank',
], { stdio: 'ignore' });

let ws, nextId = 1;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bidi(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let context;
async function js(expression) {
  const res = await bidi('script.evaluate', { expression, target: { context }, awaitPromise: false, resultOwnership: 'none' });
  if (res && res.type === 'success') return res.result.value;
  throw new Error(`eval failed: ${JSON.stringify(res).slice(0, 300)}`);
}
async function jsJson(expression) {
  return JSON.parse(await js(`JSON.stringify(${expression})`));
}
async function waitFor(desc, expression, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const raw = await js(`JSON.stringify(${expression})`);
      last = raw === undefined ? undefined : JSON.parse(raw);
      if (predicate(last)) return last;
    } catch (err) { last = err.message; }
    await sleep(400);
  }
  throw new Error(`waitFor(${desc}) timed out; last=${JSON.stringify(last)}`);
}

(async () => {
  // Wait for the BiDi endpoint, then handshake.
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    (function tryConnect() {
      let settled = false;
      const socket = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
      socket.onopen = () => { if (settled) return; settled = true; ws = socket; resolve(); };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch (_) { /* ignore */ }
        if (Date.now() < deadline) setTimeout(tryConnect, 300);
        else reject(new Error('bidi connect failed'));
      };
    })();
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.type === 'success') p.resolve(msg.result); else p.reject(new Error(`${msg.error}: ${msg.message}`));
    }
  };

  await bidi('session.new', { capabilities: {} });
  ({ context } = await bidi('browsingContext.create', { type: 'tab' }));
  await bidi('browsingContext.navigate', { context, url: `${BASE_URL}/#edit`, wait: 'complete' });

  // --- Edit tab auto-config ---
  const st = await waitFor('edit ready', `(() => { const q=s=>document.querySelector(s); return {
      status: (q('#statusText')||{}).textContent,
      bannerHidden: (q('#editRecBanner')||{}).hidden,
      banner: (q('#editRecText')||{}).textContent,
      base: (q('#baseModelSelect')||{}).value,
      ckpt: (q('#checkpointSelect')||{}).value }; })()`,
  (s) => s && /ComfyUI/.test(s.status || '') && s.base && s.ckpt && s.bannerHidden === false);
  check('Edit banner visible', !st.bannerHidden, st.banner);
  check('Edit base auto-selected SD 1.5', st.base === 'SD 1.5', st.base);
  check('Edit checkpoint prefers inpaint', /inpaint/i.test(st.ckpt), st.ckpt);

  // --- Reset-to-recommended overrides a manual change ---
  await js(`(() => { const b=document.querySelector('#baseModelSelect'); b.value='SDXL 1.0'; b.dispatchEvent(new Event('change')); })()`);
  const userVal = await js(`document.querySelector('#baseModelSelect').value`);
  await js(`document.querySelector('#resetRecommendedBtn').click()`);
  const resetVal = await js(`document.querySelector('#baseModelSelect').value`);
  check('Manual override persists', userVal === 'SDXL 1.0', userVal);
  check('Reset restores recommendation', resetVal === 'SD 1.5', resetVal);

  // --- Generate tab ---
  await js(`document.querySelector('[data-tab="generate"]').click()`);
  const gen = await jsJson(`(() => { const q=s=>document.querySelector(s); return {
    hidden: q('#tab-generate').hidden, w: q('#genWidth').value, h: q('#genHeight').value,
    sampler: q('#genSampler').value, sched: q('#genScheduler').value, disabled: q('#genRunBtn').disabled }; })()`);
  check('Generate tab shows', !gen.hidden);
  check('Generate defaults 768x768', gen.w === '768' && gen.h === '768', `${gen.w}x${gen.h}`);
  check('Generate dpmpp_2m/karras', gen.sampler === 'dpmpp_2m' && gen.sched === 'karras', `${gen.sampler}/${gen.sched}`);
  check('Generate run enabled without image', gen.disabled === false);

  // --- Transform tab ---
  await js(`document.querySelector('[data-tab="transform"]').click()`);
  const tf = await jsJson(`(() => { const q=s=>document.querySelector(s); return {
    hidden: q('#tab-transform').hidden, denoise: q('#tfDenoise').value,
    maxSize: q('#tfMaxSize').value, disabled: q('#tfRunBtn').disabled }; })()`);
  check('Transform tab shows', !tf.hidden);
  check('Transform denoise 0.6', Number(tf.denoise) === 0.6, tf.denoise);
  check('Transform maxSize 768', tf.maxSize === '768', tf.maxSize);
  check('Transform run waits for image', tf.disabled === true, tf.disabled);

  // --- Installed-model delete via UI ---
  if (fs.existsSync(path.dirname(TEMP_PATH))) {
    fs.writeFileSync(TEMP_PATH, 'ui test dummy');
    console.log('temp model created:', TEMP_PATH);
    await js(`document.querySelector('[data-tab="models"]').click()`);
    await js(`document.querySelector('#refreshInstalled').click()`);
    await waitFor('temp listed', `!!document.querySelector('[data-name="${TEMP_NAME}"]')`, (v) => v, 15000);
    check('Temp model listed', true);
    await js(`(window.confirm = () => true, document.querySelector('[data-name="${TEMP_NAME}"]').click())`);
    await waitFor('temp removed', `!document.querySelector('[data-name="${TEMP_NAME}"]')`, (v) => v, 15000);
    check('Delete button removed temp model', true);
  } else {
    console.log(`skip  installed-delete test (no ${path.dirname(TEMP_PATH)})`);
  }

  console.log(`\n=== SUMMARY: ${results.filter((r) => r.ok).length}/${results.length} passed ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1; }
})().catch((err) => {
  console.error('TEST ERROR:', err.message);
  process.exitCode = 2;
}).finally(async () => {
  try { fs.rmSync(TEMP_PATH, { force: true }); } catch (_) {}
  try { ws && ws.close(); } catch (_) {}
  try { ff.kill('SIGKILL'); } catch (_) {}
  await sleep(500);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (_) {}
  process.exit(process.exitCode || 0);
});
