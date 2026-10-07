# PixelKiln

**Forge your pixels** — a local web app that wraps an existing [ComfyUI](https://github.com/comfyanonymous/ComfyUI) install as its image-generation engine.

PixelKiln never reimplements generation; it only calls ComfyUI's REST API at
`http://127.0.0.1:8188`.

## Requirements

- Node.js >= 18
- A running ComfyUI server

## Setup

```bash
cd /home/sambit/projects/pixelkiln
npm install
npm start
```

On first run a `config.json` is created from `config.example.json`. It holds your
ComfyUI URL, port, LAN toggle and API tokens. **It is gitignored — never commit it.**

## Web UI

Open `http://127.0.0.1:<port>` (or the LAN URL printed on startup) in any browser.

- **Edit** — drop/upload an image, set the prompt and settings (base-model dropdown
  with ✅/⚠️/❌ badges, checkpoint, denoise, steps, cfg, sampler, scheduler, seed,
  preserve-face and restore-size toggles, max size), then *Forge image*. Results
  appear in a **drag-to-compare** before/after slider.
- **Models** — search Civitai / HuggingFace / ModelScope / GitHub, filter by type,
  base model, NSFW and sort. Each card shows a **fits-your-GPU** badge; Download
  streams into the correct ComfyUI folder with a live progress bar, and installed
  models are listed below.
- **Settings** — ComfyUI URL, app port, LAN toggle, API tokens and generation
  defaults (saved to `config.json`).

The UI is plain HTML/CSS/JS in `public/` with no build step: mobile-first with a
bottom nav on phones, ember/amber dark theme, skeleton loaders, animated progress
and `prefers-reduced-motion` support.

## LAN / phone access

PixelKiln binds `0.0.0.0` when `listenOnLan` is true (the default) and prints the
LAN URL(s) on startup, e.g. `http://192.168.0.113:3000`. Open that URL on a phone
connected to the same WiFi. ComfyUI itself stays on `127.0.0.1`; images and progress
are proxied through PixelKiln, so the phone only needs access to the PixelKiln port.
The Settings tab also shows the local/LAN URLs (via `GET /api/network`).

If the phone can't connect, allow the port through the OS firewall:

- **Linux (ufw):** `sudo ufw allow 3000/tcp`
- **Linux (firewalld):** `sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload`
- **macOS:** System Settings → Network → Firewall → Options → allow incoming for Node.
- **Windows:** allow Node.js through Windows Defender Firewall (Private networks), or
  `New-NetFirewallRule -DisplayName "PixelKiln" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow`.

Toggle LAN on/off and change the port in the **Settings** tab (restart required).
`config.json`, which holds API tokens, is written with `0600` permissions.

## API endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET  | `/api/specs`     | OS, GPU model, VRAM (GB), RAM (GB) |
| GET  | `/api/recommend` | Specs + VRAM-based base-model / max-size recommendation |
| GET  | `/api/status`    | ComfyUI health + installed checkpoints / models / samplers |
| GET  | `/api/models/search` | Aggregate Civitai / HF / ModelScope / GitHub with GPU-fit badges |
| GET  | `/api/models/installed` | Files already installed in the ComfyUI models folders |
| POST | `/api/models/download` | Start a download into the right models folder |
| GET  | `/api/models/downloads` | List download jobs |
| GET  | `/api/models/downloads/:id` | One job's status (polling) |
| GET  | `/api/models/downloads/:id/events` | SSE progress stream |
| DELETE | `/api/models/downloads/:id` | Cancel a download |
| GET  | `/api/image`     | Proxy an image from ComfyUI (so phones can view results) |
| POST | `/api/edit`      | Upload image + start an async inpaint job (202) |
| GET  | `/api/edit/jobs` | List edit jobs |
| GET  | `/api/edit/jobs/:id` | One edit job's status (polling) |
| GET  | `/api/edit/jobs/:id/events` | SSE phase + per-step progress |
| DELETE | `/api/edit/jobs/:id` | Cancel an edit |
| GET  | `/api/queue`     | ComfyUI running/pending prompts + active edits |
| POST | `/api/interrupt` | Interrupt the running prompt |
| DELETE | `/api/queue/:promptId` | Remove a pending prompt |
| GET  | `/api/history`   | Recent results with proxied image URLs |
| POST | `/api/comfy/restart` | Restart ComfyUI (only if configured) |

### Download manager

```bash
curl -X POST http://127.0.0.1:3000/api/models/download \
  -H 'Content-Type: application/json' \
  -d '{"downloadUrl":"https://civitai.com/api/download/models/123","type":"lora","fileName":"my.safetensors","fileSizeMB":54.8,"provider":"civitai"}'
# -> { "job": { "id": "...", "status": "queued" } }

# live progress (Server-Sent Events):
curl -N http://127.0.0.1:3000/api/models/downloads/<id>/events
```

The destination folder is resolved from ComfyUI itself via `GET /experiment/models`
(checkpoint→`checkpoints`, lora→`loras`, vae→`vae`, detection→`detection`,
background_removal→`background_removal`, embedding→`embeddings`, etc.). Files are
written to `<name>.part` then atomically renamed, so an interrupted download never
leaves a half-file. Tokens are read from `config.json` and attached **only** to the
provider's own host. On success the job sets `restartRequired: true` — ComfyUI must
be restarted to see a newly added model.

### `GET /api/models/search`

Query params: `provider` (`all`|`civitai`|`huggingface`|`modelscope`|`github`),
`query`, `type` (`checkpoint`|`lora`|`vae`|...), `baseModel`, `nsfw`,
`sort` (`downloads`|`likes`|`newest`), `limit` (1-50), `period`, `task`.

Each result is normalized to a common shape and carries a `fit` verdict
(`good` / `tight` / `no` / `unknown`) with a `label` like `✅ Fits your system`.

Tokens are read from `config.json` (`tokens.civitai`, `tokens.hf`,
`tokens.modelscope`, `tokens.github`). Civitai NSFW needs both `nsfw=true` and a
token; ModelScope search currently requires a token at all.

```bash
curl "http://127.0.0.1:3000/api/models/search?provider=civitai&query=realistic&limit=5"
curl "http://127.0.0.1:3000/api/models/search?provider=all&query=pony&nsfw=true&sort=downloads"
```

### `POST /api/edit` (async)

`multipart/form-data` with field `image` (required) and optional
`positive`, `negative`, `checkpoint`, `bgRemovalModel`, `faceModel`,
`width`, `height`, `maxSize`, `preserveFace`, `restoreSize`, `denoise`,
`steps`, `cfg`, `sampler`, `scheduler`, `seed`, `growMask`, `faceExpand`.

Returns `202 { job }` immediately. Stream progress from
`GET /api/edit/jobs/:id/events` (SSE): phases `uploading → queued → running →
saving → done`, plus per-step `{ step: { value, max } }` while the KSampler runs.

```bash
JOB=$(curl -s -X POST http://127.0.0.1:3000/api/edit \
  -F "image=@/path/to/photo.jpg" -F "positive=wearing a red silk shirt" -F "seed=42")
ID=$(echo "$JOB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["job"]["id"])')
curl -N http://127.0.0.1:3000/api/edit/jobs/$ID/events
curl -X DELETE http://127.0.0.1:3000/api/edit/jobs/$ID   # cancel
```

The finished job carries the result:

```json
{
  "status": "done",
  "promptId": "...",
  "before": "/api/image?filename=...&subfolder=pixelkiln&type=input",
  "after":  "/api/image?filename=...&subfolder=&type=output",
  "images": [ { "filename": "...", "url": "/api/image?..." } ],
  "settings": { "checkpoint": "...", "width": 1048, "height": 960, "maxSize": 768 }
}
```

Each job queues with its own ComfyUI `client_id`, so its WebSocket progress is
isolated even when other work is queued.

### Restart helper

Set a **ComfyUI start/restart command** in Settings (a script that stops the old
process if needed and starts a new one) and enable **Allow PixelKiln to restart
ComfyUI**. Then `POST /api/comfy/restart` runs it and waits for ComfyUI to go down
and come back up. Disabled by default — PixelKiln never kills processes it wasn't
told about.

## Testing

```bash
npm run check:comfy          # health + model lists + workflow node count
npm run check:comfy -- --run # real ComfyUI run (~70s)

curl http://127.0.0.1:3000/api/specs
curl http://127.0.0.1:3000/api/recommend
curl "http://127.0.0.1:3000/api/recommend?vramGB=8"
curl http://127.0.0.1:3000/api/status
```
