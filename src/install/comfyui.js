'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getManifest } = require('./manifest');
const { downloadFile } = require('../core/download');
const { extract } = require('../core/archive');
const { run, ExecError } = require('../core/exec');
const { pipInstall } = require('./python');
const { probeTorch } = require('./torch');

const MARKER = '.pixelkiln-installed';
const VERIFY_TIMEOUT_MS = 180000;

/** Sub-folders of <data>/models that extra_model_paths.yaml maps (same names as ComfyUI's). */
const MODEL_FOLDERS = [
  'checkpoints', 'loras', 'vae', 'embeddings', 'controlnet', 'upscale_models',
  'background_removal', 'detection', 'diffusion_models', 'text_encoders', 'clip_vision',
];

/**
 * extra_model_paths.yaml for ComfyUI versions without --base-directory.
 * @param {string} modelsDir absolute path of <data>/models
 * @returns {string}
 */
function extraModelPathsYaml(modelsDir) {
  const lines = ['embernest:', `  base_path: ${JSON.stringify(modelsDir)}`, '  is_default: true'];
  for (const f of MODEL_FOLDERS) lines.push(`  ${f}: ${f}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Install the pinned ComfyUI release into <comfyRoot>/<tag>. Idempotent.
 * @param {Record<string, string>} paths
 * @param {string} uv
 * @param {{ tag?: string, onProgress?: Function, onLine?: Function, manifest?: object }} [opts]
 * @returns {Promise<string>} the ComfyUI folder
 */
async function installComfy(paths, uv, { tag, onProgress = null, onLine, manifest = getManifest() } = {}) {
  const cfg = manifest.comfyui;
  const useTag = tag || cfg.tag;
  const dir = path.join(paths.comfyRoot, useTag);
  if (fs.existsSync(path.join(dir, 'main.py')) && fs.existsSync(path.join(dir, MARKER))) return dir;

  const partial = `${dir}.partial`;
  await fsp.rm(partial, { recursive: true, force: true });
  await fsp.rm(dir, { recursive: true, force: true }); // a folder without marker is a failed install
  await fsp.mkdir(paths.tmp, { recursive: true });

  const archive = path.join(paths.tmp, `ComfyUI-${useTag}.tar.gz`);
  // The pinned sha256 belongs to the pinned tag only.
  const sha256 = useTag === cfg.tag ? cfg.sha256 : null;
  await downloadFile({ url: cfg.urlTemplate.replace('{tag}', useTag), dest: archive, sha256, onProgress });
  await extract(archive, partial, { strip: 1 });

  const before = await probeTorch(paths).catch(() => null);
  await pipInstall(paths, uv, ['-r', path.join(partial, 'requirements.txt')], { onLine });
  const after = await probeTorch(paths).catch(() => null);
  if (before && (!after || after.torch !== before.torch || after.device !== before.device)) {
    throw new Error(`ComfyUI requirements changed PyTorch (${before.torch} -> ${after ? after.torch : 'broken'})`);
  }

  await fsp.writeFile(path.join(partial, MARKER), `${useTag}\n`);
  await fsp.rename(partial, dir);
  await fsp.rm(archive, { force: true });
  return dir;
}

/** Last lines of a failed command's output, for the error message. */
function tail(text, n = 15) {
  return String(text || '').trim().split('\n').slice(-n).join('\n');
}

/**
 * Smoke test: start main.py with --quick-test-for-ci (imports everything, loads
 * custom nodes, exits 0 without binding a port).
 * @param {Record<string, string>} paths
 * @param {string} comfyDir
 * @param {string[]} comfyArgs tier flags, e.g. ['--lowvram']
 * @param {{ onLine?: Function, port?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ dataMode: 'base-directory'|'extra-model-paths' }>}
 */
async function verifyComfy(paths, comfyDir, comfyArgs = [], { onLine, port, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const env = { PYTHONUNBUFFERED: '1' };
  const help = await run(paths.venvPython, ['main.py', '--help'], { cwd: comfyDir, env, timeoutMs });
  const hasBase = help.stdout.includes('--base-directory');

  // ComfyUI lists custom_nodes at startup and crashes if the folder is missing.
  await Promise.all(['custom_nodes', 'user', 'models', 'input', 'output']
    .map((d) => fsp.mkdir(path.join(paths.data, d), { recursive: true })));

  let dataArgs;
  if (hasBase) {
    dataArgs = ['--base-directory', paths.data];
  } else {
    await fsp.writeFile(path.join(comfyDir, 'extra_model_paths.yaml'), extraModelPathsYaml(paths.models));
    dataArgs = ['--output-directory', paths.output, '--input-directory', paths.input];
  }
  const portArgs = port ? ['--port', String(port)] : [];

  try {
    await run(paths.venvPython, ['main.py', '--quick-test-for-ci', ...dataArgs, ...portArgs, ...comfyArgs],
      { cwd: comfyDir, env, timeoutMs, onLine });
  } catch (err) {
    if (err instanceof ExecError) {
      const why = err.timedOut ? 'timed out' : `failed (exit ${err.code})`;
      throw new Error(`ComfyUI smoke test ${why}:\n${tail(err.stderr || err.stdout)}`);
    }
    throw err;
  }
  return { dataMode: hasBase ? 'base-directory' : 'extra-model-paths' };
}

module.exports = { installComfy, verifyComfy, extraModelPathsYaml, MARKER };
