'use strict';

/**
 * Turn a hardware description (from detectHardware) into an install and run
 * plan. Pure: no I/O, so it can be tested with plain objects.
 */

const MIN_RAM_GB = 8;
const MIN_FREE_DISK_GB = 15;

/** @param {number} n @param {number} [digits] */
function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Effective VRAM in GB. Apple unified memory is shared with the CPU, so only
 * part of RAM is usable by the GPU.
 * @param {object} hw
 * @returns {number}
 */
function effectiveVram(hw) {
  const gpu = hw.gpu || {};
  if (gpu.vendor === 'apple') return round((hw.ramGB || 0) * 0.65, 1);
  if (gpu.vendor === 'nvidia' || gpu.vendor === 'amd' || gpu.vendor === 'intel') {
    return gpu.vramGB || 0;
  }
  return 0;
}

/**
 * Pick the tier id from the vendor and effective VRAM.
 * @param {string} vendor
 * @param {number} vram
 * @returns {'cpu'|'tiny'|'low'|'mid'|'high'|'ultra'}
 */
function tierId(vendor, vram) {
  if (vendor === 'none') return 'cpu';
  if (vram < 4) return 'tiny';
  if (vram <= 6) return 'low';
  if (vram <= 10) return 'mid';
  if (vram <= 16) return 'high';
  return 'ultra';
}

/** Image settings per tier. These numbers carry over from v0.1. */
const IMAGE_BY_TIER = {
  cpu: { baseModel: 'SD 1.5', maxSize: 512, lowvram: true, notes: 'CPU only, very slow' },
  tiny: { baseModel: 'SD 1.5', maxSize: 512, lowvram: true, notes: 'very limited' },
  low: { baseModel: 'SD 1.5', maxSize: 768, lowvram: true, notes: 'recommended' },
  mid: { baseModel: 'SDXL', maxSize: 1024, lowvram: true, notes: 'works, slower' },
  high: { baseModel: 'SDXL', maxSize: 1024, lowvram: false, notes: 'good' },
  ultra: { baseModel: 'SDXL/Flux', maxSize: 2048, lowvram: false, notes: 'great' },
};

/** LLM size class per tier. */
const LLM_BY_TIER = {
  cpu: { sizeClass: '1-3B', note: 'CPU only: small chat model' },
  tiny: { sizeClass: '1-3B', note: 'small chat model' },
  low: { sizeClass: '3-4B', note: 'small chat model' },
  mid: { sizeClass: '7-8B', note: 'mid-size chat model' },
  high: { sizeClass: '12-14B', note: 'large chat model' },
  ultra: { sizeClass: '24B+', note: 'largest chat model' },
};

/**
 * ComfyUI command-line flags for this machine.
 * @param {object} hw
 * @param {string} id tier id
 * @param {boolean} lowvram from IMAGE_BY_TIER
 * @returns {string[]}
 */
function comfyArgsFor(hw, id, lowvram) {
  const gpu = hw.gpu || {};
  if (id === 'cpu') return ['--cpu'];
  const args = [];
  if (lowvram && gpu.vendor !== 'apple') args.push('--lowvram');
  if (gpu.vendor === 'nvidia' && /GTX 16\d\d/i.test(gpu.name || '')) args.push('--fp32-vae');
  if (gpu.vendor === 'amd' && hw.os === 'win32') args.push('--directml');
  return args;
}

/**
 * Parse "major.minor" into a comparable number pair.
 * @param {string} v e.g. '12.8'
 * @returns {number[]|null} null when empty or not a version
 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** @returns {number} negative, zero or positive, like a comparator */
