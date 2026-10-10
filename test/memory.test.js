'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getPaths } = require('../src/core/paths');
const { saveConfig } = require('../src/core/config');
const { createApp } = require('../src/server/app');
const { createStore } = require('../src/server/chat/store');
const {
  createMemoryStore, createExtractor, rankMemories, parseExtraction, MAX_MEMORIES,
} = require('../src/server/chat/memory');
const { startFakeLlm } = require('./helpers/fake-llm');

const PID = 'persona-aaaa-0001';
const TOKEN = 'memory-token-0123456789';
const HARDWARE = {
  os: 'linux', distro: 'Test', arch: 'x64', cpu: { model: 'T', cores: 4 }, ramGB: 16, freeDiskGB: 100,
  gpu: { vendor: 'nvidia', name: 'Fake', vramGB: 6, driver: '', cudaVersion: '12.8', computeCap: '7.5' }, source: [],
};
const SAFETY = { check: async () => ({ nsfwScore: 0, blocked: false }), close() {} };

const tmpPaths = (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-memory-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return getPaths(home);
};

/** Conversation store + memory store + extractor on a fake `complete`. */
function rig(t, { complete, ...opts } = {}) {
  const paths = tmpPaths(t);
  const store = createStore(paths);
  const memory = createMemoryStore(paths);
  const calls = [];
  const fakeComplete = complete || (async () => '{"add":["User has a dog called Bruno"],"update":[],"remove":[]}');
  const extractor = createExtractor({
    store, memory, getConfig: () => ({ chat: { enabled: true, url: 'http://x' } }), quietMs: 0,
    complete: async (o) => { calls.push(o); return fakeComplete(o); }, ...opts,
  });
  t.after(() => extractor.close());
  const conv = (extra = {}) => {
    const c = store.create({ personaId: PID });
    if (extra.incognito) store.update(c.id, { incognito: true });
    return c;
  };
  /** One finished round: user message, reply, then the route's end-of-reply hook. */
  const round = (c, text = 'I have a dog') => {
    extractor.messageStarted(c.id);
    store.append(c.id, { role: 'user', content: text });
    store.append(c.id, { role: 'assistant', content: 'ok' });
    extractor.replyEnded(c.id);
  };
  return { paths, store, memory, extractor, calls, conv, round };
}

test('parseExtraction: valid, fenced, invalid, and secrets dropped', () => {
  assert.deepEqual(parseExtraction('{"add":["a b"],"update":[{"id":"x","text":"new"}],"remove":["y"]}'),
    { add: ['a b'], update: [{ id: 'x', text: 'new' }], remove: ['y'] });
  assert.deepEqual(parseExtraction('```json\n{"add":["fenced"]}\n```').add, ['fenced']);
  assert.equal(parseExtraction('not json'), null);
  assert.equal(parseExtraction('{"add": [oops'), null);
  assert.equal(parseExtraction('[1,2]'), null);
  const secret = parseExtraction('{"add":["User password is hunter2","card 4111 1111 1111 1111","likes tea"]}');
  assert.deepEqual(secret.add, ['likes tea']);
  assert.equal(parseExtraction(`{"add":["${'x'.repeat(500)}"]}`).add[0].length, 300);
});

test('rankMemories: pinned first, then keyword overlap, no overlap left out, capped at n', () => {
  const mem = (id, text, extra = {}) => ({ id, text, pinned: false, updatedAt: '2026-01-01', ...extra });
  const items = [
    mem('a', 'User likes hiking in the mountains'),
    mem('b', 'User has a dog called Bruno'),
    mem('c', 'User lives in Bangalore'),
    mem('p', 'User is vegetarian', { pinned: true }),
  ];
  const ranked = rankMemories(items, 'What is my dog called? Is Bruno my dog?');
  assert.deepEqual(ranked.map((m) => m.id), ['p', 'b']);
  assert.deepEqual(rankMemories(items, 'hiking mountains dog', 2).map((m) => m.id), ['p', 'a']);
  assert.deepEqual(rankMemories(items, 'the and of', 8).map((m) => m.id), ['p']);
  assert.deepEqual(rankMemories(items, 'hiking', 0), []);
});

