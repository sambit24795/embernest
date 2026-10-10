'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJson } = require('../../core/state');
const { validId } = require('./store');
const { completeChat } = require('./llm-client');

const MAX_MEMORIES = 200;
const MEMORY_MAX_CHARS = 300;
const MAX_ADDS_PER_ROUND = 10;
const EXTRACT_EVERY = 4; // new user messages that trigger an extraction
const IDLE_MS = 10 * 60 * 1000;
const QUIET_MS = 45 * 1000; // quiet time needed before a due extraction starts
const EXTRACT_CONTEXT_MESSAGES = 12;
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

const STOPWORDS = new Set((
  'a an and are as at be but by can could did do does for from had has have he her his how i if in into is it its '
  + 'me my of on or our she so that the their them then there these they this to us was we were what when where '
  + 'which who why will with would you your yours about just not no yes ok okay please tell know'
).split(' '));

/** Lowercased word set without stopwords and one-letter words. Pure. */
function keywords(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (w.length > 1 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * All pinned memories, then the unpinned ones that share the most keywords with `queryText`
 * (ties: newest first). Unpinned memories with no overlap are left out. Pure.
 * @param {{ id: string, text: string, pinned?: boolean, updatedAt?: string }[]} memories
 * @param {string} queryText usually the last 3 user messages
 * @param {number} [n=8] total size of the result
 * @returns {object[]}
 */
function rankMemories(memories, queryText, n = 8) {
  const pinned = memories.filter((m) => m.pinned);
  const query = keywords(queryText);
  const scored = memories
    .filter((m) => !m.pinned)
    .map((m) => {
      let score = 0;
      for (const w of keywords(m.text)) if (query.has(w)) score++;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.m.updatedAt < b.m.updatedAt ? 1 : -1))
    .map((x) => x.m);
  return [...pinned, ...scored].slice(0, Math.max(0, n));
}

/** Clean one memory text, or '' when it is unusable (empty, or looks like a secret). */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  const t = value.replace(/\s+/g, ' ').trim().slice(0, MEMORY_MAX_CHARS);
  if (/pass(word|code)|\b(?:\d[ -]?){13,19}\b|api[ _-]?key|secret key|\bcvv\b/i.test(t)) return '';
  return t;
}

/**
 * Parse the model's extraction answer. Tolerates code fences and text around the object.
 * @param {string} raw
 * @returns {{ add: string[], update: {id: string, text: string}[], remove: string[] }|null} null when unusable
 */
function parseExtraction(raw) {
  if (typeof raw !== 'string') return null;
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try {
    obj = JSON.parse(raw.slice(a, b + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    add: list(obj.add).map(cleanText).filter(Boolean),
    update: list(obj.update)
      .filter((u) => u && typeof u === 'object' && typeof u.id === 'string')
      .map((u) => ({ id: u.id, text: cleanText(u.text) }))
      .filter((u) => u.text),
    remove: list(obj.remove).filter((id) => typeof id === 'string'),
  };
}

/**
 * Memory files under `paths.chatMemory`: one `<personaId>.json` per persona (dir 0700, files 0600).
 * @param {Record<string, string>} paths result of getPaths()
 */
function createMemoryStore(paths) {
  const dir = paths.chatMemory;
  const file = (personaId) => path.join(dir, `${personaId}.json`);

  function save(personaId, items) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const d of [paths.chat, dir]) {
      try { fs.chmodSync(d, 0o700); } catch { /* best effort (Windows) */ }
    }
    writeJson(file(personaId), items, { mode: 0o600 });
    return items;
  }

  /** Oldest unpinned memories go first when over the cap. */
  function enforceCap(items) {
    let over = items.length - MAX_MEMORIES;
    if (over <= 0) return items;
    const drop = new Set();
    const oldest = items.filter((m) => !m.pinned).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    for (const m of oldest) {
      if (over-- <= 0) break;
      drop.add(m.id);
    }
    return items.filter((m) => !drop.has(m.id));
  }

  /** @returns {object[]} memories (oldest first); [] for an invalid id or no file */
  function list(personaId) {
    if (!validId(personaId)) return [];
    const items = readJson(file(personaId), []);
    return Array.isArray(items) ? items : [];
  }

  /**
   * @param {string} personaId
   * @param {string} text
   * @param {{ pinned?: boolean, conversationId?: string|null }} [o]
   * @returns {object|null} the new memory, or null for invalid input
   */
  function add(personaId, text, { pinned = false, conversationId = null } = {}) {
    const clean = cleanText(text);
    if (!validId(personaId) || !clean) return null;
    const now = new Date().toISOString();
    const memory = { id: crypto.randomUUID(), text: clean, pinned: Boolean(pinned), createdAt: now, updatedAt: now, conversationId };
    save(personaId, enforceCap([...list(personaId), memory]));
    return memory;
  }

  /** @returns {object|null} the updated memory, or null when unknown/invalid */
  function update(personaId, memoryId, patch) {
    if (!validId(personaId) || !validId(memoryId)) return null;
    const items = list(personaId);
    const m = items.find((x) => x.id === memoryId);
    if (!m) return null;
    if (patch.text !== undefined) {
      const clean = cleanText(patch.text);
      if (!clean) return null;
      m.text = clean;
    }
    if (typeof patch.pinned === 'boolean') m.pinned = patch.pinned;
    m.updatedAt = new Date().toISOString();
    save(personaId, items);
    return m;
  }

  /** @returns {boolean} whether something was deleted */
  function remove(personaId, memoryId) {
    if (!validId(personaId) || !validId(memoryId)) return false;
    const items = list(personaId);
    const kept = items.filter((x) => x.id !== memoryId);
    if (kept.length === items.length) return false;
    save(personaId, kept);
    return true;
  }

  /** Forget everything for a persona. @returns {boolean} whether a file was deleted */
  function clear(personaId) {
    if (!validId(personaId)) return false;
    try {
      fs.unlinkSync(file(personaId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply one extraction result. Unknown ids are ignored, pinned memories are never removed,
   * and an added text that already exists (ignoring case) is skipped.
   * @returns {{ added: number, updated: number, removed: number }}
   */
  function applyDiff(personaId, diff, conversationId = null) {
    if (!validId(personaId)) return { added: 0, updated: 0, removed: 0 };
    let items = list(personaId);
    const now = new Date().toISOString();
    let updated = 0;
    for (const u of diff.update) {
      const m = items.find((x) => x.id === u.id);
      if (m && m.text !== u.text) { m.text = u.text; m.updatedAt = now; updated++; }
    }
    const before = items.length;
    const gone = new Set(diff.remove);
    items = items.filter((m) => m.pinned || !gone.has(m.id));
    const removed = before - items.length;
    const seen = new Set(items.map((m) => m.text.toLowerCase()));
    let added = 0;
    for (const text of diff.add.slice(0, MAX_ADDS_PER_ROUND)) {
      if (seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      items.push({ id: crypto.randomUUID(), text, pinned: false, createdAt: now, updatedAt: now, conversationId });
      added++;
    }
    if (added || updated || removed) save(personaId, enforceCap(items));
    return { added, updated, removed };
  }

  /**
   * Memories worth putting in the prompt: all pinned + the best keyword matches.
   * @param {string} personaId
   * @param {string} queryText
   * @param {number} [n=8]
   * @returns {object[]}
   */
  function recall(personaId, queryText, n = 8) {
    return rankMemories(list(personaId), queryText, n);
  }

  return { list, add, update, remove, clear, applyDiff, recall };
}

/** The instruction for the extraction round. */
function extractionMessages(existing, recent) {
  const known = existing.length
    ? existing.map((m) => `- id ${m.id}: ${m.text}`).join('\n')
    : '(none yet)';
  const transcript = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const system = 'You maintain a short list of lasting facts about the user, taken from a chat. '
    + 'Keep only durable facts: preferences, people in their life, plans, background. '
    + 'Skip small talk, one-off requests, the assistant\'s own words and anything fictional. '
    + 'Never store secrets such as passwords or card numbers. Write each fact as one short sentence about the user. '
    + 'Answer with JSON only, in this exact shape: {"add": ["fact"], "update": [{"id": "existing id", "text": "new text"}], "remove": ["existing id"]}. '
    + 'Use update when a fact changed and remove when it is no longer true. Use empty lists when nothing applies.';
  const user = `Known facts:\n${known}\n\nRecent chat:\n${transcript}\n\nReturn the JSON now.`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Background memory extraction. It only runs in quiet time: after the conversation has been idle
 * for `quietMs` with enough new user messages, or after `idleMs` with any new ones. One persona at
 * a time, never while a reply is streaming, and a new message aborts a running round.
 * @param {object} o
 * @param {object} o.store conversation store
 * @param {ReturnType<typeof createMemoryStore>} o.memory
 * @param {() => object} o.getConfig
 * @param {{ info: Function, warn: Function }} [o.logger]
 * @param {{ set: Function, clear: Function }} [o.timers] defaults to the global timers (looked up per call)
 * @param {number} [o.idleMs] idle time that triggers extraction whatever the message count
 * @param {number} [o.quietMs] idle time that triggers it once `every` new user messages piled up (0 = right away)
 * @param {number} [o.every]
 * @param {Function} [o.complete] defaults to completeChat
 */
function createExtractor({
  store, memory, getConfig, logger = null, timers = null, idleMs = IDLE_MS, quietMs = QUIET_MS, every = EXTRACT_EVERY, complete = completeChat,
}) {
  const t = timers || { set: (...a) => setTimeout(...a), clear: (id) => clearTimeout(id) };
  const done = new Map(); // conversationId -> user messages already looked at
  const idle = new Map(); // conversationId -> timer
  const active = new Set(); // conversations with a reply in progress
  const running = new Map(); // conversationId -> AbortController of the extraction in flight
  const queues = new Map(); // personaId -> promise chain
  const inflight = new Set();
  let closed = false;

  const log = (level, msg) => { if (logger) { try { logger[level](msg); } catch { /* logging must not break chat */ } } };
  const userCount = (conv) => conv.messages.filter((m) => m.role === 'user').length;
  const eligible = (conv) => conv && conv.personaId && validId(conv.personaId) && !conv.incognito;

  function cancelIdle(id) {
    const timer = idle.get(id);
    if (timer !== undefined) { t.clear(timer); idle.delete(id); }
  }

  async function extract(convId) {
    const conv = store.get(convId);
    if (!eligible(conv) || active.has(convId) || closed) return;
    // Another conversation is mid-reply: llama-server is busy, so wait for the next quiet time.
    if (active.size) { arm(convId, quietMs || QUIET_MS); return; }
    const total = userCount(conv);
    if (total <= (done.get(convId) || 0)) return;
    const cfg = getConfig();
    if (!cfg.chat || !cfg.chat.enabled) return;
    const ac = new AbortController();
    running.set(convId, ac);
    try {
      const recent = conv.messages.slice(-EXTRACT_CONTEXT_MESSAGES);
      const raw = await complete({
        url: cfg.chat.url,
        model: cfg.chat.model,
        messages: extractionMessages(memory.list(conv.personaId), recent),
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(EXTRACT_TIMEOUT_MS)]),
        params: { temperature: 0, max_tokens: 600, response_format: { type: 'json_object' } },
      });
      done.set(convId, total);
      const diff = parseExtraction(raw);
      if (!diff) {
        log('warn', `memory: extraction for conversation ${convId} returned unusable JSON; round ignored`);
        return;
      }
      const result = memory.applyDiff(conv.personaId, diff, convId);
      log('info', `memory: conversation ${convId} +${result.added} ~${result.updated} -${result.removed}`);
    } catch (err) {
      // An aborted round (new message arrived) is retried in the next quiet time.
      if (ac.signal.aborted) {
        if (!active.has(convId)) arm(convId, quietMs || QUIET_MS);
      } else {
        done.set(convId, total);
        log('warn', `memory: extraction failed: ${err.message}`);
      }
    } finally {
      if (running.get(convId) === ac) running.delete(convId);
    }
  }

  /** Run an extraction after `ms` of quiet. The timer never keeps the process alive. */
  function arm(convId, ms) {
    cancelIdle(convId);
    if (closed) return;
    const timer = t.set(() => { idle.delete(convId); enqueue(convId); }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    idle.set(convId, timer);
  }

  /** Queue an extraction behind any other one for the same persona. */
  function enqueue(convId) {
    const conv = store.get(convId);
    if (!eligible(conv) || closed) return null;
    const prev = queues.get(conv.personaId) || Promise.resolve();
    const next = prev.then(() => extract(convId)).catch(() => {});
    queues.set(conv.personaId, next);
    inflight.add(next);
    next.then(() => {
      inflight.delete(next);
      if (queues.get(conv.personaId) === next) queues.delete(conv.personaId);
    });
    return next;
  }

  return {
    /** A user message arrived: stop the idle timer and cancel any extraction on this conversation. */
    messageStarted(convId) {
      active.add(convId);
      cancelIdle(convId);
      // llama-server serves one thing at a time: stop every running extraction (they are retried).
      for (const ac of running.values()) ac.abort();
    },
    /**
     * The reply ended (finished, stopped or failed). Arm the quiet timer (enough new user messages)
     * or the longer idle timer; extraction never starts right after a reply.
     */
    replyEnded(convId) {
      active.delete(convId);
      if (closed) return;
      const conv = store.get(convId);
      if (!eligible(conv)) return;
      const fresh = userCount(conv) - (done.get(convId) || 0);
      if (fresh <= 0) return;
      if (fresh >= every && quietMs <= 0) {
        cancelIdle(convId);
        setImmediate(() => enqueue(convId));
        return;
      }
      arm(convId, fresh >= every ? quietMs : idleMs);
    },
    /** Resolves when every queued extraction has finished (tests, shutdown). */
    async settled() {
      await new Promise((resolve) => setImmediate(resolve));
      while (inflight.size) await Promise.all([...inflight]);
    },
    /** Stop timers and abort running extractions. */
    close() {
      closed = true;
      for (const id of [...idle.keys()]) cancelIdle(id);
      for (const ac of running.values()) ac.abort();
    },
  };
}

module.exports = {
  createMemoryStore, createExtractor, rankMemories, keywords, parseExtraction, extractionMessages,
  MAX_MEMORIES, MEMORY_MAX_CHARS,
};
