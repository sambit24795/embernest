'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tar = require('tar');
const { installComfy, extraModelPathsYaml, MARKER } = require('../src/install/comfyui');
const { getPaths } = require('../src/core/paths');
const { sha256File } = require('../src/core/download');

test('extraModelPathsYaml maps the model folders under the models dir', () => {
  const y = extraModelPathsYaml('/data dir/models');
  assert.match(y, /^embernest:\n/);
  assert.match(y, /base_path: "\/data dir\/models"/);
  assert.match(y, /is_default: true/);
  assert.match(y, /\n  background_removal: background_removal\n/);
  assert.match(y, /\n  detection: detection\n/);
});

test('installComfy skips when main.py and the marker exist (no network)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-comfy-'));
  try {
    const paths = getPaths(home);
    const dir = path.join(paths.comfyRoot, 'v9.9.9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main.py'), '');
    fs.writeFileSync(path.join(dir, MARKER), 'v9.9.9\n');
    assert.equal(await installComfy(paths, 'uv', { tag: 'v9.9.9' }), dir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installComfy extracts with strip 1 and never exposes the final folder when requirements fail', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-comfy-'));
  const http = require('node:http');
  try {
    // Build a tiny ComfyUI-like tarball and serve it locally.
    const src = path.join(home, 'src', 'ComfyUI-v1');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'main.py'), 'print(1)\n');
    fs.writeFileSync(path.join(src, 'requirements.txt'), 'einops\n');
    const tgz = path.join(home, 'c.tar.gz');
    await tar.c({ gzip: true, file: tgz, cwd: path.join(home, 'src') }, ['ComfyUI-v1']);
    const sha = await sha256File(tgz);
    const server = http.createServer((req, res) => res.end(fs.readFileSync(tgz)));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const manifest = {
      comfyui: { tag: 'v1', sha256: sha, urlTemplate: `http://127.0.0.1:${server.address().port}/{tag}.tar.gz` },
    };

    const paths = getPaths(path.join(home, 'h'));
    // venvPython does not exist, so probeTorch rejects and is treated as "no torch".
    const dir = await installComfy(paths, 'definitely-not-uv', { manifest }).catch((e) => e);
    server.close();
    // pipInstall needs a real uv; the point here is only that extraction ran first.
    assert.ok(dir instanceof Error);
    assert.ok(fs.existsSync(path.join(paths.comfyRoot, 'v1.partial', 'main.py')));
    assert.ok(!fs.existsSync(path.join(paths.comfyRoot, 'v1')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