test('memory store: add, update, remove, clear, modes, id checks', (t) => {
  const { paths, memory } = rig(t);
  const m = memory.add(PID, '  User likes tea  ', { pinned: true });
  assert.equal(m.text, 'User likes tea');
  assert.equal(memory.add(PID, '   '), null);
  assert.equal(memory.add('../evil', 'x'), null);
  assert.equal(memory.list('../evil').length, 0);
  assert.equal(memory.update(PID, m.id, { text: 'User likes coffee', pinned: false }).text, 'User likes coffee');
  assert.equal(memory.update(PID, m.id, { text: '' }), null);
  assert.equal(memory.update(PID, '../x', { text: 'a' }), null);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(paths.chatMemory, `${PID}.json`)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.chatMemory).mode & 0o777, 0o700);
  }
  assert.equal(memory.remove(PID, m.id), true);
  assert.equal(memory.remove(PID, m.id), false);
  memory.add(PID, 'one');
  assert.equal(memory.clear(PID), true);
  assert.deepEqual(memory.list(PID), []);
});

test('applyDiff: add, update, remove, duplicate skipped, pinned survives remove', (t) => {
  const { memory } = rig(t);
  const a = memory.add(PID, 'User likes tea');
  const b = memory.add(PID, 'User lives in Pune', { pinned: true });
  const r = memory.applyDiff(PID, {
    add: ['USER LIKES GREEN TEA', 'User has a cat'], update: [{ id: a.id, text: 'User likes green tea' }, { id: 'nope', text: 'z' }], remove: [b.id, 'ghost'],
  });
  assert.deepEqual(r, { added: 1, updated: 1, removed: 0 });
  assert.deepEqual(memory.list(PID).map((m) => m.text), ['User likes green tea', 'User lives in Pune', 'User has a cat']);
});

test('cap: over the limit drops the oldest unpinned, keeps pinned', (t) => {
  const { memory } = rig(t);
  const pinned = memory.add(PID, 'pinned oldest', { pinned: true });
  const add = [];
  for (let i = 0; i < MAX_MEMORIES; i++) add.push(`fact number ${i}`);
  // applyDiff takes 10 adds per round, so fill in batches.
  for (let i = 0; i < add.length; i += 10) memory.applyDiff(PID, { add: add.slice(i, i + 10), update: [], remove: [] });
  const items = memory.list(PID);
  assert.equal(items.length, MAX_MEMORIES);
  assert.ok(items.some((m) => m.id === pinned.id));
  assert.ok(!items.some((m) => m.text === 'fact number 0'));
  assert.ok(items.some((m) => m.text === `fact number ${MAX_MEMORIES - 1}`));
});

test('extractor: runs after 4 new user messages, passes existing memories, not before', async (t) => {
  const { extractor, memory, calls, conv, round } = rig(t);
  memory.add(PID, 'User likes tea');
  const c = conv();
  for (let i = 0; i < 3; i++) round(c, `message ${i}`);
  await extractor.settled();
  assert.equal(calls.length, 0);
  round(c, 'I have a dog called Bruno');
  await extractor.settled();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.response_format.type, 'json_object');
  assert.match(calls[0].messages[1].content, /User likes tea/);
  assert.match(calls[0].messages[1].content, /Bruno/);
  assert.ok(memory.list(PID).some((m) => m.text === 'User has a dog called Bruno' && m.conversationId === c.id));
  // The counter restarts: three more messages do nothing.
  for (let i = 0; i < 3; i++) round(c, `more ${i}`);
  await extractor.settled();
  assert.equal(calls.length, 1);
});

test('extractor: idle timer fires once, is cleared by a new message, and is unref-ed', async (t) => {
  const timers = [];
  const fake = {
    set: (fn, ms) => { const h = { fn, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; } }; timers.push(h); return h; },
    clear: (h) => { h.cleared = true; },
  };
  const { extractor, calls, conv, round } = rig(t, { timers: fake });
  const c = conv();
  round(c);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10 * 60 * 1000);
  assert.ok(timers[0].unrefed);
  round(c, 'second');
  assert.ok(timers[0].cleared);
  assert.equal(timers.length, 2);
  timers[1].fn();
  await extractor.settled();
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /second/);
});

