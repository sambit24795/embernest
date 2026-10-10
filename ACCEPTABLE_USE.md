# Acceptable use

Embernest runs image models on your own computer. You choose the models, the
prompts and the photos. This page says what you agree to, what the software
enforces, and what it cannot enforce.

## You agree not to use Embernest to

- create sexual content involving anyone under 18, in any form, including
  drawn, generated, fictional or "de-aged" images. This is never allowed.
- create or share intimate or sexual images of a real person without their
  consent, including by editing a photo of them.
- harass, threaten or impersonate a real person, or make images meant to deceive
  people about a real event.
- break the law where you live, including laws on synthetic intimate images.
- break the license of a model, LoRA or dataset you use. Check each one before you
  download it. Embernest does not check licenses for you.

## Chat companion

The chat companion has these rules. They apply to every persona and every model.

- **Fixed preamble.** Every chat starts with the same preamble. It says the character is
  an adult, that the model must never produce sexual content involving minors, and that it
  must never sexualise real, identifiable people. A persona's own text cannot remove or
  change it.
- You agree not to use chat to create sexual content involving anyone under 18, in any
  form, including fiction, roleplay and "de-aged" characters. This is never allowed.
- Do not use chat to sexualise a real, identifiable person, or to harass, threaten or
  impersonate one.
- Do not give the companion passwords, card numbers or other secrets. Memory is for lasting
  facts, and the memory extraction skips secrets, but memory is not a safe place for them.
- Web search sends only your search terms, and only when you turn search on for a chat. The
  terms go to the provider you set (DuckDuckGo, or your own SearXNG instance).

## What the software enforces

- **Photo edits are checked (on by default).** The photo-edit check is part of this
  acceptable-use policy. Edits (`/api/edit`) and transforms
  (`/api/transform`) of photos you upload are scanned by a nudity classifier that
  runs locally on your computer (`python/nsfw_worker.py`, on the CPU). When a
  result is flagged, Embernest blocks it, deletes the image from ComfyUI's output
  folder and removes it from history. Blocked results are never shown.
- **Fails closed.** If the classifier cannot start, crashes or times out, the
  result is not released. The job reports that the safety check is unavailable.
  Run `embernest doctor` to find out why.
- **Auth keeps other people out.** Other devices on your network need a paired
  token to use the app, so a neighbour cannot use your GPU or see your images.

## What the software cannot enforce

- **Text-to-image (Generate) is not checked.** Embernest does not filter
  generated images that have no uploaded photo.
- **Model search is not filtered.** When you turn on NSFW search, results are shown
  as the source site lists them.
- **The classifier is not perfect.** It can miss images, and it can flag images
  that are not nudity. It does not check age, identity or consent.
- **Existing files are not checked.** Embernest does not scan your photo library
  or older images in the output folder.
- **Chat is not filtered.** Chat messages and personas are not scanned. The fixed
  preamble is an instruction to the model, not a filter. A model can still break it, and
  uncensored models are more likely to.
- **Models you install are your responsibility**, including what they can produce
  and the terms that come with them.

If you find a way to get around these checks, see [SECURITY.md](SECURITY.md) for
how to report it.
