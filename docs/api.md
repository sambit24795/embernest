# Embernest HTTP API

The web app and the phone both talk to one HTTP server, `embernest start`
(default `http://127.0.0.1:3000`). ComfyUI itself listens only on
`127.0.0.1:8188` and is reached through this API. Responses are JSON unless
noted. Errors look like `{ "error": "..." }`.

## Authentication

| Request comes from | Token needed? |
|---|---|
| This computer: loopback socket (`127.0.0.1` / `::1`), `Host` is `localhost`, `127.0.0.1` or `[::1]`, and no proxy headers | No |
| Anything else: a phone, another computer, or a reverse proxy such as `tailscale serve` | Yes |

A reverse proxy connects from `127.0.0.1` too, but it sends forwarding headers
(`Forwarded`, `X-Forwarded-For`, `X-Real-IP`, Tailscale identity headers), so it
is treated as remote and must present the token.

The token is the `authToken` in `config.json`. It is never sent to the browser
and never printed. A client can present it in one of these ways:

- Cookie `pk_auth=<token>`. `GET /pair?token=<token>` sets it (HttpOnly,
  SameSite=Strict, one year). `embernest pair` prints that link as a QR code.
- Header `Authorization: Bearer <token>`
- Header `X-PixelKiln-Token: <token>`

`embernest pair --rotate` makes a new token and signs out every paired device.

Other checks, applied to every request:

- **Host check.** Only these host names are accepted: `localhost`, `127.0.0.1`,
  `[::1]`, this computer's name (and `<name>.local`), its LAN addresses, any
  host in `allowedHosts`, and any `*.ts.net` name. Anything else gets `421`.
- **Origin check.** A non-GET request with a foreign `Origin` header gets `403`,
  even from loopback.
- **Rate limit.** After more than 10 failed token attempts from one address in a
  minute, that address is blocked for 5 minutes (`429`).

Unauthenticated `/api/*` requests get `401` with `{ "error": "Unauthorized", "pair": true }`.

## Routes

"Auth" is **no** only for the routes listed as public. Every other `/api/*`
route needs a token from a remote client.

### Public

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` and static files | no (Host check only) | The web app (`src/web`), served with `Cache-Control: no-cache` |
| GET | `/pair?token=` | no (rate limited) | Sets the pairing cookie and redirects to `/`. An old link gets an HTML page. |
| GET | `/api/health` | no | Liveness: `{ ok, name: "embernest", version }`. Used by `stop` and `status`. |

### Setup, config and system

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/logout` | yes | Clears the pairing cookie on this device |
| GET | `/api/specs` | yes | OS, GPU name and details, VRAM (GB, effective) and RAM (GB) |
| GET | `/api/recommend` | yes | Specs plus the tier's image recommendation. `?vramGB=` overrides the VRAM. |
| GET | `/api/config` | yes | Non-secret settings. Tokens appear only as true/false (`tokensSet`). Includes `chat.search.searxngUrl`. |
| PUT | `/api/config` | yes | Change settings. A token field only changes when a non-empty string is sent; `null` clears it. `chat.search.searxngUrl` takes an http(s) URL or `""` (anything else is a 400). |
| GET | `/api/network` | yes | Local and LAN URLs of this app |
| GET | `/api/status` | yes | ComfyUI health, checkpoints, models and samplers. Never fails: `{ online: false, error }` when ComfyUI is down. |

