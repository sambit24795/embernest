'use strict';

const OPEN = '<think>';
const CLOSE = '</think>';

/** Length of the longest suffix of `text` that is a proper prefix of `tag` (a tag may be split across chunks). */
function partialTagLength(text, tag) {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/**
 * Splits a reply into reasoning and answer. Reasoning comes either as its own field
 * (`reasoning()`, llama-server with --reasoning-format deepseek) or inside the content
 * as `<think>…</think>`. A think model's template may already have written the opening
 * tag, so the stream then holds only `</think>`: with `implicitOpen` everything before the
 * first `</think>` is reasoning. Tags may be split across chunks. Whitespace around the
 * tags is dropped. Pure: no I/O.
 *
 * Events: `{ thinking: text }` and `{ delta: text }`. If the stream ends while still inside
 * reasoning (no `</think>` ever came), the reasoning is handed back as the answer through a
 * final `{ delta }`, so a reply is never empty.
 * @param {{ implicitOpen?: boolean }} [o]
 * @returns {{ feed: (text: string) => object[], reasoning: (text: string) => object[], flush: () => object[] }}
 */
function createThinkSplitter({ implicitOpen = false } = {}) {
  let state = implicitOpen ? 'reasoning' : 'start';
  let held = ''; // a tail that may still turn into a tag
  let lead = true; // dropping whitespace at the start of a section
  let thought = ''; // all reasoning text emitted so far (for the unclosed fallback)
  let fieldMode = false; // reasoning arrived in its own field: content is answer text from now on

  function run(text) {
    const out = [];
    const add = (kind, s) => {
      if (!s) return;
      if (kind === 'thinking') thought += s;
      out.push({ [kind]: s });
    };
    let buf = held + text;
    held = '';
    for (;;) {
      if (lead) {
        buf = buf.replace(/^\s+/, '');
        if (!buf) return out;
        lead = false;
      }
      if (state === 'start') {
        if (buf.startsWith(OPEN)) {
          buf = buf.slice(OPEN.length);
          state = 'reasoning';
          lead = true;
          continue;
        }
        if (OPEN.startsWith(buf)) {
          held = buf;
          return out;
        }
        state = 'answer';
        continue;
      }
      if (state === 'reasoning') {
        const i = buf.indexOf(CLOSE);
        if (i >= 0) {
          add('thinking', buf.slice(0, i));
          buf = buf.slice(i + CLOSE.length);
          state = 'answer';
          lead = true;
          continue;
        }
        const keep = partialTagLength(buf, CLOSE);
        add('thinking', buf.slice(0, buf.length - keep));
        held = buf.slice(buf.length - keep);
        return out;
      }
      add('delta', buf);
      return out;
    }
  }

  return {
    /** Text from the content field. */
    feed(text) {
      if (fieldMode) return text ? [{ delta: text }] : [];
      return run(String(text || ''));
    },
    /** Reasoning from its own field: never split, and the content after it is answer text. */
    reasoning(text) {
      fieldMode = true;
      if (!text) return [];
      thought += text;
      return [{ thinking: String(text) }];
    },
    /** End of stream: release any held tail; reasoning that was never closed becomes the answer. */
    flush() {
      if (fieldMode) return [];
      const out = [];
      if (state === 'reasoning') {
        const rest = held;
        held = '';
        if (rest) { thought += rest; out.push({ thinking: rest }); }
        if (thought.trim()) out.push({ delta: thought.trim(), fallback: true });
        return out;
      }
      if (held) {
        const rest = held;
        held = '';
        out.push({ delta: rest });
      }
      return out;
    },
  };
}

module.exports = { createThinkSplitter, OPEN, CLOSE };