function fakeTimers() {
  const timers = [];
  return {
    timers,
    set: (fn, ms) => { const h = { fn, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; } }; timers.push(h); return h; },
    clear: (h) => { h.cleared = true; },
    /** Fire the oldest pending timer, like the clock reaching it. */
    fire() { const h = timers.find((x) => !x.cleared); h.cleared = true; h.fn(); },
  };
}

test('extractor: 4 new messages wait for 45 s of quiet; a new message restarts the wait', async (t) => {
  const fake = fakeTimers();
  const { extractor, calls, conv, round } = rig(t, { timers: fake, quietMs: 45000 });
  const c = conv();
  for (let i = 0; i < 4; i++) round(c, `message ${i}`);
  await extractor.settled();
  assert.equal(calls.length, 0, 'nothing starts right after the reply');
  const live = fake.timers.filter((h) => !h.cleared);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 45000);
  assert.ok(live[0].unrefed);
  round(c, 'one more');
  assert.equal(fake.timers.filter((h) => !h.cleared).length, 1);
  assert.equal(fake.timers.filter((h) => !h.cleared)[0].ms, 45000);
  fake.fire();
  await extractor.settled();
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /one more/);
});

test('extractor: fewer than 4 messages use the 10-minute idle rule, not the quiet rule', async (t) => {
  const fake = fakeTimers();
  const { extractor, calls, conv, round } = rig(t, { timers: fake, quietMs: 45000 });
  const c = conv();
  for (let i = 0; i < 3; i++) round(c, `message ${i}`);
  const live = fake.timers.filter((h) => !h.cleared);
  assert.deepEqual(live.map((h) => h.ms), [10 * 60 * 1000]);
  await extractor.settled();
  assert.equal(calls.length, 0);
});

test('extractor: a due extraction waits while another conversation is mid-reply', async (t) => {
  const fake = fakeTimers();
  const { extractor, calls, conv, round } = rig(t, { timers: fake, quietMs: 45000, every: 1 });
  const a = conv();
  const b = conv();
  round(a);
  extractor.messageStarted(b.id); // b is replying
  fake.fire();
  await extractor.settled();
  assert.equal(calls.length, 0);
  const again = fake.timers.filter((h) => !h.cleared);
  assert.equal(again.length, 1, 'rearmed for the next quiet time');
  extractor.replyEnded(b.id);
  fake.fire();
  await extractor.settled();
  assert.equal(calls.length, 1);
});

