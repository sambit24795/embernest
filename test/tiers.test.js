'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planForHardware, effectiveVram, chatPlan } = require('../src/core/tiers');

/** A healthy machine; override the fields each test cares about. */
function hw(over = {}) {
  const base = {
    os: 'linux',
    distro: 'Ubuntu',
    arch: 'x64',
    cpu: { model: 'Test CPU', cores: 8 },
    ramGB: 32,
    freeDiskGB: 100,
    gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vramGB: 12, driver: '580.95.05', cudaVersion: '12.8', computeCap: '8.6' },
    source: [],
  };
  return { ...base, ...over, gpu: { ...base.gpu, ...(over.gpu || {}) } };
}

const nv = (vramGB, extra = {}) => hw({ gpu: { vendor: 'nvidia', name: 'NVIDIA Test', vramGB, ...extra } });

test('cpu: no GPU gives cpu tier, --cpu flag and a warning', () => {
  const p = planForHardware(hw({ gpu: { vendor: 'none', name: '', vramGB: 0, cudaVersion: '', computeCap: '' } }));
  assert.equal(p.id, 'cpu');
  assert.equal(p.effectiveVramGB, 0);
  assert.deepEqual(p.comfyArgs, ['--cpu']);
  assert.equal(p.image.maxSize, 512);
  assert.equal(p.llm.sizeClass, '1-3B');
  assert.equal(p.torch.backend, 'cpu');
  assert.equal(p.torch.indexKey, null);
  assert.ok(p.warnings.includes('No supported GPU found — images will take minutes each'));
});

test('tiny: under 4 GB VRAM', () => {
  const p = planForHardware(nv(3));
  assert.equal(p.id, 'tiny');
  assert.equal(p.image.baseModel, 'SD 1.5');
  assert.equal(p.image.maxSize, 512);
  assert.equal(p.image.lowvram, true);
  assert.equal(p.llm.sizeClass, '1-3B');
  assert.deepEqual(p.comfyArgs, ['--lowvram']);
});

test('low: 4 to 6 GB VRAM, inclusive at both ends', () => {
  assert.equal(planForHardware(nv(4)).id, 'low');
  const p = planForHardware(nv(6));
  assert.equal(p.id, 'low');
  assert.equal(p.image.maxSize, 768);
  assert.equal(p.image.baseModel, 'SD 1.5');
  assert.equal(p.image.lowvram, true);
  assert.equal(p.llm.sizeClass, '3-4B');
});

test('mid: over 6 up to 10 GB VRAM', () => {
  assert.equal(planForHardware(nv(6.1)).id, 'mid');
  const p = planForHardware(nv(10));
  assert.equal(p.id, 'mid');
  assert.equal(p.image.baseModel, 'SDXL');
  assert.equal(p.image.maxSize, 1024);
  assert.equal(p.image.lowvram, true);
  assert.equal(p.llm.sizeClass, '7-8B');
});

test('high: over 10 up to 16 GB VRAM, no lowvram', () => {
  assert.equal(planForHardware(nv(10.1)).id, 'high');
  const p = planForHardware(nv(16));
  assert.equal(p.id, 'high');
  assert.equal(p.image.maxSize, 1024);
  assert.equal(p.image.lowvram, false);
  assert.deepEqual(p.comfyArgs, []);
  assert.equal(p.llm.sizeClass, '12-14B');
});

test('ultra: over 16 GB VRAM', () => {
  assert.equal(planForHardware(nv(16.1)).id, 'ultra');
  const p = planForHardware(nv(24));
  assert.equal(p.id, 'ultra');
  assert.equal(p.image.baseModel, 'SDXL/Flux');
  assert.equal(p.image.maxSize, 2048);
  assert.equal(p.image.lowvram, false);
  assert.equal(p.llm.sizeClass, '24B+');
});

