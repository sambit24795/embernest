'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { downloadFile, sha256File, ChecksumError } = require('../src/core/download');

const BODY = crypto.randomBytes(200 * 1024);
const SHA = crypto.createHash('sha256').update(BODY).digest('hex');

/** Serves BODY with Range support; the first `failFirst` requests get a 500. */
function serve({ failFirst = 0 } = {}) {
  const state = { requests: 0, ranges: [] };
  const server = http.createServer((req, res) => {
    state.requests++;
    state.auth = req.headers.authorization || null;
    if (state.requests <= failFirst) {
      res.writeHead(500);
      return res.end('boom');
    }
    const m = /bytes=(\d+)-/.exec(req.headers.range || '');
    state.ranges.push(req.headers.range || null);
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, {
        'Content-Length': BODY.length - start,
        'Content-Range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`,
      });
      return res.end(BODY.subarray(start));
    }
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.end(BODY);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    state.server = server;
    state.url = `http://127.0.0.1:${server.address().port}/f.bin`;
    resolve(state);
  }));
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pk-dl-'));

test('basic download with sha256 and progress', async () => {
  const s = await serve();
  const dir = tmp();
  const dest = path.join(dir, 'sub', 'f.bin');
  let last = null;
  try {
    const res = await downloadFile({ url: s.url, dest, sha256: SHA, onProgress: (p) => { last = p; } });
    assert.strictEqual(res.bytes, BODY.length);
    assert.strictEqual(res.sha256, SHA);
    assert.ok(fs.readFileSync(dest).equals(BODY));
    assert.ok(!fs.existsSync(`${dest}.part`));
    assert.deepStrictEqual(last, { received: BODY.length, total: BODY.length });
    assert.strictEqual(await sha256File(dest), SHA);
  } finally {
    s.server.close();
  }
});

test('resumes a partial .part file with a Range request', async () => {
  const s = await serve();
  const dir = tmp();
  const dest = path.join(dir, 'f.bin');
  fs.writeFileSync(`${dest}.part`, BODY.subarray(0, 50000));
  try {
    await downloadFile({ url: s.url, dest, sha256: SHA });
    assert.deepStrictEqual(s.ranges, ['bytes=50000-']);
    assert.ok(fs.readFileSync(dest).equals(BODY));
  } finally {
    s.server.close();
  }
});

test('retries after a 500', async () => {
  const s = await serve({ failFirst: 1 });
  const dest = path.join(tmp(), 'f.bin');
  try {
    await downloadFile({ url: s.url, dest, sha256: SHA, retryDelayMs: 5 });
    assert.strictEqual(s.requests, 2);
  } finally {
    s.server.close();
  }
});

test('checksum mismatch throws ChecksumError and leaves no file', async () => {
  const s = await serve();
  const dest = path.join(tmp(), 'f.bin');
  try {
    await assert.rejects(
      downloadFile({ url: s.url, dest, sha256: 'a'.repeat(64) }),
      (err) => err instanceof ChecksumError,
    );
    assert.ok(!fs.existsSync(dest));
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally {
    s.server.close();
  }
});

test('falls back to a mirror when the primary keeps failing', async () => {
  const bad = await serve({ failFirst: 1000 });
  const good = await serve();
  const dest = path.join(tmp(), 'f.bin');
  try {
    await downloadFile({ url: bad.url, dest, sha256: SHA, mirrors: [good.url], retryDelayMs: 1 });
    assert.strictEqual(bad.requests, 3);
    assert.strictEqual(good.requests, 1);
    assert.ok(fs.readFileSync(dest).equals(BODY));
  } finally {
    bad.server.close();
    good.server.close();
  }
});

test('second call is idempotent and makes no request', async () => {
  const s = await serve();
  const dest = path.join(tmp(), 'f.bin');
  try {
    await downloadFile({ url: s.url, dest, sha256: SHA });
    const res = await downloadFile({ url: s.url, dest, sha256: SHA });
    assert.strictEqual(s.requests, 1);
    assert.strictEqual(res.sha256, SHA);
  } finally {
    s.server.close();
  }
});

test('auth headers go to the primary host only, never to mirrors', async () => {
  const bad = await serve({ failFirst: 1000 });
  const good = await serve();
  const dest = path.join(tmp(), 'f.bin');
  try {
    await downloadFile({
      url: bad.url, dest, mirrors: [good.url], retryDelayMs: 1,
      headers: { Authorization: 'Bearer secret' },
    });
    assert.strictEqual(bad.auth, 'Bearer secret');
    assert.strictEqual(good.auth, null);
  } finally {
    bad.server.close();
    good.server.close();
  }
});

test('existing file without sha256 is returned without hashing', async () => {
  const dest = path.join(tmp(), 'f.bin');
  fs.writeFileSync(dest, BODY);
  const res = await downloadFile({ url: 'http://127.0.0.1:9/never', dest });
  assert.strictEqual(res.bytes, BODY.length);
  assert.strictEqual(res.sha256, null);
});
