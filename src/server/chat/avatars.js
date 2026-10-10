'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[a-z0-9-]{8,64}\.(png|jpg|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Image type from the file's first bytes (never from the file name).
 * @param {Buffer} buf
 * @returns {'png'|'jpg'|'webp'|null}
 */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Full path of a stored avatar, or null for anything that is not a generated name
 * inside `paths.chatAvatars` (path guard).
 * @param {Record<string, string>} paths
 * @param {string} name
 * @returns {string|null}
 */
function avatarPath(paths, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const dir = path.resolve(paths.chatAvatars);
  const full = path.resolve(dir, name);
  return full.startsWith(dir + path.sep) ? full : null;
}

/**
 * Store an uploaded image under a random name. Only PNG, JPEG and WebP by magic bytes.
 * @param {Record<string, string>} paths
 * @param {Buffer} buf
 * @returns {string|null} the stored file name, or null when the bytes are not an allowed image
 */
function saveAvatar(paths, buf) {
  const type = detectImageType(buf);
  if (!type || buf.length > MAX_AVATAR_BYTES) return null;
  const name = `${crypto.randomUUID()}.${type}`;
  fs.mkdirSync(paths.chatAvatars, { recursive: true, mode: 0o700 });
  fs.writeFileSync(avatarPath(paths, name), buf, { mode: 0o600 });
  return name;
}

/**
 * Read a stored avatar. The bytes must still match the type in the file name.
 * @param {Record<string, string>} paths
 * @param {string} name
 * @returns {{ buf: Buffer, contentType: string }|null}
 */
function readAvatar(paths, name) {
  const full = avatarPath(paths, name);
  if (!full) return null;
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    return null;
  }
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (detectImageType(buf) !== ext) return null;
  return { buf, contentType: MIME[ext] };
}

/** Delete a stored avatar; ignores names it does not own and missing files. */
function removeAvatar(paths, name) {
  const full = avatarPath(paths, name);
  if (!full) return;
  try { fs.unlinkSync(full); } catch { /* already gone */ }
}

module.exports = { MAX_AVATAR_BYTES, detectImageType, avatarPath, saveAvatar, readAvatar, removeAvatar };
