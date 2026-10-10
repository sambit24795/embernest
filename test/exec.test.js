'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { run, which, ExecError } = require('../src/core/exec');

test('run captures stdout from a child process', async () => {
  const res = await run(process.execPath, ['-e', 'console.log(1)']);
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.stdout.trim(), '1');
});

test('run rejects with ExecError carrying code, stdout and stderr on non-zero exit', async () => {
  const script = "console.log('out'); console.error('err'); process.exit(3)";
  await assert.rejects(
    run(process.execPath, ['-e', script]),
    (err) => {
      assert.ok(err instanceof ExecError);
      assert.strictEqual(err.code, 3);
      assert.strictEqual(err.stdout.trim(), 'out');
      assert.strictEqual(err.stderr.trim(), 'err');
      return true;
    },
  );
});

test('run streams output line by line through onLine', async () => {
  const seen = [];
  const script = "console.log('a'); console.log('b'); console.error('c')";
  await run(process.execPath, ['-e', script], {
    onLine: (line, stream) => seen.push(`${stream}:${line}`),
  });
  assert.deepStrictEqual(seen.sort(), ['stderr:c', 'stdout:a', 'stdout:b']);
});

test('run treats args as literal values (no shell interpolation)', async () => {
  const res = await run(process.execPath, ['-e', 'console.log(process.argv[1])', 'a b; echo hacked']);
  assert.strictEqual(res.stdout.trim(), 'a b; echo hacked');
});

test('run rejects when the command cannot be spawned', async () => {
  await assert.rejects(run('definitely-not-a-cmd-xyz', []), ExecError);
});

test('run kills a child that exceeds timeoutMs', async () => {
  await assert.rejects(
    run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    (err) => err instanceof ExecError && err.timedOut === true,
  );
});

test('which is false for a command that does not exist', async () => {
  assert.strictEqual(await which('definitely-not-a-cmd-xyz'), false);
});

test('which is true for node', async () => {
  assert.strictEqual(await which(process.execPath), true);
});