function cmpVersion(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * PyTorch wheel index for an NVIDIA GPU. Keys are in manifest.json.
 * @param {object} gpu
 * @returns {{ indexKey: string|null, warning: string|null }}
 */
function nvidiaIndex(gpu) {
  const cuda = parseVersion(gpu.cudaVersion);
  const cap = parseVersion(gpu.computeCap);
  // cu130 (driver CUDA >= 13.0) is what ComfyUI recommends for RTX 20-series and newer;
  // CUDA 12.8+/13 wheels dropped pre-Turing (sm < 7.5), which stay on cu126.
  if (cuda && cmpVersion(cuda, [13, 0]) >= 0 && (!cap || cmpVersion(cap, [7, 5]) >= 0)) {
    return { indexKey: 'cu130', warning: null };
  }
  if (cuda && cmpVersion(cuda, [12, 8]) >= 0 && (!cap || cmpVersion(cap, [7, 5]) >= 0)) {
    return { indexKey: 'cu128', warning: null };
  }
  if (cuda && cmpVersion(cuda, [12, 6]) >= 0) return { indexKey: 'cu126', warning: null };
  return {
    indexKey: null,
    warning: 'NVIDIA driver too old for current PyTorch — update the driver, then re-run setup',
  };
}

/**
 * Torch backend and package plan for this machine.
 * @param {object} hw
 * @returns {{ plan: { backend: string, indexKey: string|null, extraPackages: string[] }, warnings: string[] }}
 */
function torchPlan(hw) {
  const gpu = hw.gpu || {};
  const none = { indexKey: null, extraPackages: [] };
  const warnings = [];

  if (hw.os === 'darwin' && hw.arch === 'x64') {
    warnings.push('Intel Mac: no GPU acceleration for PyTorch, images will be slow');
    return { plan: { backend: 'cpu', ...none }, warnings };
  }

  switch (gpu.vendor) {
    case 'nvidia': {
      const { indexKey, warning } = nvidiaIndex(gpu);
      if (warning) {
        warnings.push(warning);
        return { plan: { backend: 'cpu', ...none }, warnings };
      }
      return { plan: { backend: 'cuda', indexKey, extraPackages: [] }, warnings };
    }
    case 'amd':
      if (hw.os === 'win32') {
        warnings.push('AMD on Windows uses DirectML: works, but slower and less compatible than NVIDIA/ROCm');
        return { plan: { backend: 'directml', indexKey: null, extraPackages: ['torch-directml'] }, warnings };
      }
      return { plan: { backend: 'rocm', indexKey: 'rocm', extraPackages: [] }, warnings };
    case 'apple':
      return { plan: { backend: 'mps', ...none }, warnings };
    case 'intel':
      return { plan: { backend: 'xpu', ...none }, warnings };
    default:
      warnings.push('No supported GPU found — images will take minutes each');
      return { plan: { backend: 'cpu', ...none }, warnings };
  }
}

/**
 * Build the install and run plan for a machine.
 * @param {object} hw result of detectHardware()
 * @returns {{
 *   id: 'cpu'|'tiny'|'low'|'mid'|'high'|'ultra',
 *   effectiveVramGB: number,
 *   image: { baseModel: string, maxSize: number, lowvram: boolean, notes: string },
 *   comfyArgs: string[],
 *   torch: { backend: 'cuda'|'rocm'|'mps'|'xpu'|'directml'|'cpu', indexKey: string|null, extraPackages: string[] },
 *   llm: { sizeClass: '1-3B'|'3-4B'|'7-8B'|'12-14B'|'24B+', note: string },
 *   warnings: string[]
 * }}
 */
function planForHardware(hw) {
  const gpu = hw.gpu || {};
  const effectiveVramGB = effectiveVram(hw);
  const id = tierId(gpu.vendor || 'none', effectiveVramGB);
  const image = { ...IMAGE_BY_TIER[id] };
  const torch = torchPlan(hw);

  const warnings = [...torch.warnings];
  if ((hw.ramGB || 0) < MIN_RAM_GB) {
    warnings.push(`Only ${hw.ramGB} GB RAM: expect slow generation and swapping`);
  }
  if ((hw.freeDiskGB || 0) < MIN_FREE_DISK_GB) {
    warnings.push('Need ~15 GB free for engine + starter models');
  }

  return {
    id,
    effectiveVramGB,
    image,
    comfyArgs: comfyArgsFor(hw, id, image.lowvram),
    torch: torch.plan,
    llm: { ...LLM_BY_TIER[id] },
    warnings,
  };
}

/** Chat runs on the CPU when the GPU has this much VRAM or less. */
const CPU_MAX_VRAM_GB = 8;
/** Below this much RAM the fast model is the default; at or above it, balanced. */
const BALANCED_MIN_RAM_GB = 24;
const CPU_BUDGET_SHARE = 0.35;
const GPU_BUDGET_SHARE = 0.6;

/**
 * Which chat device and model role suit a machine, and how big a model may be.
 * Pure. The budget is a share of the memory the model runs in (RAM on the CPU,
 * VRAM on the GPU), so no recommendation is larger than that.
 * @param {{ ramGB?: number }} hw result of detectHardware()
 * @param {{ effectiveVramGB?: number }} tierPlan result of planForHardware()
 * @param {'auto'|'cpu'|'gpu'} [device] an explicit choice from config; `auto` decides by VRAM
 * @returns {{ device: 'cpu'|'gpu', defaultRole: 'fast'|'balanced', budgetMB: number, warnings: string[] }}
 */
function chatPlan(hw, tierPlan, device = 'auto') {
  const ramGB = hw.ramGB || 0;
  const vramGB = tierPlan.effectiveVramGB || 0;
  const where = device === 'cpu' || device === 'gpu' ? device : (vramGB > CPU_MAX_VRAM_GB ? 'gpu' : 'cpu');
  const warnings = [];
  if (where === 'gpu') {
    return { device: 'gpu', defaultRole: 'balanced', budgetMB: Math.floor(vramGB * 1024 * GPU_BUDGET_SHARE), warnings };
  }
  if (ramGB < MIN_RAM_GB) warnings.push(`Only ${ramGB} GB RAM: chat replies will be slow, a fast model is recommended`);
  return {
    device: 'cpu',
    defaultRole: ramGB < BALANCED_MIN_RAM_GB ? 'fast' : 'balanced',
    budgetMB: Math.floor(ramGB * 1024 * CPU_BUDGET_SHARE),
    warnings,
  };
}

module.exports = { planForHardware, effectiveVram, tierId, chatPlan };