### Models

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/models/search` | yes | Search Civitai and Hugging Face. Query: `provider` (`all`, `civitai`, `huggingface`), `query`, `type`, `baseModel`, `nsfw`, `sort` (`downloads`, `likes`, `newest`), `limit` (1–50), `period`, `task`. Each result has a `fit` verdict for your GPU. |
| GET | `/api/models/installed` | yes | Model files in the ComfyUI model folders |
| DELETE | `/api/models/installed/:folder/:name` | yes | Delete one model file. `folder` must be a known model folder. Sets `restartRequired: true`. |
| POST | `/api/models/download` | yes | Start a download. Body: `{ downloadUrl, type, fileName, fileSizeMB, provider, folder? }`. Tokens come from config, never from the body. Returns a job. |
| GET | `/api/models/downloads` | yes | All download jobs, newest first |
| GET | `/api/models/downloads/:id` | yes | One download job (polling) |
| GET | `/api/models/downloads/:id/events` | yes | Progress as Server-Sent Events |
| DELETE | `/api/models/downloads/:id` | yes | Cancel a download |
| POST | `/api/models/merge` | yes | Merge two same-base checkpoints. Body: `{ ckptA, ckptB, ratio, filename }`. |
| POST | `/api/models/merge-loras` | yes | Merge two same-base LoRAs. Body: `{ loraA, loraB, strengthA, strengthB, filename }`. |

### Jobs: edit, generate, transform

Jobs run in the background. Create one, then follow it with polling or events.
Finished jobs are kept in memory for one hour.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/edit` | yes | Multipart upload: field `image` (required, up to 50 MB) plus optional fields such as `positive`, `negative`, `checkpoint`, `bgRemovalModel`, `faceModel`, `width`, `height`, `maxSize`, `preserveFace`, `restoreSize`, `denoise`, `steps`, `cfg`, `sampler`, `scheduler`, `seed`, `growMask`, `faceExpand`. Returns `202 { job }`. Subject to the photo-edit nudity check. |
| POST | `/api/transform` | yes | Multipart upload like `/api/edit`: image to image. Subject to the photo-edit nudity check. |
| POST | `/api/generate` | yes | Text to image, JSON body (`prompt`, `negative`, `checkpoint`, `width`, `height`, `steps`, `cfg`, `sampler`, `scheduler`, `seed`, `maxSize`, LoRA fields). Not subject to the nudity check. |
| GET | `/api/jobs` | yes | All jobs, newest first. Optional `?kind=edit|generate|transform`. |
| GET | `/api/jobs/:id` | yes | One job's status |
| GET | `/api/jobs/:id/events` | yes | Progress as Server-Sent Events: phases `uploading → queued → running → saving → done`, or `error`, `cancelled`, `blocked`. Per-step progress while sampling. |
| DELETE | `/api/jobs/:id` | yes | Cancel a running or pending job |
| GET | `/api/edit/jobs`, `/api/edit/jobs/:id`, `/api/edit/jobs/:id/events` | yes | Same as the generic job routes, limited to edit jobs |
| DELETE | `/api/edit/jobs/:id` | yes | Cancel an edit job |

Results are returned as image URLs under `/api/image`.

### Queue, history and images

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/queue` | yes | ComfyUI's running and pending prompts, plus active Embernest jobs |
| POST | `/api/interrupt` | yes | Stop the running prompt |
| DELETE | `/api/queue/:promptId` | yes | Remove a pending prompt |
| GET | `/api/history?limit=` | yes | Recent results (`limit` 1–50, default 12) with image URLs |
| DELETE | `/api/history/:promptId` | yes | Delete a result's image files from ComfyUI's output folder and remove it from history |
| GET | `/api/image?filename=&subfolder=&type=` | yes | Proxy one image from ComfyUI. Photo-edit results are not served until they pass the nudity check. |

### Engine

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/comfy/restart` | yes | Restart ComfyUI. Only in managed mode; with your own ComfyUI you restart it yourself. |

### Chat