test('GTX 16xx adds --fp32-vae; other NVIDIA cards do not', () => {
  const gtx = planForHardware(hw({ gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce GTX 1660 Ti', vramGB: 6, cudaVersion: '12.8', computeCap: '7.5' } }));
  assert.deepEqual(gtx.comfyArgs, ['--lowvram', '--fp32-vae']);
  const rtx = planForHardware(nv(8, { name: 'NVIDIA GeForce RTX 3070' }));
  assert.ok(!rtx.comfyArgs.includes('--fp32-vae'));
});

test('nvidia 6 GB with CUDA 12.8 and compute 7.5 picks cu128', () => {
  const p = planForHardware(hw({ gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce GTX 1660 Ti', vramGB: 6, cudaVersion: '12.8', computeCap: '7.5' } }));
  assert.equal(p.torch.backend, 'cuda');
  assert.equal(p.torch.indexKey, 'cu128');
  assert.deepEqual(p.torch.extraPackages, []);
  assert.equal(p.id, 'low');
});

test('nvidia with CUDA 12.8 but pre-Turing compute cap falls back to cu126', () => {
  const p = planForHardware(nv(8, { cudaVersion: '12.8', computeCap: '6.1' }));
  assert.equal(p.torch.indexKey, 'cu126');
});

test('nvidia with CUDA 13.2 and compute 7.5 picks cu130', () => {
  const p = planForHardware(hw({ gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce GTX 1660 Ti', vramGB: 6, cudaVersion: '13.2', computeCap: '7.5' } }));
  assert.equal(p.torch.indexKey, 'cu130');
});

test('nvidia with CUDA 13.0 but pre-Turing compute cap uses cu126', () => {
  const p = planForHardware(nv(8, { cudaVersion: '13.0', computeCap: '6.1' }));
  assert.equal(p.torch.indexKey, 'cu126');
});

test('nvidia with unknown compute cap still gets cu128', () => {
  const p = planForHardware(nv(8, { cudaVersion: '12.8', computeCap: '' }));
  assert.equal(p.torch.indexKey, 'cu128');
});

test('old NVIDIA driver (CUDA 12.4) falls back to cpu with a warning', () => {
  const p = planForHardware(nv(8, { cudaVersion: '12.4', computeCap: '8.6' }));
  assert.equal(p.torch.backend, 'cpu');
  assert.equal(p.torch.indexKey, null);
  assert.ok(p.warnings.includes('NVIDIA driver too old for current PyTorch — update the driver, then re-run setup'));
});

test('apple with 16 GB RAM: effective 10.4 GB, tier high, mps, no lowvram', () => {
  const p = planForHardware(hw({ os: 'darwin', arch: 'arm64', ramGB: 16, gpu: { vendor: 'apple', name: 'Apple M2', vramGB: 0, cudaVersion: '', computeCap: '' } }));
  assert.equal(p.effectiveVramGB, 10.4);
  assert.equal(p.id, 'high');
  assert.equal(p.torch.backend, 'mps');
  assert.equal(p.torch.indexKey, null);
  assert.deepEqual(p.comfyArgs, []);
});

test('apple never gets --lowvram even on a low tier', () => {
  const p = planForHardware(hw({ os: 'darwin', arch: 'arm64', ramGB: 8, gpu: { vendor: 'apple', name: 'Apple M1', vramGB: 0 } }));
  assert.equal(p.effectiveVramGB, 5.2);
  assert.equal(p.id, 'low');
  assert.equal(p.image.lowvram, true);
  assert.deepEqual(p.comfyArgs, []);
});

test('AMD on Windows uses DirectML with its warning and --directml', () => {
  const p = planForHardware(hw({ os: 'win32', gpu: { vendor: 'amd', name: 'AMD Radeon RX 6700 XT', vramGB: 12, cudaVersion: '', computeCap: '' } }));
  assert.equal(p.torch.backend, 'directml');
  assert.equal(p.torch.indexKey, null);
  assert.deepEqual(p.torch.extraPackages, ['torch-directml']);
  assert.ok(p.warnings.includes('AMD on Windows uses DirectML: works, but slower and less compatible than NVIDIA/ROCm'));
  assert.deepEqual(p.comfyArgs, ['--directml']);
  assert.equal(p.id, 'high');
});

test('AMD on Windows with 6 GB adds --lowvram before --directml', () => {
  const p = planForHardware(hw({ os: 'win32', gpu: { vendor: 'amd', name: 'AMD Radeon RX 6600', vramGB: 6 } }));
  assert.deepEqual(p.comfyArgs, ['--lowvram', '--directml']);
});

test('AMD on Linux uses rocm', () => {
  const p = planForHardware(hw({ os: 'linux', gpu: { vendor: 'amd', name: 'AMD Radeon RX 7900 XTX', vramGB: 24 } }));
  assert.equal(p.torch.backend, 'rocm');
  assert.equal(p.torch.indexKey, 'rocm');
  assert.deepEqual(p.comfyArgs, []);
  assert.equal(p.id, 'ultra');
});

test('Intel Mac: cpu backend with a warning, not mps', () => {
  const p = planForHardware(hw({ os: 'darwin', arch: 'x64', ramGB: 16, gpu: { vendor: 'none', name: 'Intel Iris Plus', vramGB: 0 } }));
  assert.equal(p.torch.backend, 'cpu');
  assert.ok(p.warnings.some((w) => /Intel Mac/.test(w)));
  assert.equal(p.id, 'cpu');
});

test('Intel Arc gives xpu', () => {
  const p = planForHardware(hw({ gpu: { vendor: 'intel', name: 'Intel Arc A770', vramGB: 16 } }));
  assert.equal(p.torch.backend, 'xpu');
  assert.equal(p.id, 'high');
});

test('warns on low RAM (under 8 GB)', () => {
  const p = planForHardware(hw({ ramGB: 4 }));
  assert.ok(p.warnings.some((w) => /RAM/.test(w)));
  assert.ok(!planForHardware(hw({ ramGB: 8 })).warnings.some((w) => /RAM/.test(w)));
});

test('warns when free disk is under 15 GB', () => {
  const p = planForHardware(hw({ freeDiskGB: 12 }));
  assert.ok(p.warnings.includes('Need ~15 GB free for engine + starter models'));
  assert.ok(!planForHardware(hw({ freeDiskGB: 15 })).warnings.includes('Need ~15 GB free for engine + starter models'));
});

test('effectiveVram: apple uses 65% of RAM, none is 0', () => {
  assert.equal(effectiveVram(hw({ ramGB: 16, gpu: { vendor: 'apple', vramGB: 0 } })), 10.4);
  assert.equal(effectiveVram(hw({ gpu: { vendor: 'none', vramGB: 0 } })), 0);
});

test('chatPlan: CPU with under 24 GB RAM is fast, budget 35% of RAM', () => {
  const h = hw({ ramGB: 15.5, gpu: { vendor: 'nvidia', vramGB: 6 } });
  const c = chatPlan(h, planForHardware(h));
  assert.deepEqual([c.device, c.defaultRole, c.budgetMB, c.warnings], ['cpu', 'fast', 5555, []]);
});

test('chatPlan: CPU with 24 GB RAM or more is balanced; no GPU is the CPU', () => {
  const h = hw({ ramGB: 32, gpu: { vendor: 'none', vramGB: 0 } });
  const c = chatPlan(h, planForHardware(h));
  assert.deepEqual([c.device, c.defaultRole, c.budgetMB], ['cpu', 'balanced', 11468]);
});

test('chatPlan: GPU above 8 GB is balanced, budget 60% of VRAM', () => {
  const h = hw({ ramGB: 16, gpu: { vendor: 'nvidia', vramGB: 12 } });
  const c = chatPlan(h, planForHardware(h));
  assert.deepEqual([c.device, c.defaultRole, c.budgetMB], ['gpu', 'balanced', 7372]);
});

test('chatPlan: an explicit device wins; low RAM warns', () => {
  const h = hw({ ramGB: 6, gpu: { vendor: 'nvidia', vramGB: 12 } });
  const plan = planForHardware(h);
  assert.equal(chatPlan(h, plan, 'cpu').device, 'cpu');
  assert.ok(chatPlan(h, plan, 'cpu').warnings.length === 1);
  assert.equal(chatPlan(hw({ gpu: { vendor: 'nvidia', vramGB: 6 } }), plan, 'gpu').device, 'gpu');
});
