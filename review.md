# PixelKiln v2 — Implementation Review Packet

**Audience:** DeepSeek (or any reviewer).
**Author:** coding agent (pi).
**Date:** 2025 (local machine: Linux Mint, GTX 1660 Ti Mobile 6 GB, ComfyUI 0.38.0 at `127.0.0.1:8188`).
**Plan reviewed against:** `NEXT_PLAN.md` (v2), sections 1–9.
**Deliverable:** all 5 milestones in `NEXT_PLAN.md` §7.

> **Where to look first:** `src/jobs.js` (new generic engine), `src/workflow.js`
> (`buildTxt2ImgWorkflow` / `buildImg2ImgWorkflow`), `src/server.js` (routes),
> `public/app.js` (`createForgeTab` + Edit auto-config). Section 8 below lists
> the issues I already know about — please pressure-test those.

---

## 0. TL;DR

| Milestone | Status | Key artifacts |
|-----------|--------|---------------|
| M1 — Generalize jobs | ✅ done & tested | `src/jobs.js`; `src/edits.js` deleted; `/api/edit/jobs/*` aliases kept |
| M2 — Generate (txt2img) | ✅ done & tested | `buildTxt2ImgWorkflow`, `POST /api/generate`, `#tab-generate` |
| M3 — Transform (img2img) | ✅ done & tested | `buildImg2ImgWorkflow` (uses **`VAEEncode`**), `POST /api/transform`, `#tab-transform` |
| M4 — Installed-model delete | ✅ done & tested | `DELETE /api/models/installed/:folder/:name`, ✕ buttons |
| M5 — Edit auto-config | ✅ done & tested | rec banner, auto base/maxSize/checkpoint/sampler/scheduler, reset button |

Plan §7 lists **5** milestones; the request said "7". I implemented the 5 defined
in the plan. If a different 7-way split was intended, flag it.

**No git repository exists in `/home/sambit/projects/pixelkiln`**, so there is no
diff. Changes are described file-by-file below.

---

## 1. Architecture

```
Browser (public/)
  ├─ Edit tab      ─┐
  ├─ Generate tab  ─┼─ createForgeTab()  ── EventSource /api/jobs/:id/events
  └─ Transform tab ─┘                      fetch /api/{edit,generate,transform}
                                                │
Express (src/server.js)                         │
  ├─ validates inputs, picks checkpoint, clamps sizes
  └─ jobs.startJob({ kind, buildWorkflow, inputs, client, file? })
        │
src/jobs.js  (generic engine)                   src/workflow.js (pure builders)
  ├─ upload image (if any)                        ├─ buildInpaintWorkflow
  ├─ resolve width/height for downscale           ├─ buildTxt2ImgWorkflow
  ├─ buildWorkflow(inputs)                        └─ buildImg2ImgWorkflow
  ├─ queue prompt with per-job client_id
  ├─ monitor() per-job WebSocket -> progress
  ├─ history fallback if WS fails
  └─ collect images -> job.images / before / after
        │
src/comfy.js (HTTP/WS client to ComfyUI)
```

Design intent: one job engine, three thin route adapters, three pure workflow
builders, one shared UI controller. New job kinds should require only a builder
+ a route + a `createForgeTab` instance.

---

## 2. File-by-file changes

### `src/jobs.js` — **NEW** (334 lines)
Generalized from the old `src/edits.js`.
- `startJob({ kind, client, file?, inputs, buildWorkflow }) -> snapshot`
- `getJob(id)`, `listJobs(kind?)`, `subscribe(id, cb)`, `cancelJob(id, client)`,
  `imageProxyUrl(img)`
- Contains the unchanged `monitor()` WebSocket logic (per-job `clientId`,
  progress/executing/error/interrupted events) and the history fallback.
- Job lifecycle: `uploading → queued → running → saving → done|error|cancelled`.
- **Important:** in `run()`, when a file is uploaded it resolves the original
  `width`/`height` from the image buffer (via `imageMeta.js`) and injects them
  into the workflow inputs unless the caller supplied them. This preserves the
  Edit downscale/restore behavior (SD 1.5 > 768px gotcha). It also mirrors those
  dims into `job.settings.width/height`.
- `JOB_TTL_MS = 1h`; jobs are in-memory only.

### `src/edits.js` — **DELETED**
No remaining references. All call sites moved to `jobs.js`.

