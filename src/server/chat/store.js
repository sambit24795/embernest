'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { readJson, writeJson } = require('../../core/state');

const ID_RE = /^[a-z0-9-]{8,64}$/;
const TITLE_MAX = 60;

/** @param {string} id @returns {boolean} true when `id` is safe to use in a file name */
function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * JSON-file conversation store under `paths.chatConversations` (dirs 0700, files 0600).
 * @param {Record<string, string>} paths result of getPaths()
 */
function createStore(paths) {
  const dir = paths.chatConversations;
  const file = (id) => path.join(dir, `${id}.json`);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode only applies to folders it creates; fix up both levels.
    for (const d of [paths.chat, dir]) {
      try { fs.chmodSync(d, 0o700); } catch { /* best effort (Windows) */ }
    }
  }

  /** @returns {object|null} the conversation, or null when the id is invalid or unknown */
  function get(id) {
    if (!validId(id)) return null;
    return readJson(file(id), null);
  }

  function save(conv) {
    ensureDir();
    writeJson(file(conv.id), conv, { mode: 0o600 });
    return conv;
  }

  /** Newest first. */
  function list() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names
      .filter((n) => n.endsWith('.json') && validId(n.slice(0, -5)))
      .map((n) => readJson(path.join(dir, n), null))
      .filter(Boolean)
      .map((c) => ({
        id: c.id,
        title: c.title,
        personaId: c.personaId,
        updatedAt: c.updatedAt,
        incognito: Boolean(c.incognito),
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** @param {{ personaId?: string|null }} [o] */
  function create({ personaId = null } = {}) {
    const now = new Date().toISOString();
    return save({
      id: crypto.randomUUID(),
      title: '',
      personaId: personaId || null,
      createdAt: now,
      updatedAt: now,
      incognito: false,
      messages: [],
    });
  }

  /**
   * Add a message. The first user message becomes the title (cut to 60 chars) when none is set.
   * @param {string} id
   * @param {{ role: 'user'|'assistant', content: string, createdAt?: string, stopped?: boolean, sources?: object[], images?: object[] }} message
   * @returns {object|null} the saved message, or null for an unknown conversation
   */
  function append(id, message) {
    const conv = get(id);
    if (!conv) return null;
    const msg = { createdAt: new Date().toISOString(), ...message };
    conv.messages.push(msg);
    if (!conv.title && msg.role === 'user') conv.title = msg.content.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX);
    conv.updatedAt = msg.createdAt;
    save(conv);
    return msg;
  }

  /** Change title / incognito. `searchEnabled` is accepted and ignored (Search is per message now). Returns the conversation or null. */
  function update(id, patch) {
    const conv = get(id);
    if (!conv) return null;
    if (typeof patch.title === 'string') conv.title = patch.title.trim().slice(0, TITLE_MAX);
    if (typeof patch.incognito === 'boolean') conv.incognito = patch.incognito;
    return save(conv);
  }

  const rename = (id, title) => update(id, { title });

  /** @returns {boolean} whether something was deleted */
  function remove(id) {
    if (!validId(id)) return false;
    try {
      fs.unlinkSync(file(id));
      return true;
    } catch {
      return false;
    }
  }

  return { list, get, create, append, update, rename, remove };
}

module.exports = { createStore, validId };
