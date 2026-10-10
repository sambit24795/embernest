'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createThinkSplitter } = require('../src/server/chat/think');

/** Run a splitter over chunks and collect thinking and answer text. */
function run(chunks, opts = {}) {
  const s = createThinkSplitter(opts);
  const out = { thinking: '', delta: '', fallback: false };
  const take = (evts) => {
    for (const e of evts) {
      if (e.thinking !== undefined) out.thinking += e.thinking;
      else { out.delta += e.delta; if (e.fallback) out.fallback = true; }
    }
  };
  for (const c of chunks) take(s.feed(c));
  take(s.flush());
  return out;
}

/** Every way to cut text into two chunks, plus one character per chunk. Each case is a chunk list. */
const everySplit = (text) => {
  const cases = [];
  for (let i = 0; i <= text.length; i++) cases.push([text.slice(0, i), text.slice(i)]);
  cases.push([...text]);
  return cases;
};

test('implicit open: everything before </think> is reasoning, the rest is the answer', () => {
  const r = run(['Is 1001 prime?', ' Check 7: 1001 = 7*143.</think>', '\n\nNo, 1001 = 7 × 11 × 13.'], { implicitOpen: true });
  assert.equal(r.thinking, 'Is 1001 prime? Check 7: 1001 = 7*143.');
  assert.equal(r.delta, 'No, 1001 = 7 × 11 × 13.');
});

test('a full <think>...</think> pair in the content is split the same way', () => {
  const r = run(['<think>Two steps</think>Answer.']);
  assert.equal(r.thinking, 'Two steps');
  assert.equal(r.delta, 'Answer.');
});

test('the tags are found when split across any chunk boundary', () => {
  const text = '<think>plan it</think>Done.';
  for (const chunks of everySplit(text)) {
    const r = run(chunks);
    assert.equal(r.thinking, 'plan it', `split ${JSON.stringify(chunks)}`);
    assert.equal(r.delta, 'Done.', `split ${JSON.stringify(chunks)}`);
  }
});

test('the closing tag split across chunks in implicit-open mode', () => {
  const text = 'reasoning here</think>answer';
  for (const chunks of everySplit(text)) {
    const r = run(chunks, { implicitOpen: true });
    assert.equal(r.thinking, 'reasoning here', `split ${JSON.stringify(chunks)}`);
    assert.equal(r.delta, 'answer', `split ${JSON.stringify(chunks)}`);
  }
});

test('text that only looks like the start of a tag is answer text', () => {
  const r = run(['<', 'b>bold</b> and <tag>']);
  assert.equal(r.thinking, '');
  assert.equal(r.delta, '<b>bold</b> and <tag>');
  const held = run(['<thi']);
  assert.equal(held.delta, '<thi');
});

test('plain content with no tags is all answer', () => {
  const r = run(['Hello ', 'there']);
  assert.equal(r.thinking, '');
  assert.equal(r.delta, 'Hello there');
});

test('reasoning in its own field is never split, and content after it is answer', () => {
  const s = createThinkSplitter({ implicitOpen: true });
  const evts = [...s.reasoning('step </think> one'), ...s.feed('Answer'), ...s.flush()];
  assert.deepEqual(evts, [{ thinking: 'step </think> one' }, { delta: 'Answer' }]);
});

test('a reply that never closes its reasoning falls back to the reasoning as the answer', () => {
  const r = run(['only thinking, no close'], { implicitOpen: true });
  assert.equal(r.thinking, 'only thinking, no close');
  assert.equal(r.delta, 'only thinking, no close');
  assert.equal(r.fallback, true);
});

test('empty and whitespace-only streams give no answer text', () => {
  assert.deepEqual(run(['   ', '\n']), { thinking: '', delta: '', fallback: false });
});
