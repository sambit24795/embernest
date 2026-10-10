# Embernest

[![npm](https://img.shields.io/npm/v/embernest.svg)](https://www.npmjs.com/package/embernest)
[![license](https://img.shields.io/npm/l/embernest.svg)](LICENSE)

**A private, local AI studio.** Generate and edit images, and talk to a chat companion,
all on your own computer. One command checks your hardware and installs ComfyUI with the
right PyTorch for your GPU, then serves a phone-friendly web app. You choose the models.

<!-- Screenshots: add docs/img/chat-phone.png, docs/img/chat-desktop.png and docs/img/create-desktop.png (the owner adds them) -->

## Install

With Node.js 22 or newer:

```sh
npm i -g embernest
embernest setup    # detect hardware, install ComfyUI, PyTorch and the helper models
embernest start    # start the engine and the web app, and show a QR code
```

No Node.js? These install a private copy of Node together with Embernest.

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/sambit24795/embernest/main/install/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/sambit24795/embernest/main/install/install.ps1 | iex
```

Setup does not download a creative model (a checkpoint, LoRA or embedding). Open the
printed address in a browser, or scan the QR code with your phone (see
[docs/phone.md](docs/phone.md)). The app shows a welcome screen with a few starting
models for your GPU; pick your first model there, or in **Models → Suggested for you**.
For CLI or headless installs, `embernest setup --starter` also downloads the starter
checkpoint for your GPU. Details: [docs/models.md](docs/models.md).

Installer environment variables: `EMBERNEST_HOME` (data folder), `EMBERNEST_VERSION`
(npm version or tag, default `latest`), `EMBERNEST_SOURCE` (a local tarball or tarball
URL instead of npm), `EMBERNEST_BIN_DIR` (where the `embernest` command goes),
`EMBERNEST_NO_SETUP=1` (skip `setup`).

**Renamed from PixelKiln.** Existing installs keep working: your data folder
(`pixelkiln` / `PixelKiln`) is reused in place and never moved, `PIXELKILN_*`
environment variables are still read, the `pixelkiln` command remains an alias of
`embernest`, and phones that are already paired stay paired.

## What you get

- **Create**: generate from text, transform an image, or edit a photo (the subject is
  masked and only that part is repainted).
- **Models**: suggestions for your goal and GPU, with what each is for and its licence;
  search Civitai and Hugging Face; live download progress.
- **Chat companion**: a local chat model with personas, lasting memory, and per-message
  Search, Image and Think harder.
- **Phone pairing**: scan a QR code to use it from your phone.

## Privacy

Everything runs on your computer. The only thing that leaves it is a web search query,
and only when you tap Search on a message. Model downloads come from the sites you pick.

## Use it from your phone

Run `embernest pair` and scan the QR code with your phone while it is on the same
Wi-Fi. The phone is signed in with a cookie. Away from home, you can reach the
computer over Tailscale; see [docs/phone.md](docs/phone.md).

## What it does

The web app has four sections: **Chat**, **Create** (Generate, Transform and Edit), **Models** and
**Settings**. On a phone they sit in a bottom bar; on a computer, in a side bar.

- **Edit**: upload a photo and describe the change. The subject is masked
  automatically and only that part is repainted (inpainting). With *preserve face*
  on (the default), the face is kept.
- **Generate**: text to image.
- **Transform**: image to image, with a denoise strength.
- **LoRAs**: apply a LoRA style add-on in Edit, Generate and Transform; merge two
  checkpoints or two LoRAs.
- **Models**: suggested models for your goal and GPU, with what each one is for and
  its licence. Search Civitai and Hugging Face too. Each result shows
  whether it fits your GPU and whether it works with your checkpoint. See
  [docs/models.md](docs/models.md). Downloads show live progress into the right ComfyUI
  folder. Installed models can be listed and removed.
- **Queue and history**: see running and pending work, cancel it, and browse recent
  results.

## Chat companion

Optional. A chat model runs on your computer (llama.cpp), so you can talk to a
persona in the app. It keeps a short memory of lasting facts about you, which
Incognito turns off for one chat. Web search is available too, one message at a time.

- **Turn it on**: `embernest setup --chat`, answer yes to the question during setup,
  or run `embernest chat enable`.
- **Models**: three roles. **Fast** (Qwen2.5 1.5B) is the default on a CPU with less
  than 24 GB of RAM, because it answers in a second or two. **Balanced** (Llama 3.2 3B,
  Qwen3 4B, Qwen2.5 7B and 14B) is the default on a GPU and on bigger machines. Each role
  has a mainstream model and an uncensored "abliterated" one. `embernest chat models`
  lists the ones for this machine.
- **Think harder**: an optional reasoning model (Qwen3 4B Thinking). Press the 🧠 Think harder
  chip for one message when a question is tricky. It is much slower, because it reasons
  before it answers, and its reasoning is shown in a block you can collapse. Set it up with
  `embernest chat think enable`.
- **Speed**: `embernest chat bench` times each installed model and says which ones are
  fast enough for chat.
- **CPU or GPU**: on a GPU with 8 GB of VRAM or less, chat runs on the CPU. Another
  program that uses the GPU, such as another local LLM, can make image generation fail
  with out-of-memory.
- **Search**: press the 🔎 Search chip before a message to search the web for that one
  message. Only your search terms leave the computer, and they go to DuckDuckGo or to the
  SearXNG instance you set in Settings (Chat search). Sources appear under the reply.

Full guide, with personas, memory, search setup and the data folder:
[docs/chat.md](docs/chat.md).

## Supported hardware

Embernest reads your GPU's VRAM (on Apple Silicon, 65% of unified memory counts as
VRAM) and picks a tier. The tier sets the base model, the largest image size and
whether ComfyUI runs in low-VRAM mode.

| Tier | VRAM | Image base model | Largest size | Notes |
|---|---|---|---|---|
| cpu | no supported GPU | SD 1.5 | 512 px | CPU works but is slow: minutes per image |
| tiny | under 4 GB | SD 1.5 | 512 px | very limited |
| low | 4–6 GB | SD 1.5 | 768 px | recommended |
| mid | 7–10 GB | SDXL | 1024 px | works, slower |
| high | 11–16 GB | SDXL | 1024 px | good |
| ultra | over 16 GB | SDXL / Flux | 2048 px | great |

Backend per GPU vendor:

- **NVIDIA**: CUDA. Needs a driver for CUDA 12.6 or newer. An older driver makes
  setup fall back to CPU and tell you to update the driver.
- **AMD on Linux**: ROCm. Some cards need `HSA_OVERRIDE_GFX_VERSION`; `embernest doctor` says so.
- **AMD on Windows**: DirectML. It works, but it is slower and less compatible than NVIDIA or ROCm.
- **Apple Silicon**: MPS. Intel Macs run on CPU.
- **Intel**: XPU.

GTX 16xx cards get `--fp32-vae`, because they otherwise produce black images.
Cards with less VRAM get `--lowvram`.

## Commands

| Command | What it does |
|---|---|
| `embernest setup` | Detect hardware and install everything Embernest needs |
| `embernest start` | Start the engine and the web app (`--background`, `--open`) |
| `embernest stop` | Stop the web app and the engine |
| `embernest status` | Show whether it runs, its URLs, engine, GPU and disk use (`--json`) |
| `embernest logs` | Show the last lines of the server, engine or chat log (`engine`, `chat`, `-f`, `-n`) |
| `embernest doctor` | Check the install and print a fix for each problem (`--json`) |
| `embernest models` | List (`list`), download (`pull <url>`) and delete (`rm <folder>/<file>`) model files |
| `embernest config` | Show (`get [key]`) or change (`set <key> <value>`) settings |
| `embernest chat` | Turn the chat companion on or off, and choose its model and device (`enable`, `disable`, `models`, `use`, `device`, `bench`, `think`) |
| `embernest pair` | Show the QR code and URL to pair a phone (`--rotate`, `--url`) |
| `embernest update` | Show how to update the CLI, then update the engine (`update engine`) |
| `embernest uninstall` | Delete the data folder (`--keep-models`, `--keep-outputs`) |

Run `embernest <command> --help` for all options. The global `--home <dir>` option
sets the data folder.

Settings you can change with `embernest config set`: `port`, `listenOnLan`,
`allowedHosts`, `comfy.args`, `defaults.<name>` and `tokens.<name>`
(`civitai`, `hf`). Token values are never printed.

## Already have ComfyUI?

If you already run ComfyUI, point Embernest at it instead of installing a second copy:

```sh
embernest setup --comfy-dir /path/to/ComfyUI --comfy-python /path/to/python
```

Use `--comfy-url http://127.0.0.1:8188` if ComfyUI already runs and you do not
want Embernest to start it. To bring settings and tokens over from v0.1, use
`--import-config <path>`.

## Where things live

All state is in one data folder. Nothing is written into the code folder.

| OS | Default data folder |
|---|---|
| Linux | `$XDG_DATA_HOME/embernest`, else `~/.local/share/embernest` |
| macOS | `~/Library/Application Support/Embernest` |
| Windows | `%LOCALAPPDATA%\Embernest` |

Set `EMBERNEST_HOME` to use another folder. Inside it:

- `config.json`: settings, the pairing token and API tokens (mode 0600; never share it)
- `comfyui/`, `venv/`, `python/`, `tools/`, `node/`, `app/`: the engine, its Python, tools and the installed CLI
- `data/`: models, input and output images
- `logs/`, `run/`, `cache/`: logs, process state and download caches

To remove everything, run `embernest uninstall`. On Linux and macOS, the
`embernest` command file in `~/.local/bin` (or `EMBERNEST_BIN_DIR`) and the PATH
line added to your shell profile are not removed; delete them by hand.

## Content policy

Edits and transforms of uploaded photos are checked by a nudity classifier (on by
default, as part of the acceptable-use policy), and nude results are blocked and deleted. Generate (text to image) is not filtered.
See [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md) for what the software enforces and what
it cannot. Chat messages are not filtered; the chat rules are in the same file.

## Documentation

- [docs/phone.md](docs/phone.md): phone access, Tailscale, home screen install
- [docs/chat.md](docs/chat.md): the chat companion: models, personas, memory, search
- [docs/models.md](docs/models.md): model types, families and GPUs, compatibility, trigger words, licences
- [docs/api.md](docs/api.md): the HTTP API and authentication
- [docs/troubleshooting.md](docs/troubleshooting.md): common problems and fixes
- [docs/architecture.md](docs/architecture.md): how the parts fit together
- [SECURITY.md](SECURITY.md): threat model and how to report a vulnerability

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests run with `npm test` and need no GPU.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Embernest drives and relies on:

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (GPL-3.0). It is downloaded at install time, not shipped with Embernest.
- [uv](https://github.com/astral-sh/uv) (Python installs) and [PyTorch](https://pytorch.org)
- [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (background removal) and [MediaPipe](https://ai.google.dev/edge/mediapipe) (face detection)
- The authors of the models you download. Check each model's license before you use it.
