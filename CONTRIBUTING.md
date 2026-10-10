# Contributing

Thanks for helping. Embernest is small on purpose, so please read this first.

## Setup

- Node.js 22 or newer (`engines` in `package.json`)
- `npm ci`
- `npm test` runs the whole suite with `node --test`. It needs no GPU, no network
  and no real ComfyUI. Every test must pass before you open a PR.
- `node bin/embernest.js <command>` runs the CLI from your checkout.
- A safe install test: `EMBERNEST_HOME=$(mktemp -d) node bin/embernest.js setup --dry-run --yes`
  shows the plan without installing anything.

## Tests

Server tests run against a fake ComfyUI (`test/helpers/fake-comfy.js`, with
`fake-comfy-main.js`). It speaks the same HTTP and WebSocket endpoints as ComfyUI,
so the job, queue and download code can be tested without a GPU. Tests use a temp
folder through `EMBERNEST_HOME`. Never let a test touch your real data folder.

Every new pure module needs a `*.test.js` next to the others in `test/`.

## Code style

- CommonJS (`require`), `'use strict'`, plain JavaScript with JSDoc on exported
  functions. There is no build step and no TypeScript.
- Small functions. Comments only where the *why* is not obvious.
- Every path comes from `src/core/paths.js`. Do not build OS paths by hand.
- Spawn processes with argument arrays (`spawn(cmd, args)`), never with
  `shell: true` and string concatenation. Paths can contain spaces.
- Anything that touches processes, paths, `.exe` files or permissions must handle
  `win32`, `darwin` and `linux`. Use `src/core/platform.js`.
- Do not add a dependency without a written reason in the PR. Runtime dependencies
  are listed in `package.json`.

## The install manifest

Every outside URL, version and checksum lives in `src/install/manifest.json`, and
the code reads them only from there. Setup refuses to run while any value still
contains the word `VERIFY`.

When you change a version or a URL:

1. Check the new value online (the release page or the index), not from memory.
2. Put the source URL in the commit body.
3. Update the sha256 from the published checksum file. Never invent a checksum.

## Pull requests

- One feature or fix per PR. Keep unrelated cleanup out of it.
- Describe what changed and why, and how you tested it.
- Update the docs that describe the behavior you changed (`README.md`,
  `docs/api.md`, `docs/troubleshooting.md`). The docs must match the code.
- CI runs `npm test` on Linux, macOS and Windows, plus a dry-run setup and
  shellcheck on `install/install.sh`. The weekly end-to-end workflow (`e2e.yml`)
  runs a real CPU install.

## Never commit

- `config.json`, or any file from your data folder. It holds your pairing token and
  API tokens.
- Model files, generated images, logs or `.env` files.

## License

By contributing you agree that your contribution is released under the MIT
license in [LICENSE](LICENSE).
