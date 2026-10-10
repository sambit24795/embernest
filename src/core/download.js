'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const ATTEMPTS = 3;

/** The downloaded bytes did not match the expected sha256. */
class ChecksumError extends Error {
  /** @param {string} message @param {{ expected: string, actual: string }} info */
  constructor(message, { expected, actual }) {
    super(message);
    this.name = 'ChecksumError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** HTTP error that records whether a retry could help. */
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryable = status >= 500;
  }
}

/**
 * sha256 of a file, streamed.
 * @param {string} file
 * @returns {Promise<string>} lowercase hex digest
 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

/** One request: appends to (or restarts) the .part file. */
async function fetchToPart({ url, part, headers, onProgress, signal }) {
  let offset = await sizeOf(part);
  const reqHeaders = { ...headers };
  if (offset > 0) reqHeaders.Range = `bytes=${offset}-`;
  const res = await fetch(url, { headers: reqHeaders, signal });

  if (res.status === 416) {
    // Our .part is not a valid prefix (or is already whole); start over.
    await fsp.rm(part, { force: true });
    await res.body?.cancel();
    throw new HttpError(`HTTP 416 from ${url}`, 503);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(`HTTP ${res.status} from ${url}`, res.status);
  }

  let flags = 'a';
  if (res.status !== 206) {
    offset = 0; // server ignored Range: restart from scratch
    flags = 'w';
  }
  const len = Number(res.headers.get('content-length'));
  const total = Number.isFinite(len) && len > 0 ? offset + len : null;
  let received = offset;
  if (onProgress) onProgress({ received, total });

  const out = fs.createWriteStream(part, { flags });
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      received += chunk.length;
      if (onProgress) onProgress({ received, total });
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

/** Tries one URL up to ATTEMPTS times. */
async function tryUrl(opts, retryDelayMs) {
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await fetchToPart(opts);
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      if (err instanceof HttpError && !err.retryable) break;
      if (attempt < ATTEMPTS) await sleep(retryDelayMs * attempt);
    }
  }
  throw lastErr;
}

/**
 * Download url to dest. Writes dest + '.part', resumes it with a Range header when
 * the server answers 206, verifies sha256 when given, then renames into place.
 * Follows redirects. Retries 3x with backoff on network errors / 5xx, then tries
 * each mirror in order. Idempotent: returns at once when dest already exists
 * (and matches sha256, when given; the result's sha256 is null when none was given).
 * Headers are only sent to `url`'s host; mirrors on other hosts get none.
 * @param {{ url: string, dest: string, sha256?: string|null, headers?: object,
 *   onProgress?: ((p: { received: number, total: number|null }) => void)|null,
 *   signal?: AbortSignal|null, mirrors?: string[], retryDelayMs?: number }} opts
 * @returns {Promise<{ path: string, bytes: number, sha256: string|null }>}
 */
async function downloadFile({
  url, dest, sha256 = null, headers = {}, onProgress = null, signal = null,
  mirrors = [], retryDelayMs = 500,
}) {
  const expected = sha256 ? sha256.toLowerCase() : null;
  if (fs.existsSync(dest)) {
    const bytes = (await fsp.stat(dest)).size;
    // Without an expected hash, don't re-hash multi-GB files on every re-run.
    if (!expected) return { path: dest, bytes, sha256: null };
    const actual = await sha256File(dest);
    if (actual === expected) return { path: dest, bytes, sha256: actual };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastErr;
  const host = new URL(url).host;
  for (const u of [url, ...mirrors]) {
    // Headers may carry a provider token: never send them to a mirror on another host.
    const h = new URL(u).host === host ? headers : {};
    try {
      await tryUrl({ url: u, part, headers: h, onProgress, signal }, retryDelayMs);
      lastErr = null;
      break;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;

  const actual = await sha256File(part);
  if (expected && actual !== expected) {
    await fsp.rm(part, { force: true });
    throw new ChecksumError(`sha256 mismatch for ${path.basename(dest)}`, { expected, actual });
  }
  await fsp.rename(part, dest);
  return { path: dest, bytes: (await fsp.stat(dest)).size, sha256: actual };
}

module.exports = { downloadFile, sha256File, ChecksumError };
