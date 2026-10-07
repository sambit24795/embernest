# PixelKiln — Next Features Plan (v2)

Follow-on plan to add: **txt2img (Generate)**, **img2img (Transform)**,
**installed-model management (delete)**, and **spec-aware auto-configuration**
of the Edit tab.

**Note:** "Show ongoing downloads" is already implemented (a Downloads panel in
the Models tab that re-attaches live progress streams after a page refresh).
Keep it as-is; nothing new needed for that item.

## 1. Goals

1. **Generate tab** — text-to-image (prompt only).
2. **Transform tab** — image-to-image (upload + prompt + denoise).
3. **Installed models** — add a delete button per installed model file.
4. **Edit tab auto-config** — auto-select/apply spec-based recommendations
   (base model, maxSize, checkpoint, sampler, scheduler) so the user doesn't
   configure everything by hand.

## 2. Shared infrastructure (do this first)

Refactor `src/edits.js` so the job machinery (async run, per-job client_id +
WebSocket progress, phases, SSE events, cancel, queue) is **generic** and takes
a *workflow builder + inputs* instead of being inpainting-specific.

Target shape:

```js
// src/jobs.js  (new; generalized from edits.js)
startJob({ kind, buildWorkflow, inputs, client }) -> job {id, status, phase, ...}
```

- `kind`: `'edit' | 'generate' | 'transform'`
- `buildWorkflow(inputs)` returns ComfyUI API-format prompt JSON
- Reuses the existing `monitor()` WebSocket logic + history fallback unchanged
- SSE route: `GET /api/jobs/:id/events` (keep `/api/edit/jobs/*` aliases working)

Then:
- `POST /api/edit` → `startJob({kind:'edit', ...})`
- `POST /api/generate` → `startJob({kind:'generate', ...})`
- `POST /api/transform` → `startJob({kind:'transform', ...})`

## 3. Generate tab (txt2img)

### Workflow (`buildTxt2ImgWorkflow` in `src/workflow.js`)

1. `EmptyLatentImage` — `{ width, height, batch_size: 1 }` → LATENT
2. `CheckpointLoaderSimple` — `{ ckpt_name }` → MODEL, CLIP, VAE
3. `CLIPTextEncode` — positive
4. `CLIPTextEncode` — negative
5. `KSampler` — `{ model, seed, steps, cfg, sampler_name, scheduler,
   positive, negative, latent_image, denoise: 1.0 }`
6. `VAEDecode` — `{ samples, vae }`
7. `SaveImage` — `{ images, filename_prefix: 'pixelkiln_gen' }`

### Backend

`POST /api/generate` (JSON): `{ prompt, negative, width, height, steps, cfg,
sampler, scheduler, seed, checkpoint }` → 202 `{ job }`.

- `width`/`height` default to the spec-recommended maxSize (square, e.g.
  768×768 on 6GB). Clamp to the recommended size so SD 1.5 stays ≤768.
- Validate checkpoint is installed.

### UI (new tab `#tab-generate`)

Form: prompt, negative, width/height, steps, cfg, sampler, scheduler, seed,
checkpoint dropdown. Same async progress + result preview + queue/history as Edit.
Reuse the existing before/after compare container (before side is empty/hidden).

## 4. Transform tab (img2img)

### Workflow (`buildImg2ImgWorkflow` in `src/workflow.js`)

1. `LoadImage` — `{ image }` → IMAGE
2. `ImageScale` — downscale to spec maxSize (optional, like Edit) → IMAGE
3. `CheckpointLoaderSimple` — `{ ckpt_name }`
4. `CLIPTextEncode` — positive
5. `CLIPTextEncode` — negative
6. `VAEEncode` — `{ pixels, vae }` → LATENT   ← (plain encode, NOT ForInpaint)
7. `KSampler` — `{ ..., latent_image, denoise: <user 0.25–1.0> }`
8. `VAEDecode` — `{ samples, vae }`
9. `ImageScale` — restore original size (optional)
10. `SaveImage` — `{ images, filename_prefix: 'pixelkiln_tf' }`

### Backend

`POST /api/transform` (multipart): `image` file + `{ prompt, negative, denoise,
steps, cfg, sampler, scheduler, seed, checkpoint, maxSize, restoreSize }`
→ 202 `{ job }`.