test('extractor: a message on any conversation aborts the running extraction and it is rearmed', async (t) => {
  const fake = fakeTimers();
  let started;
  const sawStart = new Promise((r) => { started = r; });
  let aborted = false;
  const { extractor, calls, conv, round } = rig(t, {
    timers: fake, quietMs: 45000, every: 1,
    complete: (o) => new Promise((resolve, reject) => {
      started();
      o.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });
  const a = conv();
  const b = conv();
  round(a);
  fake.fire();
  await sawStart;
  extractor.messageStarted(b.id);
  await extractor.settled();
  assert.ok(aborted);
  assert.equal(calls.length, 1);
  assert.equal(fake.timers.filter((h) => !h.cleared).length, 1, 'retried in the next quiet time');
  extractor.replyEnded(b.id);
});

test('extractor: close() clears idle timers', async (t) => {
  const timers = [];
  const fake = { set: () => { const h = { cleared: false, unref() {} }; timers.push(h); return h; }, clear: (h) => { h.cleared = true; } };
  const { extractor, conv, round } = rig(t, { timers: fake });
  round(conv());
  extractor.close();
  assert.ok(timers[0].cleared);
});

test('extractor: incognito and persona-less conversations are never extracted', async (t) => {
  const timers = [];
  const fake = { set: () => { timers.push(1); return { unref() {} }; }, clear() {} };
  const { extractor, store, calls, conv, round } = rig(t, { timers: fake });
  const inc = conv({ incognito: true });
  for (let i = 0; i < 5; i++) round(inc, `secret ${i}`);
  const bare = store.create({});
  for (let i = 0; i < 5; i++) round(bare, `no persona ${i}`);
  await extractor.settled();
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 0);
});

test('extractor: bad JSON is ignored and logged, failures do not throw', async (t) => {
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const { extractor, memory, conv, round } = rig(t, { complete: async () => 'sorry, no json', logger, every: 1 });
  round(conv());
  await extractor.settled();
  assert.deepEqual(memory.list(PID), []);
  assert.ok(logs.some((l) => /unusable JSON/.test(l)));
  const failing = rig(t, { complete: async () => { throw new Error('boom'); }, logger, every: 1 });
  failing.round(failing.conv());
  await failing.extractor.settled();
  assert.ok(logs.some((l) => /extraction failed: boom/.test(l)));
});

test('extractor: update and remove from the model are applied', async (t) => {
  let ids;
  const { extractor, memory, conv, round } = rig(t, {
    every: 1,
    complete: async () => JSON.stringify({ add: [], update: [{ id: ids[0], text: 'User lives in Delhi' }], remove: [ids[1]] }),
  });
  ids = [memory.add(PID, 'User lives in Pune').id, memory.add(PID, 'User has a cat').id];
  round(conv());
  await extractor.settled();
  assert.deepEqual(memory.list(PID).map((m) => m.text), ['User lives in Delhi']);
});

test('extractor: one at a time per persona, and not while a reply is active', async (t) => {
  let live = 0;
  let peak = 0;
  const { extractor, store, calls, conv, round } = rig(t, {
    every: 1,
    complete: async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live--;
      return '{"add":[]}';
    },
  });
  const a = conv();
  const b = conv();
  round(a);
  round(b);
  await extractor.settled();
  assert.equal(calls.length, 2);
  assert.equal(peak, 1);
  // A reply in progress on the same conversation blocks extraction until it ends.
  extractor.messageStarted(a.id);
  store.append(a.id, { role: 'user', content: 'again' });
  await extractor.settled();
  assert.equal(calls.length, 2);
  extractor.replyEnded(a.id);
  await extractor.settled();
  assert.equal(calls.length, 3);
});

test('extractor: a new message aborts a running extraction, which is retried later', async (t) => {
  let started;
  const sawStart = new Promise((r) => { started = r; });
  let first = true;
  const { extractor, store, calls, conv, round } = rig(t, {
    every: 1,
    complete: (o) => new Promise((resolve, reject) => {
      if (first) {
        first = false;
        started();
        o.signal.addEventListener('abort', () => reject(new Error('aborted')));
      } else resolve('{"add":["User likes jazz"]}');
    }),
  });
  const c = conv();
  round(c);
  await sawStart;
  extractor.messageStarted(c.id);
  store.append(c.id, { role: 'user', content: 'jazz' });
  await extractor.settled();
  extractor.replyEnded(c.id);
  await extractor.settled();
  assert.equal(calls.length, 2);
});

// ---- routes ----

async function apiSetup(t, completion) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-memory-api-'));
  const fake = await startFakeLlm({ completion });
  const paths = getPaths(home);
  saveConfig(paths, { authToken: TOKEN, chat: { enabled: true, model: 'm', url: fake.url } });
  const app = createApp({ paths, hardware: HARDWARE, trustLoopback: true, safety: SAFETY, memoryTiming: { quietMs: 0 } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    app.locals.chatMemory.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, fake, app, paths };
}
const json = (body, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function firstPersona(base) {
  return (await (await fetch(`${base}/api/chat/personas`)).json()).personas[0];
}

test('routes: list, add, patch, delete one, forget everything, validation', async (t) => {
  const { base } = await apiSetup(t);
  const p = await firstPersona(base);
  const url = `${base}/api/chat/memory/${p.id}`;
  assert.deepEqual(await (await fetch(url)).json(), { memories: [] });
  const created = await fetch(url, json({ text: 'User likes tea', pinned: true }));
  assert.equal(created.status, 201);
  const { memory } = await created.json();
  assert.equal(memory.pinned, true);
  assert.equal((await fetch(url, json({ text: '  ' }))).status, 400);
  const patched = await (await fetch(`${url}/${memory.id}`, json({ text: 'User likes coffee', pinned: false }, 'PATCH'))).json();
  assert.equal(patched.memory.text, 'User likes coffee');
  assert.equal(patched.memory.pinned, false);
  assert.equal((await fetch(`${url}/${memory.id}`, json({ text: '' }, 'PATCH'))).status, 404);
  assert.equal((await fetch(`${url}/not-there-123`, json({ text: 'a' }, 'PATCH'))).status, 404);
  assert.equal((await fetch(`${url}/${memory.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${url}/${memory.id}`, { method: 'DELETE' })).status, 404);
  await fetch(url, json({ text: 'one' }));
  await fetch(url, json({ text: 'two' }));
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await fetch(url)).json(), { memories: [] });
  assert.equal((await fetch(`${base}/api/chat/memory/..%2Fx`)).status, 404);
  assert.equal((await fetch(`${base}/api/chat/memory/unknown-persona-1`)).status, 404);
});

