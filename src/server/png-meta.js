'use strict';

/**
 * png-meta.js — read the text chunks of a PNG without loading the image.
 * ComfyUI stores the API-format workflow in a `prompt` tEXt chunk (and the UI
 * graph in `workflow`) before the pixel data, so only the header is read.
 */
const fsp = require('fs/promises');
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHUNK = 2 * 1024 * 1024; // larger text chunks are skipped
const MAX_SCAN = 8 * 1024 * 1024; // never walk further than this into a file

/** Decode the payload of a tEXt / zTXt / iTXt chunk to [keyword, text], or null. */
function decodeTextChunk(type, data) {
  try {
    const nul = data.indexOf(0);
    if (nul < 1) return null;
    const keyword = data.toString('latin1', 0, nul);
    if (type === 'tEXt') return [keyword, data.toString('latin1', nul + 1)];
    if (type === 'zTXt') return [keyword, zlib.inflateSync(data.subarray(nul + 2)).toString('latin1')];
    // iTXt: flag, method, language\0, translated keyword\0, text (UTF-8)
    const flag = data[nul + 1];
    let p = data.indexOf(0, nul + 3);
    if (p < 0) return null;
    p = data.indexOf(0, p + 1);
    if (p < 0) return null;
    const raw = data.subarray(p + 1);
    return [keyword, (flag ? zlib.inflateSync(raw) : raw).toString('utf8')];
  } catch {
    return null;
  }
}

/**
 * Text chunks found before the first IDAT of a PNG file.
 * @param {string} file
 * @returns {Promise<Record<string, string>>} keyword -> text ({} when not a PNG)
 */
async function readPngText(file) {
  const out = {};
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const sig = Buffer.alloc(8);
    const { bytesRead } = await fh.read(sig, 0, 8, 0);
    if (bytesRead < 8 || !sig.equals(SIGNATURE)) return out;
    let pos = 8;
    const head = Buffer.alloc(8);
    while (pos < MAX_SCAN) {
      const r = await fh.read(head, 0, 8, pos);
      if (r.bytesRead < 8) break;
      const len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (type === 'IDAT' || type === 'IEND') break;
      if (['tEXt', 'zTXt', 'iTXt'].includes(type) && len <= MAX_CHUNK) {
        const data = Buffer.alloc(len);
        const got = await fh.read(data, 0, len, pos + 8);
        if (got.bytesRead < len) break;
        const kv = decodeTextChunk(type, data);
        if (kv && !(kv[0] in out)) out[kv[0]] = kv[1];
      }
      pos += 12 + len; // length + type + data + crc
    }
  } catch {
    /* unreadable file: no metadata */
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  return out;
}

/**
 * The ComfyUI API-format graph embedded in a PNG, or null.
 * @param {string} file
 * @returns {Promise<object|null>}
 */
async function readEmbeddedGraph(file) {
  const text = await readPngText(file);
  if (typeof text.prompt !== 'string') return null;
  try {
    const graph = JSON.parse(text.prompt);
    return graph && typeof graph === 'object' && !Array.isArray(graph) ? graph : null;
  } catch {
    return null;
  }
}

module.exports = { readPngText, readEmbeddedGraph };