### UI (new tab `#tab-transform`)

Upload/dropzone (same as Edit) + prompt + **denoise slider (0.25–1.0, default
0.6)** + steps/cfg/sampler/scheduler/seed/checkpoint. Before/after compare.

## 5. Installed-model management (delete)

### Backend

`DELETE /api/models/installed/:folder/:name`

- `folder` ∈ {checkpoints, loras, vae, embeddings, controlnet, upscale_models,
  background_removal, detection}
- Resolve the folder path from `/experiment/models` (same as downloads.js).
- Validate `name` (basename only, reject `..`, empty, path separators).
- `unlink` the file; return `{ ok, deleted, restartRequired: true }`.
- 404 if the file doesn't exist.

### UI

In the **Installed models** list, add a small ✕ button per file (like the
history thumbnails). Click → confirm → call the delete route → refresh the list
and toast "Restart ComfyUI to finish removing".

## 6. Edit tab auto-config (fix "I had to enter everything manually")

The `/api/recommend` endpoint already returns specs + recommendation
(`{ baseModel, maxSize, lowvram, notes }`). The bug: the Edit tab only shows
badges but does **not auto-apply** the recommendation.

### What to change in `public/app.js`

1. **Auto-select base model** — in `renderBaseModelOptions()`, after building
   options, set `#baseModelSelect.value` to `state.recommendation.baseModel`
   (fallback: first option).
2. **Auto-set maxSize** — after selecting the base model, call the existing
   `onBaseModelChange()` logic, which already clamps maxSize to the model's
   recommended size (e.g. 768 for SD 1.5 on 6GB).
3. **Auto-select checkpoint** — for the **Edit** tab prefer a checkpoint whose
   name matches `/inpaint/i`; else the first installed checkpoint. (Generate /
   Transform tabs can default to first or last-used.)
4. **Auto-select sampler/scheduler** — set `dpmpp_2m` + `karras` (already the
   config defaults; ensure the dropdowns reflect it even if the user's config
   has something else).
5. **Recommendation banner** — above the form in the Edit tab, render:
   `Detected GTX 1660 Ti · 6 GB VRAM → SD 1.5 · max 768px · low-vram`
   (from `/api/recommend`), with a "reset to recommended" button that re-applies
   all of the above.
6. **Keep user overrides** — auto-apply only on first load (or when the user
   clicks "reset to recommended"); once the user changes a field, don't stomp it.

## 7. Milestones (build order)

1. Generalize jobs (extract `src/jobs.js` from `edits.js`; keep `/api/edit` +
   SSE aliases working; verify existing Edit still runs).
2. Generate tab — `buildTxt2ImgWorkflow` + `POST /api/generate` + UI.
3. Transform tab — `buildImg2ImgWorkflow` + `POST /api/transform` + UI
   (denoise slider).
4. Installed-model delete — backend route + ✕ buttons in Installed list.
5. Edit auto-config — auto-select base model / maxSize / checkpoint / sampler /
   scheduler + recommendation banner + "reset to recommended".

## 8. Gotchas (must read)

- **SD 1.5 collapses above ~768px** — Generate/Transform must clamp width/height
  to the spec-recommended maxSize (same rule as Edit).
- **img2img uses `VAEEncode`**, NOT `VAEEncodeForInpaint` (no mask).
- **denoise is the img2img strength knob** — default 0.6; 1.0 ≈ txt2img.
- **img2img keeps the whole image** (including clothes) as a guide — it can't
  swap one region; that's what Edit/inpaint is for. Don't confuse the two.
- **Deleting a model file** only takes effect after a ComfyUI restart (it caches
  the list at startup); set `restartRequired` and prompt the user.
- **Path traversal** on the delete route — validate `name` and resolve inside the
  model folder only (same guard as the history-delete route).
- **Job SSE/WebSocket** must be per-job (client_id) — reuse the existing monitor
  logic; don't open a second socket per tab.
- Static files (`app.js`, `style.css`) are served fresh from disk — no server
  restart needed for UI changes, but the **phone browser** caches them → hard
  refresh after changes.
- New checkpoints still require a ComfyUI restart to appear in the dropdown.

## 9. Out of scope (this pass)

- LoRA/VAE selection in the UI (workflows don't use them yet)
- Batch/folder generation
- Upscaling pass (latent upscale / upscale models)
