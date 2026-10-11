# Changelog

## 0.2.1

- `install.sh` offers to add `~/.local/bin` to PATH in your shell startup file
  (`EMBERNEST_MODIFY_PATH=1` to do it without asking, `EMBERNEST_NO_MODIFY_PATH=1` to never touch it).

## 0.2.0

- One-command install: `npm i -g embernest`, or the `install.sh` / `install.ps1` scripts
  for machines without Node. `embernest setup` detects the hardware and picks a tier.
- ComfyUI management: installs ComfyUI and the right PyTorch (CUDA, ROCm, DirectML, MPS,
  XPU or CPU), starts and stops it, `doctor`, `logs`, `update engine`. An existing
  ComfyUI can be used instead.
- Chat companion: a local llama.cpp chat model with personas, lasting memory,
  per-message Search, Image and Think harder, and `embernest chat` commands.
- Model guide: suggested models per GPU with licences, compatibility checks, and live
  download progress.
- New web UI with Chat, Create, Models and Settings, for phone and desktop.
- Phone pairing with a QR code and a cookie, plus Tailscale notes.
- Photo-edit nudity check, on by default, as part of the acceptable-use policy.
- Rewritten from v0.1 and renamed from PixelKiln (see below).

- Renamed the product from PixelKiln to Embernest. The command is now `embernest`;
  `pixelkiln` still works as an alias.
- Existing installs keep working: an existing `pixelkiln` / `PixelKiln` data folder is
  used in place (nothing is moved or copied), `PIXELKILN_*` environment variables are
  still read after `EMBERNEST_*`, and the old `X-PixelKiln-Token` header and the
  `pk_auth` cookie are still accepted, so paired phones stay paired.
- New files are named `embernest_*`; older `pixelkiln_*` images still show and delete.
- Chat: a tip appears when a message asks for a web search while the Search chip is off.
