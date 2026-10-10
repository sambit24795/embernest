'use strict';

/** Parse a multipart/form-data value that should be a boolean. */
function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

/** Parse a numeric field, falling back when absent/invalid. */
function toNum(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Negative prompt used when the client sends none. */
const DEFAULT_NEGATIVE = 'blurry, low quality, worst quality, deformed body, extra limbs, bad anatomy, disfigured, watermark, text, logo';

module.exports = { toBool, toNum, DEFAULT_NEGATIVE };
