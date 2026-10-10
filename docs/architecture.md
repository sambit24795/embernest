# Architecture

Embernest is a Node.js server that supervises a ComfyUI engine on the same
computer. The phone and the browser talk only to Embernest. ComfyUI does the image
work and is never reachable from the network.

## Overview

```
            ┌────────────────────────── your computer ──────────────────────────┐
 phone ───► │ Embernest server  :3000  (0.0.0.0 when LAN on; auth + Host check) │
 browser    │   ├─ web UI (src/web)                                             │
            │   ├─ /api/* routes (src/server)                                   │
            │   └─ supervisor ──spawns──► ComfyUI :8188 (127.0.0.1 only)        │
            │                              python from <home>/venv               │
            │                              data in <home>/data                   │
 terminal ─►│ embernest CLI  (src/cli) — setup/start/stop/doctor/models/…       │
            └───────────────────────────────────────────────────────────────────┘
```

`embernest start` runs the supervisor and the HTTP server in one Node process.
`--background` starts that process detached and writes `<home>/run/state.json`.
`embernest stop` reads that file.

In **external** mode, the supervisor does not start ComfyUI. Embernest uses a
ComfyUI that you run yourself, at the URL in `comfy.url`.

## Module map

```
bin/embernest.js          CLI entry point → src/cli/index.js
src/
  version.js              version from package.json
  core/                   pure helpers, no Express and no ComfyUI
    paths.js              every path under the data folder
    config.js             config.json: defaults, load, save, settable keys
    tiers.js              hardware → tier, image and LLM settings, ComfyUI flags
    hardware.js           GPU, RAM and disk detection
    platform.js           OS differences (.exe names, venv layout)
    exec.js               spawn with argument arrays
    download.js           downloads with progress, atomic rename
    archive.js            tar.gz and zip extraction
    net.js                LAN addresses, free-port checks, loopback test
    log.js  state.js
  install/                setup steps (pinned in manifest.json)
    setup.js              runs the steps in order
    uv.js  python.js  torch.js  comfyui.js  models.js
  runtime/
    supervisor.js         starts, watches and restarts ComfyUI (managed mode)
    server-runner.js      runs the HTTP server, writes state
    doctor.js  status.js  logs.js
  server/                 Express app
    app.js                builds the app and mounts routes and auth
    auth.js               Host check, token and cookie, pairing, rate limit
    comfy.js              HTTP and WebSocket client for ComfyUI
    jobs.js               background jobs with live progress
    workflow.js           pure builders for ComfyUI workflow graphs
    safety.js             photo-edit nudity check (runs the Python worker)
    downloads.js          model download jobs
    models.js             model search across Civitai, Hugging Face
    imageMeta.js  util.js
    routes/               system, models, jobs, queue, engine, sse
  web/                    the phone-friendly web app: plain HTML, CSS and JS
  cli/                    commander commands in src/cli/commands/
python/                   scripts run with the managed venv python
  nsfw_worker.py          nudity classifier for photo edits (CPU)
  merge_checkpoints.py  merge_loras.py
  make_icons.py           one-off: renders the PWA icons
install/                  install.sh and install.ps1 (one-line installers)
test/                     node --test suites and the fake ComfyUI helper
```

The data folder (`<home>`) layout and the per-OS locations are in the
[README](../README.md#where-things-live).

## Job lifecycle

Edit, Generate and Transform each start a job. A job is a background run, so the
UI can show real progress:

```
uploading → queued → running → saving → done
                                     ↘ error | cancelled | blocked
```

1. **Route** (`/api/edit`, `/api/generate`, `/api/transform`) validates the input,
   picks the checkpoint, and clamps the size to the tier's `maxSize`. It returns
   `202 { job }` right away.
2. **Upload** (edit and transform): the image is kept in memory and its size is
   read, so the output can be restored to the original size.
3. **Queued and running**: the job sends a workflow to ComfyUI with its own client
   id, so its WebSocket messages belong to this job only. Per-step progress comes
   from ComfyUI's WebSocket. If the WebSocket fails, the job falls back to polling
   ComfyUI's history.
4. **Saving**: the output images are collected. For edit and transform, each
   image goes through the nudity check first. A flagged image, or a check that
   could not run, means the images are deleted from ComfyUI's output folder and
   the history entry is removed. The job ends as `blocked` or `error`.
5. **Done**: the job holds the image URLs. Clients read them through
   `/api/image`, which proxies ComfyUI.

Progress reaches the browser over Server-Sent Events (`/api/jobs/:id/events`).
Finished jobs stay in memory for one hour. Nothing about jobs is written to disk.

Model downloads have their own job store in `src/server/downloads.js`. The file
is written to a `.part` name and resumed with an HTTP Range request if it was
interrupted, then renamed when complete, so a half-written model never gets the
final name.

## Authentication in one paragraph

Every `/api/*` route runs the Host check, then the auth check. Requests from this
computer (loopback socket, loopback Host, no proxy headers) skip the token. All
other requests need the token, sent as the pairing cookie, a bearer header or
`X-PixelKiln-Token`. Writes from a foreign `Origin` are refused. Details are in
[api.md](api.md#authentication).