### `src/workflow.js` — extended (458 lines)
- `buildInpaintWorkflow` — unchanged (18-node Edit graph).
- **`buildTxt2ImgWorkflow`** — new 7-node graph:
  `EmptyLatentImage → CheckpointLoaderSimple → CLIPTextEncode(+/-) →
  KSampler(denoise 1.0) → VAEDecode → SaveImage` (`pixelkiln_gen`).
- **`buildImg2ImgWorkflow`** — new 10-node graph:
  `LoadImage → [ImageScale] → CheckpointLoaderSimple → CLIPTextEncode(+/-) →
  VAEEncode → KSampler(denoise=user) → VAEDecode → [ImageScale] → SaveImage`
  (`pixelkiln_tf`). Uses **`VAEEncode`**, never `VAEEncodeForInpaint`.
- `computeScale` (unchanged) and new `clampSize(value, maxSize)` (snap to
  multiple of 8, clamp to `maxSize`, floor 64).
- `buildTxt2ImgWorkflow` internally clamps to `8192` only; the **spec maxSize
  clamp is enforced in the route** (see issues §8.3).

### `src/downloads.js` — extended
- Added / exported `getModelFolderPath(client, folderName)` — resolves the
  first absolute directory for a named ComfyUI models folder (`/experiment/models`).
- Reused by the new delete route (same source of truth as downloads).

### `src/server.js` — extended (831 lines)
- Requires `jobs` + `buildInpaintWorkflow, buildTxt2ImgWorkflow, buildImg2ImgWorkflow, clampSize`.
- `POST /api/edit` now calls `jobs.startJob({ kind:'edit', … })`.
- Added generic `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/events`, `DELETE /api/jobs/:id`.
- Kept `/api/edit/jobs/*` as aliases backed by the same engine (verified).
- Added `POST /api/generate` (JSON) and `POST /api/transform` (multipart).
- Added `DELETE /api/models/installed/:folder/:name` with path-traversal guard.
- `/api/queue` and `/api/history` now use `jobs.listJobs('edit')` /
  `jobs.imageProxyUrl`.

### `public/index.html` — extended (650 lines)
- Added **✨ Generate** and **♻ Transform** tabs + panels.
- Added the recommendation banner (`#editRecBanner`, `#editRecText`,
  `#resetRecommendedBtn`) above the Edit form.
- Added `id="compareBeforeTag"` to the Edit before-tag (needed so the shared
  controller can hide it for Generate; previously class-only).

### `public/app.js` — significantly refactored (1164 lines)
- New **`createForgeTab(opts)`** controller sharing: dropzone, run/cancel,
  progress bar, SSE tracking, result preview, compare slider, meta, download,
  queue/history wiring, range outputs, checkpoint-change hook.
- Instances: `editTab`, `generateTab`, `transformTab`; each `root` is scoped to
  its own `<section>` (prevents `.before-tag` / selector collisions).
- Edit auto-config: `autoConfigureEditTab()` (recommended base → `onBaseModelChange`
  maxSize → inpaint checkpoint → `dpmpp_2m`/`karras` + config denoise/steps/cfg/seed),
  `renderRecBanner()`, `state.editAutoConfigured` flag, reset button.
- Installed-list ✕ button + `deleteInstalledModel()`.
- `init()` now switches to the hash tab **before** the async fetches (fixes a
  reload-on-`#generate` flash).
- Removed `applyAllDefaults()` from `saveSettings()` so saving settings no longer
  stomps Generate/Transform form values (see issues §8.4).

### `public/style.css` — extended
- `.installed-actions`, `.installed-delete`, `.installed-name`, `.rec-banner`.

### `scripts/ui-smoke.js` — **NEW** (test harness)
- Dependency-free interactive UI test. Spawns headless Firefox with
  `--remote-debugging-port`, speaks **WebDriver BiDi** over Node's built-in
  `WebSocket`, and clicks through the real DOM. Asserts the M5 banner/base/
  checkpoint/reset behavior, the M2/M3 tab defaults, and the M4 delete button.
- Configurable via `PK_URL`, `PK_COMFY_MODELS`, `PK_BIDI_PORT`; run with
  `npm run check:ui`. Exits 0/1/2 (success / check failure / harness error).
- Added `check:ui` to `package.json` scripts.

---

## 3. API surface (new / changed)

