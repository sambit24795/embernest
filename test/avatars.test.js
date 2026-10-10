'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getPaths } = require('../src/core/paths');
const { MAX_AVATAR_BYTES, detectImageType, avatarPath, saveAvatar, readAvatar } = require('../src/server/chat/avatars');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64)]);

function tempPaths(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-avatars-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return getPaths(home);
}

test('detectImageType reads magic bytes, not names', () => {
  assert.equal(detectImageType(PNG), 'png');
  assert.equal(detectImageType(JPEG), 'jpg');
  assert.equal(detectImageType(WEBP), 'webp');
  assert.equal(detectImageType(Buffer.from('GIF89a' + 'x'.repeat(20))), null);
  assert.equal(detectImageType(Buffer.from('<script>alert(1)</script>')), null);
  assert.equal(detectImageType(Buffer.from('RIFF0000WAVE')), null);
  assert.equal(detectImageType(Buffer.alloc(4)), null);
});

test('saveAvatar stores a random name with the detected extension', (t) => {
  const paths = tempPaths(t);
  const name = saveAvatar(paths, PNG);
  assert.match(name, /^[0-9a-f-]{36}\.png$/);
  assert.equal(saveAvatar(paths, JPEG).endsWith('.jpg'), true);
  assert.equal(saveAvatar(paths, WEBP).endsWith('.webp'), true);
  assert.equal(saveAvatar(paths, Buffer.from('not an image at all, just text')), null);
  assert.equal(saveAvatar(paths, Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)])), null);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(paths.chatAvatars, name)).mode & 0o777, 0o600);
  }
});

test('avatar paths are guarded: only generated names inside the avatars folder', (t) => {
  const paths = tempPaths(t);
  for (const bad of ['../config.json', '..%2Fconfig.json', 'a/b.png', 'short.png', 'UPPERCASE-NAME.png', 'x.gif', '']) {
    assert.equal(avatarPath(paths, bad), null, bad);
    assert.equal(readAvatar(paths, bad), null, bad);
  }
  assert.equal(readAvatar(paths, '0123456789abcdef.png'), null);
});

test('readAvatar refuses a stored file whose bytes no longer match its type', (t) => {
  const paths = tempPaths(t);
  const name = saveAvatar(paths, PNG);
  fs.writeFileSync(avatarPath(paths, name), Buffer.from('<html>not a png</html>'));
  assert.equal(readAvatar(paths, name), null);
});
