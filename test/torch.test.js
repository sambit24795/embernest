'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { torchInstallArgs, installTorch } = require('../src/install/torch');
const { getManifest } = require('../src/install/manifest');
const { getPaths } = require('../src/core/paths');

const manifest = getManifest();
const pk = manifest.torch.packages;
const paths = getPaths('/tmp/pk-torch-test');

test('cuda index plan passes --index-url', () => {
  const args = torchInstallArgs({ backend: 'cuda', indexKey: 'cu128', extraPackages: [] }, manifest, 'linux');
  assert.deepEqual(args, [...pk, '--index-url', manifest.torch.indexes.cu128]);
});

test('rocm uses its index', () => {
  const args = torchInstallArgs({ backend: 'rocm', indexKey: 'rocm', extraPackages: [] }, manifest, 'linux');
  assert.deepEqual(args, [...pk, '--index-url', manifest.torch.indexes.rocm]);
});

test('mps is plain PyPI', () => {
  assert.deepEqual(torchInstallArgs({ backend: 'mps', indexKey: null, extraPackages: [] }, manifest, 'darwin'), pk);
});

test('cpu: cpu index on linux, plain PyPI on macOS and Windows', () => {
  const plan = { backend: 'cpu', indexKey: null, extraPackages: [] };
  assert.deepEqual(torchInstallArgs(plan, manifest, 'linux'), [...pk, '--index-url', manifest.torch.indexes.cpu]);
  assert.deepEqual(torchInstallArgs(plan, manifest, 'darwin'), pk);
  assert.deepEqual(torchInstallArgs(plan, manifest, 'win32'), pk);
});

test('directml appends extra packages', () => {
  const plan = { backend: 'directml', indexKey: null, extraPackages: ['torch-directml'] };
  assert.deepEqual(torchInstallArgs(plan, manifest, 'win32'), [...pk, 'torch-directml']);
});

test('unknown index key throws', () => {
  assert.throws(() => torchInstallArgs({ backend: 'cuda', indexKey: 'cu999' }, manifest), /cu999/);
});

/** Probe stub that returns each result in turn; an Error entry makes it throw. */
function probes(...results) {
  let i = 0;
  return async () => {
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
}
const cudaPlan = { torch: { backend: 'cuda', indexKey: 'cu128', extraPackages: [] } };

test('installTorch skips when the device is already right', async () => {
  const calls = [];
  await installTorch(paths, 'uv', cudaPlan, {
    manifest, plat: 'linux', pip: async (...a) => calls.push(a),
    probe: probes({ torch: '2.11.0+cu128', device: 'cuda', name: 'GPU' }),
  });
  assert.equal(calls.length, 0);
});

test('installTorch installs when torch is missing, without --reinstall', async () => {
  const calls = [];
  await installTorch(paths, 'uv', cudaPlan, {
    manifest, plat: 'linux', pip: async (p, u, args) => calls.push(args),
    probe: probes(new Error('no torch'), { torch: '2.11.0+cu128', device: 'cuda', name: 'GPU' }),
  });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('--reinstall'));
  assert.ok(calls[0].includes(manifest.torch.indexes.cu128));
});

test('installTorch reinstalls when CPU torch sits on a CUDA machine', async () => {
  const calls = [];
  await installTorch(paths, 'uv', cudaPlan, {
    manifest, plat: 'linux', pip: async (p, u, args) => calls.push(args),
    probe: probes({ torch: '2.11.0+cpu', device: 'cpu', name: 'CPU' }, { torch: '2.11.0+cu128', device: 'cuda', name: 'GPU' }),
  });
  assert.equal(calls[0][0], '--reinstall');
});

test('installTorch fails when the device is still wrong afterwards', async () => {
  await assert.rejects(installTorch(paths, 'uv', cudaPlan, {
    manifest, plat: 'linux', pip: async () => {},
    probe: probes(new Error('no torch'), { torch: '2.11.0+cu128', device: 'cpu', name: 'CPU' }),
  }), /expected "cuda"/);
});