Chat routes need the same token as every other `/api/*` route. Errors are
`{ "error": "..." }`. A chat that is off or not running gets `503` with
`{ "error", "hint": "embernest chat enable" }`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/chat/status` | `{ enabled, running, model, thinkModel, device, toolCalling, searchProvider }`. Never fails. `thinkModel` is the Think harder model id, or `""` when none is set. `toolCalling` is false when the model cannot use tools; `searchProvider` is `DuckDuckGo` or the SearXNG host. |
| GET | `/api/chat/conversations` | Saved chats, newest first: `id`, `title`, `personaId`, `updatedAt`, `incognito` |
| POST | `/api/chat/conversations` | Body `{ personaId? }`. Creates a chat (201). A persona's greeting becomes its first message. |
| GET | `/api/chat/conversations/:id` | One chat, with its messages. Assistant messages may carry `sources` (`{ title, url }`), `images` (`{ url }`), `thought` (`true` for a Think harder reply) and `thinkMs` (time until the answer started). |
| PATCH | `/api/chat/conversations/:id` | Body with any of `title`, `incognito`. A `searchEnabled` field is accepted and ignored; Search is per message (see below). |
| DELETE | `/api/chat/conversations/:id` | Delete a chat |
| POST | `/api/chat/conversations/:id/messages` | Body `{ content, temperature?, think?, image?, search? }` (`content` up to 20000 characters, `temperature` 0–2). Each flag applies to this message only. `search: true` searches the web with `content` first and puts the results in the context (sources are attached to the reply). `think: true` answers with the think model, with no tools; it can be combined with `search`. Without a think model it is `400 { error, hint: "embernest chat think enable" }`. `image: true` makes an image from `content` and wins over `search` (no search runs); `image` and `think` together are a 400. Streams server-sent events, see below. |
| GET | `/api/chat/personas` | List personas |
| POST | `/api/chat/personas` | Create a persona (400 with a reason when a field is invalid) |
| GET | `/api/chat/personas/:id` | One persona |
| PUT | `/api/chat/personas/:id` | Replace a persona's fields |
| DELETE | `/api/chat/personas/:id` | Delete a persona |
| GET | `/api/chat/memory/:personaId` | The persona's memories |
| POST | `/api/chat/memory/:personaId` | Body `{ text, pinned? }`. Add a memory (201). |
| PATCH | `/api/chat/memory/:personaId/:memoryId` | Body `{ text?, pinned? }`. Edit a memory. |
| DELETE | `/api/chat/memory/:personaId/:memoryId` | Delete one memory |
| DELETE | `/api/chat/memory/:personaId` | Forget all memories of the persona |
| POST | `/api/chat/avatars` | Multipart upload, field `file`: PNG, JPEG or WebP, up to 2 MB. Returns 201 `{ avatar: "upload:<name>" }`, the value to put in a persona's `avatar`. |
| GET | `/api/chat/avatars/:file` | The uploaded avatar |

**Message stream.** `POST .../messages` answers with `text/event-stream`. Each event is
one `data:` line with JSON:

- `{ "delta": "text" }`: a piece of the reply
- `{ "thinking": "text" }`: reasoning from a Think harder reply (`think: true`). It is sent
  as it is produced and is not saved. Answer text is `delta` events, as usual.
- `{ "tool": { "name", "status", "percent"? } }`: a tool is running. `name` is `web_search`
  or `generate_image`. `status` is `running`, `done` or `error`. `percent` appears for image
  progress.
- `{ "done": true, "message": { ... } }`: the saved reply, with `sources` and `images` when
  there are any. A Think harder reply has `thought: true` and `thinkMs`; only the answer is
  saved as `content`.
- `{ "error": "...", "hint": "..." }`: the reply failed. The partial reply is kept with
  `stopped: true`.

## Examples

Local, no token needed:

```sh
curl http://127.0.0.1:3000/api/status
curl "http://127.0.0.1:3000/api/models/search?provider=civitai&query=realistic&limit=5"
```

From a phone or another computer, with the token from `embernest pair` or a
cookie:

```sh
curl -H "Authorization: Bearer $PK_TOKEN" http://10.1.2.20:3000/api/status
```

Start a photo edit and follow it:

```sh
JOB=$(curl -s -X POST http://127.0.0.1:3000/api/edit \
  -F "image=@/path/to/photo.jpg" -F "positive=wearing a red silk shirt" -F "seed=42")
ID=$(echo "$JOB" | node -pe 'JSON.parse(require("fs").readFileSync(0)).job.id')
curl -N http://127.0.0.1:3000/api/edit/jobs/$ID/events
curl -X DELETE http://127.0.0.1:3000/api/edit/jobs/$ID   # cancel
```
