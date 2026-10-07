/**
 * imageMeta.js — read the pixel dimensions of an image buffer.
 *
 * The workflow needs the original width/height to decide whether to downscale
 * before sampling and to restore the size afterwards. The browser *could* send
 * them, but parsing them here keeps the API self-contained. Dependency-free:
 * supports PNG, JPEG, GIF and WebP headers, which is all the UI accepts.
 */
'use strict';

/** PNG: IHDR width/height are big-endian at byte offsets 16 and 20. */
function pngSize(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF: logical screen width/height are little-endian at offsets 6 and 8. */
function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** JPEG: walk the marker segments until a Start-Of-Frame (SOF) marker. */
function jpegSize(buf) {
  let off = 2; // skip the SOI marker (FFD8)
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    let marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; } // fill byte
    off += 2;
    // Markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    const len = buf.readUInt16BE(off);
    // SOF0..SOF15, excluding DHT (C4), JPG (C8) and DAC (CC).
    const isSOF = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(off + 3), width: buf.readUInt16BE(off + 5) };
    }
    off += len;
  }
  return null;
}

/** WebP: VP8 (lossy), VP8L (lossless) and VP8X (extended) variants. */
function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  if (chunk === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

/**
 * @param {Buffer} buf
 * @returns {{width:number, height:number}|null}
 */
function getImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  try {
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return pngSize(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
    if (buf.toString('ascii', 0, 3) === 'GIF') return gifSize(buf);
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      return webpSize(buf);
    }
  } catch (_) {
    /* fall through to null */
  }
  return null;
}

module.exports = { getImageSize };