| Method | Path | Body | Notes |
|--------|------|------|-------|
| POST | `/api/edit` | multipart `image` + fields | unchanged contract; now generic engine |
| POST | `/api/generate` | JSON `{prompt,negative,width,height,steps,cfg,sampler,scheduler,seed,checkpoint}` | 202 `{job}`; W/H clamped to spec maxSize |
| POST | `/api/transform` | multipart `image` + `{prompt,negative,denoise,steps,cfg,sampler,scheduler,seed,checkpoint,maxSize,restoreSize}` | 202 `{job}`; denoise clamped 0.25–1.0 |
| GET | `/api/jobs?kind=` | — | all jobs, newest first |
| GET | `/api/jobs/:id` | — | snapshot / 404 |
| GET | `/api/jobs/:id/events` | — | SSE per-job stream |
| DELETE | `/api/jobs/:id` | — | cancel + interrupt |
| DELETE | `/api/models/installed/:folder/:name` | — | `{ok,deleted,restartRequired:true}` / 400 / 404 |
| GET | `/api/edit/jobs*` | — | aliases retained (same engine) |

Job snapshot carries `kind`, `status`, `phase`, `phaseLabel`, `step`,
`percent`, `before`, `after`, `images[]`, `settings`, `sourceSize`, `error`.

---

## 4. Section-8 gotcha compliance (as implemented)

| Gotcha | How handled | Evidence |
|--------|-------------|----------|
| SD 1.5 collapses > 768 | Edit resolves image dims and `computeScale` downscales + restores; Generate route `clampSize(body.width, rec.maxSize)`; Transform route clamps `maxSize` to `rec.maxSize` | 2000×2000 generate → 768×768; transform graph shows `Downscale to 768x696` |
| img2img uses `VAEEncode` | `buildImg2ImgWorkflow` node 6 is `VAEEncode` | graph dump: `uses VAEEncode: true`, `uses VAEEncodeForInpaint: false` |
| denoise is the strength knob | Transform default 0.6, server clamps 0.25–1.0, slider range same | live transform with 0.65 succeeded |
| img2img keeps whole image | Transform has no mask; Edit remains the masked/inpaint path | both graphs reviewed |
| Deleting a model needs restart | route returns `restartRequired: true`; UI toasts "restart ComfyUI" | delete response verified |
| Path traversal | `name === path.basename(name)`, reject empty/`.`/`..`/`/`/`\`, `full.startsWith(root)` | `..%2F..%2Fconfig.json` → 400; `a%2Fb` → 400 |
| Per-job SSE/client_id | `jobs.startJob` mints per-job `clientId`; single EventSource per tab | SSE on generic + alias routes verified |
| Static files need hard refresh | documented for the user; no server restart needed | frontend only |
| New checkpoints need restart | unchanged (ComfyUI caches list) | n/a |

---

## 5. Tests actually run (this machine)

```
# M1
POST /api/edit (test_big.png, steps=8) -> done; before/after proxy URLs; 
GET /api/jobs/:id, /api/edit/jobs/:id, SSE (generic + alias) all OK
GET /api/history -> items with proxied URLs
18-node inpaint graph confirmed (Downscale 768x696 + Restore 1048x960)

# M2
POST /api/generate {width:2000,height:2000,steps:6} -> 202
  settings {width:768,height:768,maxSize:768}; progress 1/6..6/6; done; PNG 809455 B
bad checkpoint -> 400 {"error":"Unknown checkpoint ..."}
index served with data-tab edit/generate/transform/models/settings

# M3
buildImg2ImgWorkflow dump -> VAEEncode present, VAEEncodeForInpaint absent
POST /api/transform (steps=6, denoise=0.65) -> done; before+after PNG 648784 B

# M4
created models/vae/__pk_delete_test__.safetensors
DELETE /api/models/installed/vae/__pk_delete_test__.safetensors
  -> {"ok":true,"deleted":"vae/__pk_delete_test__.safetensors","restartRequired":true}
  -> file gone
traversal/unknown-folder/missing-file -> 400/400/404

# M5
GET /api/recommend -> {gpu:"TU116M [GeForce GTX 1660 Ti Mobile]",vramGB:6,
  recommendation:{baseModel:"SD 1.5",maxSize:768,lowvram:true,notes:"recommended"}}
