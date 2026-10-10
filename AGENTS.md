# Rules for agents working on Embernest

## Workflow
- If a local `.internal/PLAN.md` exists, follow it one task at a time: read its
  §2–§6 once per session, then only the current phase file in `.internal/docs/plan/`.
  Implement the task, run its acceptance checks and `npm test`, then commit. Tick the
  task in the phase file. `.internal/` is git-ignored and never committed.
- Otherwise make focused changes, run `npm test`, and commit.
- Stage files by path (`git add <file>…`), never `git add -A`, `git add .` or
  `git commit -a`. The working tree may hold the owner's own uncommitted changes;
  leave them alone.
- If a check fails and you can't fix it within the task's scope, stop and report what
  failed (exact command + output). Do not weaken the check.
- If the spec is ambiguous, pick the simplest option and note it in the commit body
  under `Decision:`.

## Hard rules
- **Never print, log or commit secrets**: `authToken`, `tokens.*`, `config.json`
  contents. Log `"set"`/`"not set"` instead.
- **Never invent URLs, versions or checksums.** Items marked VERIFY must be
  checked online, and the source URL must be cited in the commit body.
- Spawn processes with **argument arrays** (`spawn(cmd, args)`), never `shell: true`
  with string concatenation. Paths may contain spaces (macOS "Application Support").
- Every path comes from `src/core/paths.js`. Don't build OS paths by hand.
- Cross-platform: anything touching processes, paths, executables (`.exe`), or
  permissions must handle `win32`, `darwin` and `linux`. Use `src/core/platform.js`.
- Don't add dependencies without a reason in the commit body.
- Keep the style of the surrounding code: CommonJS, `'use strict'`, JSDoc on
  exported functions, small functions, comments only where the *why* isn't obvious.
- Tests: `node --test` in `test/`. Every new pure module gets a `*.test.js`.
  Tests must not need a GPU, network, or real ComfyUI. Use `test/helpers/fake-comfy.js`
  and temp dirs (`EMBERNEST_HOME` pointed at `fs.mkdtempSync`).

## Commands
- `npm test` runs all unit tests (must pass before every commit).
- `node bin/embernest.js <cmd>` runs the CLI from the repo.
- `EMBERNEST_HOME=$(mktemp -d) node bin/embernest.js setup --dry-run --yes` runs an install in a throwaway folder.
