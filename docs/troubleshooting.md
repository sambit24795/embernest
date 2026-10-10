# Troubleshooting

Start with `embernest doctor`. It checks the install and prints a fix for each
problem it finds. Use `embernest doctor --json` when you need the output in a file
or a bug report. Then look at the logs:

```sh
embernest logs            # the web app log
embernest logs engine     # the ComfyUI log
embernest logs -f engine  # follow it live
embernest status          # is it running, which URLs, GPU and disk use
```

Doctor's own messages are the source of truth. The sections below cover the
common ones.

## Setup and drivers

**NVIDIA: "driver too old for current PyTorch".** The installed driver does not
support CUDA 12.6. Update the NVIDIA driver, restart, then run
`embernest setup`. Until then, setup installs the CPU build.

**AMD on Linux: ROCm does not work for your card.** Install ROCm, then run
`embernest setup`. Some cards need an override: export
`HSA_OVERRIDE_GFX_VERSION` (for example `10.3.0` for RDNA 2 or `11.0.0` for RDNA 3)
in the shell, then run `embernest stop && embernest start`. ComfyUI inherits the
environment of the command that starts it.

**AMD on Windows is slow.** It uses DirectML, which works but is slower and less
compatible than NVIDIA or ROCm. That is expected, not a fault.

**Setup says the engine or a node is missing.** Run `embernest update engine`.
If doctor says ComfyUI is missing nodes, the pinned engine does not match this
Embernest version.

## Images

**Black or NaN images on a GTX 16xx card.** Setup adds `--fp32-vae` for these
cards. If your card is different and still gives black images, add the flag
yourself. Keep the flags setup chose, because `comfy.args` is passed to ComfyUI as
it is:

```sh
embernest config get comfy.args
embernest config set comfy.args '["--lowvram","--fp32-vae"]'
embernest stop && embernest start
```

**Out of VRAM (CUDA out of memory).** Make images smaller and use low-VRAM mode:

```sh
embernest config set defaults.maxSize 512
```

Add `--lowvram` to `comfy.args` as shown above, then restart. Setup already adds
`--lowvram` on every GPU tier up to 10 GB, except Apple.

**Photo edits say "Safety check unavailable".** The nudity classifier could not
start. Run `embernest doctor`; its `safety` check says whether the model loads and
why not. Edits and transforms stay blocked until it works. Generate is not affected.

**Image is blocked: "edits of uploaded photos can't produce nudity".** This is the
photo-edit filter, which is on by default and part of the acceptable-use policy. See [ACCEPTABLE_USE.md](../ACCEPTABLE_USE.md).

**"No checkpoint found", or the welcome screen says "Pick your first model".** Setup no
longer downloads a checkpoint by default. Pick one on the welcome screen, or in
**Models → Suggested for you**, then press Download. You can also run
`embernest models pull <url>` with a link you chose yourself. To get the starter
checkpoint without the app, run `embernest setup --starter`. See
[models.md](models.md).

**The welcome screen keeps coming back.** Press **Skip for now** to hide it on this
device. It stays hidden until you clear the site data in your browser.

## Models and downloads

**LoRA does nothing, or the picture looks wrong.** Check these in order:

1. **Family.** A LoRA only works with checkpoints of its family. An SDXL LoRA on an
   SD 1.5 checkpoint does nothing useful. The LoRA list hides these; if you pressed
   **Show all (may not work)**, pick a different LoRA or switch the checkpoint. A LoRA
   marked with a ❔ has an unknown family, so check its page. See
   [models.md](models.md#compatibility-rules).
2. **Trigger words.** Many LoRAs do nothing until you type their trigger words. Tap
   the chips under the LoRA picker to add them to the end of your prompt.
3. **Strength.** Start at the recommended strength (Embernest fills it in when it
   knows it). Strengths above about 1.0 often distort the picture; 0.6 to 1.0 is the usual range.
4. **Mismatched add-ons.** An embedding or VAE for another family is ignored or
   gives washed-out colours. Use the family that matches your checkpoint.

**Edit gives visible seams.** Use an inpainting checkpoint for Edit. The Create
hint suggests one when you pick a regular checkpoint.

**Hugging Face downloads fail or are blocked.** Add a Hugging Face token so the
download is authenticated:

```sh
embernest config set tokens.hf <your-token>
```

If the download host is blocked on your network, download the file in a browser on a network that works and copy
it into `<data folder>/data/models/<folder>/`. Then run `embernest models list`.

**A downloaded model does not appear in the list.** ComfyUI caches its model
list. Restart the engine with `embernest stop && embernest start`.

**Civitai NSFW results need a token.** Set one with
`embernest config set tokens.civitai <token>`.

## Chat

**Replies are slow.** Run `embernest chat bench` first. It times each installed model on
this machine and says which ones are fast enough for chat (at least 8 tokens per second,
and the first word within 3 seconds on the second turn). Then:

- If a fast-role model passes and the default model does not, select it with
  `embernest chat use qwen25-1b5`.
- If the first word is slow but the speed is fine, the prompt is being read again. Turns
  after the first should be quicker. Check the `chat reply:` lines in `embernest logs`:
  `cached_tokens` should be close to `prompt_tokens` on the second and later replies of a
  chat. A reply after a Think harder reply will not be cached (see below).
- On a big GPU, run `embernest chat device gpu`.

Restart with `embernest stop && embernest start` after any change.

**A reply after a Think harder reply is slow.** On a machine with less than 16 GB of RAM,
or with no think model set, the engine keeps one model loaded. Switching to the default
model unloads the think model, so the next reply reads the whole prompt again. This is
expected. The next reply in the same model is quick again.

**Think harder is very slow.** That is how reasoning works: the model thinks before it
writes the answer, and the "Thinking… (N s)" block shows the time. For quick answers use
the default model, and press 🧠 only for tricky questions.

**The 🧠 Think harder button is missing, or it says it is not set up.** Set a think model
with `embernest chat think enable`, then restart Embernest. The button only shows when a
think model is set.

**The chat says the engine is not running.** Read `embernest logs chat` and run
`embernest doctor`. If the model file is missing, run `embernest setup --chat`. If chat is
off, run `embernest chat enable`. Restart Embernest after either change.

**Out of memory.** Image generation fails with an out-of-memory error when chat runs on
the GPU. Another program that uses the GPU, such as another local LLM, can cause it too.
Run `embernest chat device cpu` to keep chat off the GPU, close the other program, or use a
smaller model. Restart Embernest after the change.

**Search fails.** DuckDuckGo sometimes blocks automated searches, and then the companion
answers without results. Set your own SearXNG address under **Settings → Chat search**.
Your SearXNG instance must allow `format=json`. A search that takes longer than 8 seconds
is given up. Try again, or use SearXNG.

See [chat.md](chat.md) for the full guide.

## Phone and network

**The phone cannot connect.** In order:

1. Check that the phone is on the same Wi-Fi. Guest networks and "client isolation"
   block phones.
2. Check that Embernest listens on the LAN: `embernest config get listenOnLan`
   should say `true`.
3. Allow the port through the computer's firewall. The firewall commands for each
   OS are in [phone.md](phone.md#1-same-wi-fi-the-usual-way).

**"Unknown host" (421).** The address you typed is not one Embernest accepts. Add
it with `embernest config set allowedHosts <host>`, then restart.

**"That pairing link is old".** The token was rotated. Run `embernest pair` again.

**"Too many failed attempts" (429).** Wait five minutes.

More phone help: [phone.md](phone.md).

## Ports

**"Port 3000 is already in use".** Another program has the port. Stop it, or
choose another port:

```sh
embernest config set port 3001
embernest start
```

Doctor also checks the engine port (8188 by default). It is local only. If another
program uses it, stop that program and start Embernest again.

## Still stuck

Open an issue with the bug report template. Include the output of
`embernest doctor --json` and `embernest status --json`, with any token or path you
do not want to share removed.