test('routes: 4 messages trigger extraction after the reply; recall reaches the next prompt; incognito is skipped', async (t) => {
  const { base, fake, app, paths } = await apiSetup(t, '{"add":["User has a dog called Bruno"],"update":[],"remove":[]}');
  const p = await firstPersona(base);
  const send = async (convId, content) => {
    const res = await fetch(`${base}/api/chat/conversations/${convId}/messages`, json({ content }));
    assert.equal(res.status, 200);
    await res.text();
  };
  const conv = (await (await fetch(`${base}/api/chat/conversations`, json({ personaId: p.id }))).json()).conversation;
  for (const m of ['My name is Sam', 'I have a dog called Bruno', 'I live in Bangalore', 'I like hiking']) await send(conv.id, m);
  await app.locals.chatMemory.settled();
  const stored = (await (await fetch(`${base}/api/chat/memory/${p.id}`)).json()).memories;
  assert.deepEqual(stored.map((m) => m.text), ['User has a dog called Bruno']);
  assert.equal(fake.requests.filter((r) => r.response_format).length, 1);

  const next = (await (await fetch(`${base}/api/chat/conversations`, json({ personaId: p.id }))).json()).conversation;
  await send(next.id, "What's my dog's name?");
  const chatReq = fake.requests.filter((r) => !r.response_format).pop();
  // Memories ride with the latest user message, never in the system prompt.
  assert.ok(!/Bruno|<context>/.test(chatReq.messages[0].content));
  assert.ok(chatReq.messages[0].content.startsWith('You are '));
  const lastUser = chatReq.messages[chatReq.messages.length - 1];
  assert.match(lastUser.content, /^<context>\n.*\n- User has a dog called Bruno\n<\/context>\n\nWhat's my dog's name\?$/s);
  // The stored message keeps only what the user typed.
  const savedNext = (await (await fetch(`${base}/api/chat/conversations/${next.id}`)).json()).conversation;
  assert.equal(savedNext.messages.find((m) => m.role === 'user').content, "What's my dog's name?");
  // Extraction names the model too.
  assert.equal(fake.requests.find((r) => r.response_format).model, 'm');

  const inc = (await (await fetch(`${base}/api/chat/conversations`, json({ personaId: p.id }))).json()).conversation;
  await fetch(`${base}/api/chat/conversations/${inc.id}`, json({ incognito: true }, 'PATCH'));
  const before = fake.requests.length;
  for (const m of ['one', 'two', 'three', 'four', 'five']) await send(inc.id, m);
  await app.locals.chatMemory.settled();
  assert.equal(fake.requests.slice(before).filter((r) => r.response_format).length, 0);
  assert.ok(!fake.requests.slice(before).some((r) => /<context>/.test(r.messages.map((m) => m.content).join('\n'))));
  assert.equal(fs.existsSync(path.join(paths.chatMemory, `${p.id}.json`)), true);
});

test('routes: deleting a persona deletes its memories', async (t) => {
  const { base, paths } = await apiSetup(t);
  const p = await firstPersona(base);
  await fetch(`${base}/api/chat/memory/${p.id}`, json({ text: 'x fact' }));
  assert.equal(fs.existsSync(path.join(paths.chatMemory, `${p.id}.json`)), true);
  await fetch(`${base}/api/chat/personas/${p.id}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(path.join(paths.chatMemory, `${p.id}.json`)), false);
});
