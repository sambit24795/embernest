/**
 * specs.js — detect the user's hardware and recommend model/settings.
 *
 * Uses the cross-platform `systeminformation` package (Linux/macOS/Windows).
 * This is intentionally tiny: one detection function + the VRAM lookup table
 * from section 5 of the plan.
 */
'use strict';

const si = require('systeminformation');

/** Round to `digits` decimal places (returns a Number). */
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Find the most capable graphics controller.
 *
 * A machine can report several controllers (e.g. Intel iGPU first, NVIDIA
 * dGPU second). We prefer the one with the largest reported VRAM, then fall
 * back to the first controller that has a model name.
 */
function pickGpu(controllers = []) {
  if (!controllers.length) return {};
  const withVram = controllers.filter((c) => (c.vram || 0) > 0);
  if (withVram.length) {
    return withVram.reduce((best, c) => ((c.vram || 0) > (best.vram || 0) ? c : best));
  }
  return controllers.find((c) => c.model) || controllers[0];
}

/**
 * Detect OS, GPU, VRAM (GB) and RAM (GB).
 *
 * @returns {Promise<{os:string, distro:string, arch:string, gpu:string,
 *                    vramGB:number, ramGB:number}>}
 */
async function detectSystem() {
  const [graphics, mem, osInfo] = await Promise.all([
    si.graphics(),
    si.mem(),
    si.osInfo(),
  ]);

  const gpu = pickGpu(graphics.controllers);
  // systeminformation reports vram in MB; the plan speaks in GB.
  const vramGB = (gpu.vram || 0) / 1024;
  const ramGB = (mem.total || 0) / 1e9;

  return {
    os: osInfo.platform || process.platform,
    distro: osInfo.distro || '',
    arch: osInfo.arch || process.arch,
    gpu: gpu.model || 'Unknown GPU',
    vramGB: round(vramGB, 1),
    ramGB: round(ramGB, 1),
  };
}

/**
 * VRAM-based recommendation table (plan section 5).
 * Accepts the object returned by detectSystem() (only vramGB is used).
 */
function recommend({ vramGB = 0 } = {}) {
  if (vramGB < 4) {
    return { baseModel: 'SD 1.5', maxSize: 512, lowvram: true, notes: 'very limited' };
  }
  if (vramGB <= 6) {
    return { baseModel: 'SD 1.5', maxSize: 768, lowvram: true, notes: 'recommended' };
  }
  if (vramGB <= 10) {
    return { baseModel: 'SDXL', maxSize: 1024, lowvram: true, notes: 'works, slower' };
  }
  if (vramGB <= 16) {
    return { baseModel: 'SDXL', maxSize: 1024, lowvram: false, notes: 'good' };
  }
  return { baseModel: 'SDXL/Flux', maxSize: 2048, lowvram: false, notes: 'great' };
}

module.exports = { detectSystem, recommend };
