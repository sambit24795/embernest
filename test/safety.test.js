'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getPaths } = require('../src/core/paths');
const { createSafety, SafetyUnavailableError, workerArgs } = require('../src/server/safety');
const { getManifest } = require('../src/install/manifest');

// A stand-in worker speaking the same JSON-lines protocol. The "image" is text:
// a number is the score, "hang" never answers, "crash" exits, "bad" reports an error.
const STUB = `
const fs = require('fs');
console.log(JSON.stringify({ ready: true }));
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  const text = fs.readFileSync(req.path, 'utf8').trim();
  if (text === 'hang') return;
  if (text === 'crash') process.exit(3);
  if (text === 'bad') return console.log(JSON.stringify({ id: req.id, error: 'cannot identify image' }));
  console.log(JSON.stringify({ id: req.id, nsfw: Number(text) }));
});
`;

function fixture(t, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-safety-'));
  const paths = getPaths(home);
  const script = path.join(home, 'stub-worker.js');
  fs.writeFileSync(script, opts.script || STUB);
  const safety = createSafety({
    paths,
    getConfig: () => ({ comfy: { python: '' } }),
    manifest: { safety: { threshold: 0.7 } },
    command: { cmd: process.execPath, args: [script] },
    checkTimeoutMs: 600,
    startTimeoutMs: 3000,
    ...opts.options,
  });
  t.after(() => { safety.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { safety, paths };
}

test('score at or above the threshold is blocked, below is not', async (t) => {
  const { safety } = fixture(t);
  assert.deepEqual(await safety.check(Buffer.from('0.93')), { nsfwScore: 0.93, blocked: true });
  assert.deepEqual(await safety.check(Buffer.from('0.7')), { nsfwScore: 0.7, blocked: true });
  assert.deepEqual(await safety.check(Buffer.from('0.02')), { nsfwScore: 0.02, blocked: false });
});

test('the temp file is removed after each check', async (t) => {
  const { safety, paths } = fixture(t);
  await safety.check(Buffer.from('0.1'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fs.readdirSync(paths.tmp), []);
});

test('a timeout throws SafetyUnavailableError and the next check restarts the worker', async (t) => {
  const { safety } = fixture(t);
  await assert.rejects(safety.check(Buffer.from('hang')), SafetyUnavailableError);
  assert.deepEqual(await safety.check(Buffer.from('0.1')), { nsfwScore: 0.1, blocked: false });
});

test('a crashed worker fails that check and is restarted for the next', async (t) => {
  const { safety } = fixture(t);
  await safety.check(Buffer.from('0.1'));
  await assert.rejects(safety.check(Buffer.from('crash')), SafetyUnavailableError);
  assert.deepEqual(await safety.check(Buffer.from('0.95')), { nsfwScore: 0.95, blocked: true });
});

test('an unreadable image fails closed', async (t) => {
  const { safety } = fixture(t);
  await assert.rejects(safety.check(Buffer.from('bad')), /cannot identify image/);
});

test('a worker that never becomes ready fails closed', async (t) => {
  const { safety } = fixture(t, { script: 'setInterval(() => {}, 1000);', options: { startTimeoutMs: 300 } });
  await assert.rejects(safety.check(Buffer.from('0.1')), SafetyUnavailableError);
});

test('a worker that cannot be spawned fails closed', async (t) => {
  const { safety } = fixture(t, { options: { command: { cmd: path.join(os.tmpdir(), 'no-such-python-xyz'), args: [] } } });
  await assert.rejects(safety.check(Buffer.from('0.1')), SafetyUnavailableError);
});

test('managed config without a python fails closed', async (t) => {
  const { safety } = fixture(t, { options: { command: undefined } });
  await assert.rejects(safety.check(Buffer.from('0.1')), SafetyUnavailableError);
});

test('manifest pins the model by commit sha and the worker gets it', () => {
  const { safety: s } = getManifest();
  assert.match(s.revision, /^[0-9a-f]{40}$/);
  assert.equal(s.threshold, 0.7);
  const args = workerArgs('python', s, { warmup: true });
  assert.ok(args.includes(s.revision) && args.includes('--warmup'));
});
