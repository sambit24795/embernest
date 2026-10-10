'use strict';
const { getManifest } = require('./manifest');
const python = require('./python');

/** Device probeTorch should report for each planned backend (ROCm shows up as cuda). */
const EXPECTED_DEVICE = {
  cuda: 'cuda', rocm: 'cuda', mps: 'mps', xpu: 'xpu', directml: 'directml', cpu: 'cpu',
};

const PROBE_CODE = `
import json, torch
dev, name = 'cpu', 'CPU'
def works(d):
    # is_available() can be true while this GPU has no kernels in the wheel
    (torch.zeros(1, device=d) + 1).cpu()
    return True
try:
    if torch.cuda.is_available() and works('cuda'):
        dev, name = 'cuda', torch.cuda.get_device_name(0)
    elif torch.backends.mps.is_available() and works('mps'):
        dev, name = 'mps', 'Apple GPU'
    elif hasattr(torch, 'xpu') and torch.xpu.is_available() and works('xpu'):
        dev, name = 'xpu', torch.xpu.get_device_name(0)
    else:
        try:
            import torch_directml
            dev, name = 'directml', torch_directml.device_name(0)
        except Exception:
            pass
except Exception:
    pass
print(json.dumps({'torch': torch.__version__, 'device': dev, 'name': name}))
`;

/**
 * Pip arguments (after "install") for the planned torch backend.
 * @param {{ backend: string, indexKey: string|null, extraPackages?: string[] }} torchPlan
 * @param {object} manifest
 * @param {string} [plat] process.platform
 * @returns {string[]}
 */
function torchInstallArgs(torchPlan, manifest, plat = process.platform) {
  const packages = [...manifest.torch.packages];
  const { backend, indexKey, extraPackages = [] } = torchPlan;
  if (indexKey) {
    const url = manifest.torch.indexes[indexKey];
    if (!url) throw new Error(`manifest has no torch index "${indexKey}"`);
    return [...packages, '--index-url', url];
  }
  if (backend === 'directml') return [...packages, ...extraPackages];
  // Default Linux PyPI wheels are the huge CUDA build, so CPU-only Linux uses the cpu index.
  if (backend === 'cpu' && plat === 'linux') return [...packages, '--index-url', manifest.torch.indexes.cpu];
  return packages;
}

/**
 * Report which torch is installed in the venv and which device it can use.
 * @param {Record<string, string>} paths
 * @returns {Promise<{ torch: string, device: 'cuda'|'mps'|'xpu'|'directml'|'cpu', name: string }>}
 */
async function probeTorch(paths) {
  return JSON.parse(await python.pyEval(paths, PROBE_CODE));
}

/**
 * Install the torch build that matches the machine. Skips when the installed
 * torch already reaches the expected device; reinstalls when it does not.
 * @param {Record<string, string>} paths
 * @param {string} uv
 * @param {{ torch: object }} tierPlan result of planForHardware()
 * @param {{ onLine?: Function, manifest?: object, plat?: string, pip?: Function, probe?: Function }} [opts]
 *   pip and probe are injectable for tests
 * @returns {Promise<void>}
 */
async function installTorch(paths, uv, tierPlan, {
  onLine, manifest = getManifest(), plat = process.platform,
  pip = python.pipInstall, probe = probeTorch,
} = {}) {
  const expected = EXPECTED_DEVICE[tierPlan.torch.backend];
  let installed = null;
  try {
    installed = await probe(paths);
  } catch (_) {
    installed = null; // torch not importable yet
  }
  if (installed && installed.device === expected) return;

  const args = torchInstallArgs(tierPlan.torch, manifest, plat);
  if (installed) args.unshift('--reinstall');
  await pip(paths, uv, args, { onLine });

  const after = await probe(paths);
  if (after.device !== expected) {
    throw new Error(`PyTorch installed but reports device "${after.device}", expected "${expected}"`);
  }
}

module.exports = { installTorch, probeTorch, torchInstallArgs, EXPECTED_DEVICE };
