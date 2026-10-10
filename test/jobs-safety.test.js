'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');

/**
 * jobs-safety.test.js — tests for the DISABLE_SAFETY environment variable.
 *
 * This test verifies that when EMBERNEST_NO_SAFETY=1 is set, the safety check
 * is skipped for edit and transform jobs (but not generate).
 */

// Mock ComfyClient that simulates image viewing
class MockComfyClient {
  constructor() {
    this.viewedImage = null;
  }
  async viewImage(img) {
    return { buffer: this.viewedImage };
  }
  async deleteHistoryItems(items) {}
  async waitForCompletion(id, opts) {
    return [{ filename: 'result.png', subfolder: '', type: 'output' }];
  }
  collectImages(history) {
    if (!this.viewedImage) throw new Error('No image set');
    return [{ filename: 'result.png', subfolder: '', type: 'output', buffer: this.viewedImage }];
  }
}

/**
 * Simulate checkOutputs with a mock client and safety checker.
 */
async function simulateCheckOutputs(client, safety, images, disableSafety = false) {
  // Temporarily set the DISABLE_SAFETY flag
  const originalValue = process.env.EMBERNEST_NO_SAFETY;
  process.env.EMBERNEST_NO_SAFETY = disableSafety ? '1' : '';

  // Load the module (it reads the env var at require time)
  delete require.cache[require.resolve('../src/server/jobs')];
  const { checkOutputs } = require('../src/server/jobs');

  try {
    return await checkOutputs(client, safety, images);
  } finally {
    process.env.EMBERNEST_NO_SAFETY = originalValue;
  }
}

test('checkOutputs skips safety when EMBERNEST_NO_SAFETY=1', async (t) => {
  const client = new MockComfyClient();
  const safety = {
    check: () => Promise.resolve({ nsfwScore: 0.95, blocked: true }),
  };

  // Set the flag before calling checkOutputs
  process.env.EMBERNEST_NO_SAFETY = '1';
  delete require.cache[require.resolve('../src/server/jobs')];
  const { checkOutputs } = require('../src/server/jobs');

  const result = await checkOutputs(client, safety, [
    { filename: 'result.png', subfolder: '', type: 'output' },
  ]);

  assert.equal(result, 'ok', 'should return ok when safety is disabled');
});

test('checkOutputs runs safety normally when flag is not set', async (t) => {
  const client = new MockComfyClient();
  const safety = {
    check: () => Promise.resolve({ nsfwScore: 0.95, blocked: true }),
  };

  // Ensure the flag is NOT set
  delete process.env.EMBERNEST_NO_SAFETY;
  delete require.cache[require.resolve('../src/server/jobs')];
  const { checkOutputs } = require('../src/server/jobs');

  const result = await checkOutputs(client, safety, [
    { filename: 'result.png', subfolder: '', type: 'output' },
  ]);

  assert.equal(result, 'blocked', 'should return blocked when image is NSFW and safety is enabled');
});

test('checkOutputs returns ok for safe images when safety is enabled', async (t) => {
  const client = new MockComfyClient();
  const safety = {
    check: () => Promise.resolve({ nsfwScore: 0.1, blocked: false }),
  };

  // Ensure the flag is NOT set
  delete process.env.EMBERNEST_NO_SAFETY;
  delete require.cache[require.resolve('../src/server/jobs')];
  const { checkOutputs } = require('../src/server/jobs');

  const result = await checkOutputs(client, safety, [
    { filename: 'result.png', subfolder: '', type: 'output' },
  ]);

  assert.equal(result, 'ok', 'should return ok when image is safe and safety is enabled');
});

test('checkOutputs returns unavailable when no safety checker is provided', async (t) => {
  const client = new MockComfyClient();

  // Ensure the flag is NOT set
  delete process.env.EMBERNEST_NO_SAFETY;
  delete require.cache[require.resolve('../src/server/jobs')];
  const { checkOutputs } = require('../src/server/jobs');

  const result = await checkOutputs(client, null, [
    { filename: 'result.png', subfolder: '', type: 'output' },
  ]);

  assert.equal(result, 'unavailable', 'should return unavailable when no safety checker is provided');
});

test('checkOutputs handles multiple images correctly', async (t) => {
  const client = new MockComfyClient();
  let callCount = 0;
  const safety = {
    check: () => {
      callCount++;
      return Promise.resolve({ nsfwScore: 0.95, blocked: true });
    },
  };

  // Ensure the flag is NOT set
  delete process.env.EMBERNEST_NO_SAFETY;
  delete require.cache[require.resolve('../src/server/jobs')];
  const { checkOutputs } = require('../src/server/jobs');

  const result = await checkOutputs(client, safety, [
    { filename: 'result1.png', subfolder: '', type: 'output' },
    { filename: 'result2.png', subfolder: '', type: 'output' },
  ]);

  assert.equal(result, 'blocked', 'should block on first NSFW image');
  assert.equal(callCount, 1, 'should only check until first blocked image');
});
