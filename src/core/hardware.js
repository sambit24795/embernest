'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./exec');
const platform = require('./platform');

const PROBE_TIMEOUT_MS = 10000;
const GB = 1024 ** 3;

/** @param {number} n @param {number} [digits] */
function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap
 * --format=csv,noheader,nounits`. One entry per GPU. Old drivers print
 * "[N/A]" or "[Not Supported]" for compute_cap, or only three columns; both
 * give computeCap ''.
 * @param {string} text
 * @returns {{ name: string, vramGB: number, driver: string, computeCap: string }[]}
 */
function parseNvidiaSmiCsv(text) {
  const gpus = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 3) continue;
    const mib = Number(cols[1]);
    if (!Number.isFinite(mib)) continue;
    const cap = cols[3] || '';
    gpus.push({
      name: cols[0],
      vramGB: round(mib / 1024, 1),
      driver: cols[2],
      computeCap: /^\d+(\.\d+)?$/.test(cap) ? cap : '',
    });
  }
  return gpus;
}

/**
 * Read "CUDA Version: 12.8" from the plain `nvidia-smi` header.
 * @param {string} text
 * @returns {string} e.g. '12.8', or '' when absent
 */
function parseCudaVersion(text) {
  const m = /CUDA Version:\s*(\d+\.\d+)/i.exec(String(text || ''));
  return m ? m[1] : '';
}

/**
 * Parse `rocm-smi --showmeminfo vram --json` (also tolerates a product-name
 * query merged in). Returns one entry per card, name may be ''.
 * @param {string} text
 * @returns {{ name: string, vramGB: number }[]}
 */
function parseRocmSmiJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return [];
  }
  const cards = [];
  for (const [key, val] of Object.entries(data || {})) {
    if (!/^card\d+/i.test(key) || !val || typeof val !== 'object') continue;
    const bytes = Number(val['VRAM Total Memory (B)']);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    cards.push({
      name: String(val['Card Series'] || val['Card series'] || val['Card model'] || ''),
      vramGB: round(bytes / GB, 1),
    });
  }
  return cards;
}

/**
 * Pick the GPU with the most memory.
 * @template {{ vramGB: number }} T
 * @param {T[]} gpus
 * @returns {T|null}
 */
function largest(gpus) {
  return gpus.reduce((best, g) => (!best || g.vramGB > best.vramGB ? g : best), null);
}

/**
 * Pick the most capable controller from systeminformation (largest VRAM,
 * else the first with a model name). Ported from the v0.1 code.
 * @param {object[]} controllers
 * @returns {object}
 */
function pickGpu(controllers = []) {
  if (!controllers.length) return {};
  const withVram = controllers.filter((c) => (c.vram || 0) > 0);
  if (withVram.length) return withVram.reduce((b, c) => ((c.vram || 0) > (b.vram || 0) ? c : b));
  return controllers.find((c) => c.model) || controllers[0];
}

async function probeNvidia(source) {
  const candidates = ['nvidia-smi'];
  if (platform.isWindows()) candidates.push('C:\\Windows\\System32\\nvidia-smi.exe');
  for (const cmd of candidates) {
    try {
      const csv = await run(
        cmd,
        ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits'],
        { timeoutMs: PROBE_TIMEOUT_MS },
      ).catch(async (err) => {
        // Old drivers reject compute_cap; retry without it.
        if (!/compute_cap|Field|invalid/i.test(`${err.stdout}${err.stderr}`)) throw err;
        return run(
          cmd,
          ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
          { timeoutMs: PROBE_TIMEOUT_MS },
        );
      });
      const best = largest(parseNvidiaSmiCsv(csv.stdout));
      if (!best) continue;
      let cudaVersion = '';
      try {
        cudaVersion = parseCudaVersion((await run(cmd, [], { timeoutMs: PROBE_TIMEOUT_MS })).stdout);
      } catch (_) { /* header is optional */ }
      source.push('nvidia-smi');
      return { vendor: 'nvidia', name: best.name, vramGB: best.vramGB, driver: best.driver, cudaVersion, computeCap: best.computeCap };
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

async function probeRocm(source) {
  try {
    const { stdout } = await run('rocm-smi', ['--showmeminfo', 'vram', '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    const best = largest(parseRocmSmiJson(stdout));
    if (!best) return null;
    source.push('rocm-smi');
    return { vendor: 'amd', name: best.name || 'AMD GPU', vramGB: best.vramGB };
  } catch (_) {
    return null;
  }
}

async function graphicsControllers(source) {
  try {
    const si = require('systeminformation');
    const g = await si.graphics();
    if (!source.includes('systeminformation')) source.push('systeminformation');
    return g.controllers || [];
  } catch (_) {
    return [];
  }
}

const vramOf = (c) => round((c.vram || 0) / 1024, 1);

async function probeGpu(osName, arch, source) {
  const nv = await probeNvidia(source);
  if (nv) return nv;

  if (osName === 'darwin' && arch === 'arm64') {
    const controllers = await graphicsControllers(source);
    const c = controllers.find((x) => x.model) || {};
    return { vendor: 'apple', name: c.model || 'Apple GPU', vramGB: 0 };
  }

  if (osName === 'linux') {
    const amd = await probeRocm(source);
    if (amd) return amd;
  }

  const controllers = await graphicsControllers(source);
  const amdCtl = controllers.filter((c) => /AMD|ATI|Radeon/i.test(`${c.vendor} ${c.model}`));
  if (amdCtl.length) {
    const c = pickGpu(amdCtl);
    return { vendor: 'amd', name: c.model || 'AMD GPU', vramGB: vramOf(c) };
  }
  const arc = controllers.find((c) => /Arc/i.test(c.model || ''));
  if (arc) return { vendor: 'intel', name: arc.model, vramGB: vramOf(arc) };

  // Integrated-only (or nothing) means no usable GPU.
  const c = pickGpu(controllers);
  if (c.model && (c.vram || 0) > 0 && !/Intel|Microsoft Basic|VMware|Virtual/i.test(`${c.vendor} ${c.model}`)) {
    return { vendor: 'none', name: c.model, vramGB: 0 };
  }
  return { vendor: 'none', name: '', vramGB: 0 };
}

async function distroName(osName) {
  try {
    const si = require('systeminformation');
    const info = await si.osInfo();
    return info.distro || (osName === 'linux' ? '' : info.release || '');
  } catch (_) {
    return '';
  }
}

/**
 * Free disk space (GB) at `dir`, or its nearest existing parent.
 * @param {string} dir
 * @returns {Promise<number>} 0 if it can't be determined
 */
async function freeDiskGB(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    try {
      const s = await fs.statfs(cur);
      return round((s.bavail * s.bsize) / GB, 1);
    } catch (_) {
      const parent = path.dirname(cur);
      if (parent === cur) return 0;
      cur = parent;
    }
  }
}

/**
 * Describe this machine. Never throws: a failed probe just means less info.
 * @param {{ dataDir?: string }} [opts]
 * @returns {Promise<{
 *   os: 'linux'|'darwin'|'win32', distro: string, arch: string,
 *   cpu: { model: string, cores: number }, ramGB: number, freeDiskGB: number,
 *   gpu: { vendor: 'nvidia'|'amd'|'apple'|'intel'|'none', name: string, vramGB: number,
 *          driver: string, cudaVersion: string, computeCap: string },
 *   source: string[]
 * }>}
 */
async function detectHardware({ dataDir = '.' } = {}) {
  const source = [];
  const osName = process.platform;
  const arch = platform.arch();
  const cpus = os.cpus() || [];

  const [distro, disk, g] = await Promise.all([
    distroName(osName),
    freeDiskGB(dataDir),
    probeGpu(osName, arch, source).catch(() => ({ vendor: 'none', name: '', vramGB: 0 })),
  ]);

  return {
    os: osName,
    distro,
    arch,
    cpu: { model: (cpus[0] && cpus[0].model || '').trim(), cores: cpus.length },
    ramGB: round(os.totalmem() / GB, 1),
    freeDiskGB: disk,
    gpu: { driver: '', cudaVersion: '', computeCap: '', ...g },
    source,
  };
}

module.exports = { detectHardware, parseNvidiaSmiCsv, parseCudaVersion, parseRocmSmiJson, freeDiskGB };
