# Models: what they are and which to pick

Embernest does not download creative models for you. Setup installs the helper
models it needs (background removal, face detection and the safety classifier),
and the app suggests models. You choose what to download, with a click on
**Download** in the app or with `embernest models pull <url>`.

The first time you open the app with no checkpoint installed, a welcome screen
shows three starting points for your GPU. You can also browse them in
**Models → Suggested for you**.

## The model types

| Type | What it does | Size | Where it goes |
|---|---|---|---|
| **Checkpoint** | The main model. It draws the picture and sets the overall look (photo, anime, painting). You need one to make or edit images. | 2 to 7 GB | `checkpoints/` |
| **Inpainting checkpoint** | A checkpoint trained to repaint one part of a picture so the new part blends in. Edit works best with it. | 2 to 7 GB | `checkpoints/` |
| **LoRA** | A small add-on that nudges the checkpoint toward a style, face, detail or subject. Many have trigger words. | 10 to 200 MB | `loras/` |
| **Embedding** | A tiny file that teaches the model one new word. Negative embeddings (such as EasyNegative) help avoid flaws like bad hands or blur. Put their word in the negative prompt. | under 1 MB | `embeddings/` |
| **VAE** | Turns the model's internal picture into the final pixels. A better one gives cleaner colours. Most checkpoints already include one. | about 300 MB | `vae/` |

Helper models (background removal, face detection, the safety classifier) are
installed by setup and are not creative choices.

## Families, and which GPU runs which

Every checkpoint is built on a base model, called its **family**. A LoRA,
embedding or VAE is made for one family and must match your checkpoint.

| Family | Typical use | GPU tier that runs it well (see the README tier table) |
|---|---|---|
| **SD 1.5** | Small and quick. Best up to about 768 px. | cpu, tiny, low (under 7 GB VRAM) |
| **SDXL** | Sharper and more detailed, 1024 px. | mid, high (7 GB and up) |
| **Pony** | SDXL-based. Cartoon and stylised characters. | mid and up |
| **Illustrious** | SDXL-based. Anime and illustration. | mid and up |
| **Flux** | Newer, large. Needs a lot of memory. | ultra (over 16 GB) |

The tier is picked from your GPU's VRAM when you run `embernest setup`, and the
welcome screen and the suggestions use it. A model can be listed for your GPU
and still be slow; the card shows a warning when a model looks too big.

## Compatibility rules

Embernest reads the family of each file (from its name, or from the file header
for files it has already scanned) and compares it with your checkpoint:

- **Same family: works.** An SD 1.5 LoRA on an SD 1.5 checkpoint.
- **SDXL, Pony and Illustrious with each other: unknown.** They share the SDXL
  design, but a LoRA trained on one may not suit another. The LoRA list shows
  these with a ❔.
- **Different families: does not work.** An SDXL LoRA on an SD 1.5 checkpoint
  does nothing useful, so the LoRA picker hides it. Press **Show all (may not
  work)** to see it anyway.
- **Unknown family: unknown.** The file name and header did not say. Check the
  model's page.

The same rules warn you on a search result before you download a LoRA, embedding
or VAE that none of your installed checkpoints can use. The download still goes
ahead if you press it.

## Trigger words and strength

- **Trigger words** are the words a LoRA was trained with. Type them in the
  prompt, or tap the chip under the LoRA picker to add them to the end of the
  prompt. A chip whose word is already in the prompt is shown as pressed and is not added twice.
- **Strength** sets how strongly a LoRA applies. Embernest fills in the author's
  recommended strength when there is one, and 0.8 otherwise. 0.6 to 1.0 is a
  good range; higher strengths can distort the picture.

## Where the suggestions come from

`src/install/suggestions.json` is a short, hand-picked list grouped by goal:
edit photos (inpainting checkpoints), realistic photos, anime and illustration,
faces and skin (LoRAs), and quality boosters (negative embeddings and VAEs). Each
entry links to its page on Civitai or Hugging Face, and the file size and
SHA-256 are recorded where the source gives them. Only mainstream models with
permissive licences are listed, and none is focused on adult content.

The list is curated by hand and checked against the source pages. It is not a
full search. For anything else, use **Models** to search Civitai and Hugging Face.

## Licences

Every suggestion shows its licence on its card, and the licence text comes from
the model's author. Read it before you use the model. Some suggestions are
**personal use only** (no selling of images); others say that images may be sold,
and some ask you to credit the author. Embernest does not change or
override these terms, and it does not check them for you.

The checkpoint and LoRA licences apply to the model file, not to the pictures you
make with it. Read the licence before you publish or sell images.

## Setting a model up

1. Open **Models** (or the welcome screen) and pick a goal.
2. Check the fit badge and the licence on the card.
3. Press **Download**. Progress shows in the Models tab.
4. Wait for it to finish, then choose it in **Create** (Generate, Transform or
   Edit). For Edit, an inpainting checkpoint is usually best.
5. For a LoRA, choose it under the checkpoint, tap its trigger words and keep the
   recommended strength.

If a model does not appear after the download, restart the engine:
`embernest stop && embernest start`. See
[troubleshooting.md](troubleshooting.md#models-and-downloads).