Headless Firefox screenshots: #edit shows banner "Detected … → SD 1.5 · max 768px ·
  low-vram", base model SD 1.5, inpaint checkpoint selected; #generate and #transform
  render with populated checkpoint + dpmpp_2m/karras.

# Interactive UI (npm run check:ui, Firefox WebDriver BiDi) -> 15/15 passed
  PASS Edit banner visible (Detected TU116M [GeForce GTX 1660 Ti Mobile] · 6 GB VRAM → SD 1.5 · max 768px · low-vram)
  PASS Edit base auto-selected SD 1.5
  PASS Edit checkpoint prefers inpaint
  PASS Manual override persists (SDXL 1.0)
  PASS Reset restores recommendation (SD 1.5)
  PASS Generate tab shows / defaults 768x768 / dpmpp_2m+karras / run enabled
  PASS Transform tab shows / denoise 0.6 / maxSize 768 / run waits for image
  PASS Temp model listed + Delete button removed temp model
```

**Testing gaps:** no unit framework was added (the two `scripts/*.js` files are
standalone smoke tests); no long-running soak or concurrent-jobs test; no
VRAM-forcing test for the SDXL branch; no real phone test; the interactive
harness exercises the Edit/Generate/Transform tab *defaults* but does not click
"Forge/Generate/Transform" to run a job (the job APIs are covered directly, and
the static screenshots + graph dumps cover the workflows).

---

## 6. Known issues, risks, and design trade-offs

> Ordered by how much I think a reviewer should care.

### 6.1 No auth; LAN exposure is now destructive — **High**
`config.json` has `listenOnLan: true` (default). Any device on the WiFi can
reach `/api/*`, including the new `DELETE /api/models/installed/...` and
`/api/models/download`. Previously the worst case was generating images; now it
is deleting model files. Consider: bind to localhost by default, a shared token,
or a confirm token on destructive routes.

### 6.2 Deleting a symlinked model only removes the link — **High (behavioral)**
The installed checkpoint entry is a symlink
(`models/checkpoints/Realistic_….safetensors -> ../../models/realistic-vision-v5.1/…`).
`fsp.unlink` removes the link, not the target file. Consequences: disk space is
not reclaimed and the hub folder still holds the weights; a restart drops it from
the dropdown (expected) but the file survives. Decide the intended semantics:
(a) unlink only, (b) resolve realpath and delete target (dangerous if shared),
or (c) refuse to delete symlinks and tell the user. Not yet decided.

### 6.3 Spec maxSize clamp lives in the route, not the builder — **Medium**
`buildTxt2ImgWorkflow`/`buildImg2ImgWorkflow` only clamp to a hard `8192`
sanity value. A caller that invokes a builder directly (scripts, future API
work) bypasses the SD-1.5 `maxSize` rule. Cleaner: pass `maxSize` into the
builders and enforce there, with the route as a second gate.

### 6.4 `detectSystem()` on every generate/transform request — **Medium**
Both routes call `systeminformation`+`recommend()` per request to compute the
cap. This is avoidable latency and could be cached (e.g., 60 s) or replaced by a
stored recommendation. Edit doesn't do this (uses `config.defaults.maxSize`),
so behavior is also slightly inconsistent between tabs.

### 6.5 `applyAllDefaults` semantics after settings save — **Low (fixed)**
Originally `saveSettings()` called `applyAllDefaults()`, which reset the
Generate/Transform forms (stomping user edits) while correctly skipping Edit.
I removed the call. Trade-off: newly saved defaults won't retro-apply to open
forms; the user must reload or use "reset to recommended" (Edit only). A more
complete fix would track per-tab "dirty" state.

### 6.6 Placeholder files are deletable — **Low**
`listInstalled()` hides `put_*` sentinels, but the delete route accepts them
(e.g. `delete /api/models/installed/vae/put_vae_here`). Harmless, but the UI and
API disagree about what is a model. Suggest rejecting `put_*` and, optionally,
hidden/dotfiles.

### 6.7 `GET /api/config` exposes token key names — **Low**
`tokensSet` returns `{civitai:true, hf:true, …}`. That's not the secret, but it
does confirm which providers have keys to an unauthenticated LAN caller. Minor.

### 6.8 In-memory jobs only — **Low / by design**
`jobs` Map and download jobs live in RAM; a PixelKiln restart loses PixelKiln
job/SSE state (ComfyUI history and output files remain, and the UI reloads
history). Acceptable for a local app, but worth stating.

### 6.9 Generate compare component half-wired — **Low**
The Generate result reuses the `.compare` container with the before image/tag
and handle hidden (`withCompare:false`). `bindCompare()` is still attached
because the handle element exists. It's invisible so it's harmless, but the
pointer handlers are dead weight. Could skip binding when `withCompare` is false.

### 6.10 Five-tab mobile nav — **Low / untested**
The bottom tab bar now holds Edit/Generate/Transform/Models/Settings. CSS uses
`flex:1` per tab; on narrow phones this may be cramped. Not tested on a real
device.

### 6.11 Security note: live API tokens were read during this task — **Action item**
`config.json` (0600, gitignored) contains live Civitai/HuggingFace/GitHub
tokens. They appeared in tool output while I inspected the config. No secrets are
included in this document, but **if this session/transcript is shared, rotate
those keys and make sure `config.json` is never committed**.

---

## 7. Questions for the reviewer

1. **Job engine:** is `startJob({kind, buildWorkflow, inputs})` the right seam,
   or should the workflow builder own upload/width resolution too? I kept upload
   in `jobs.js` so all three kinds share it, but it means `jobs.js` still knows
   about "images".
2. **Symlink deletion (6.2):** which semantics do you recommend? I lean toward
   (c) refuse symlinks + explain, but (a) matches "remove from this ComfyUI list".
3. **Clamp location (6.3):** move `maxSize` enforcement into the builders and
   drop the route-level clamp, or keep both?
4. **Recommendation caching (6.4):** cache `detectSystem()`/`recommend()` or
   compute once at startup and store on the server?
5. **Auto-config scope (M5):** currently Edit-only (per plan). Should the
   Generate/Transform tabs also get spec-driven defaults on first load (they set
   size from `rec.maxSize` already, but not base model/checkpoint inference)?
6. **SSE vs polling:** the engine still has a WS-fallback-to-history path. Is the
   200 ms throttle + history fallback robust enough for long jobs?
7. **Route validation:** `POST /api/generate` and `/api/transform` trust
   `sampler`/`scheduler` strings. ComfyUI will reject unknown values at queue
   time (surfaced as a job error). Should the API pre-validate against
   `/object_info` instead?
8. **Anything in `public/app.js`** that looks like it violates §6 "keep user
   overrides" beyond what's noted — especially `renderBaseModelOptions()`
   preserving `current` on reload.

---

## 8. How to run / reproduce

```bash
# ComfyUI (already installed)
cd /home/sambit/sd-nsfw-edit && ./launch_comfyui.sh      # 127.0.0.1:8188

# PixelKiln
cd /home/sambit/projects/pixelkiln && npm start           # 127.0.0.1:3000
# LAN: http://192.168.0.113:3000  (phone: hard-refresh after UI edits)

# Tests
npm run check:comfy            # backend health + workflow node count
node scripts/comfy-check.js --run   # actually run the inpaint workflow
npm run check:ui               # interactive Firefox UI smoke test (15 checks)
```

Key files to review, in priority order:
1. `src/jobs.js` — engine correctness (phases, cancel, WS fallback, width resolution).
2. `src/workflow.js` — `buildTxt2ImgWorkflow`, `buildImg2ImgWorkflow` (VAEEncode!).
3. `src/server.js` — `/api/generate`, `/api/transform`, `DELETE /api/models/installed/:folder/:name`.
4. `public/app.js` — `createForgeTab`, `autoConfigureEditTab`, `deleteInstalledModel`.

---

## 9. Changelog summary

- **New:** `src/jobs.js`, `buildTxt2ImgWorkflow`, `buildImg2ImgWorkflow`,
  `clampSize`, `getModelFolderPath`, Generate/Transform tabs, generic `/api/jobs*`,
  `POST /api/generate`, `POST /api/transform`, `DELETE /api/models/installed/:folder/:name`,
  `createForgeTab`, recommendation banner + `autoConfigureEditTab`, installed-delete UI,
  `scripts/ui-smoke.js` + `npm run check:ui`.
- **Changed:** `/api/edit` delegated to `jobs.startJob`; `/api/queue` & `/api/history`
  use `jobs`; `init()` shows hash tab before async loads; `saveSettings()` no longer
  resets form defaults.
- **Removed:** `src/edits.js`.
