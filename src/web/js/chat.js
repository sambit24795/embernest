/**
 * chat.js — the Chat screen: conversation list, messages, composer, persona picker,
 * persona sheet and memories. Classic script, loaded before app.js; it uses the helpers
 * defined there ($, $$, esc, httpUrl, toast, showPairCard) when its functions run.
 * Everything that reaches innerHTML goes through esc() first (see renderMarkdown).
 */
'use strict';

const chat = {
  status: null, conversations: [], personas: [], current: null, stream: null,
  stickToBottom: true, view: 'loading', editorOpen: false, editing: null, editorReturn: 'chat', draftAvatar: '🙂',
  draftIncognito: false, hintDismissed: false, search: false, think: false, image: false, seen: new Map(), memories: [], memoryTimers: [],
  filter: '', deepKey: null,
};
const EMOJIS = ['🙂', '🌿', '📚', '✍️', '🦊', '🐼', '🌙', '⭐', '🎨', '🧠', '🎧', '☕', '🚀', '🌸', '🐢', '🍀'];
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PLAIN_AVATAR = '🤖';

/** True on a phone-sized screen: the list and the conversation are separate screens there. */
function isPhone() {
  return window.matchMedia('(max-width: 767.98px)').matches;
}

/**
 * Model text to HTML. Escape first, then a small markdown subset
 * (paragraphs, **bold**, *italic*, `code`, fenced code). No links.
 * @param {string} text
 * @returns {string} safe HTML
 */
function renderMarkdown(text) {
  return String(text ?? '').split('```').map((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^[\w+-]*\n/, '').replace(/\n$/, '');
      return `<pre><code>${esc(code)}</code></pre>`;
    }
    return esc(part).split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${inlineMd(p)}</p>`).join('');
  }).join('');
}

/** Inline markdown on already-escaped text. Code spans are set aside so nothing formats inside them. */
function inlineMd(escaped) {
  const codes = [];
  const s = escaped
    .replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\uE000${codes.length - 1}\uE001`; })
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
  return s.replace(/\uE000(\d+)\uE001/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Like api(), but keeps the server's hint and reports pairing like api() does. */
async function chatRequest(path, options) {
  const res = await fetch(path, options || {});
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401 && data.pair) {
      showPairCard();
      throw new Error('This device is not paired yet.');
    }
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.hint = data.hint || '';
    throw err;
  }
  return data;
}

const chatJson = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Error text goes to the persona sheet's box while the sheet is open, else to the chat's box. */
function showChatError(message, hint) {
  const text = message ? (hint ? `${message} (${hint})` : message) : '';
  const el = chat.editorOpen ? $('#editorError') : $('#chatError');
  el.textContent = text;
  el.hidden = !text;
  if (text) clearSkeleton();
}

/** Show one chat sub-view: loading skeleton, setup card, list + conversation, or persona picker. */
function setChatView(view) {
  chat.view = view;
  $('#chatSetup').hidden = view !== 'setup';
  $('#chatMain').hidden = view !== 'chat' && view !== 'loading';
  $('#personaPicker').hidden = view !== 'picker';
  if (!chat.editorOpen) showChatError('');
}

/* Placeholder rows shown until the status and the conversation list arrive (static markup only). */
const SKELETON_ROWS = '<li class="chat-skel"><div class="skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div></li>'.repeat(4);
const SKELETON_MESSAGES = '<div class="chat-skel"><div class="skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div></div>'.repeat(3);

function showSkeleton() {
  setChatView('loading');
  $('#chatItems').innerHTML = SKELETON_ROWS;
  $('#chatMessages').innerHTML = SKELETON_MESSAGES;
}

/** Remove the placeholders if they are still there (the real list or pane replaces them). */
function clearSkeleton() {
  ['#chatItems', '#chatMessages'].forEach((sel) => {
    const box = $(sel);
    if (box.querySelector('.chat-skel')) box.replaceChildren();
  });
}

/** Phone: which screen of the chat is showing, the list or the conversation. */
function setPane(pane) {
  $('#chatMain').dataset.pane = pane;
}

/** A persona or emoji avatar as an element (never innerHTML). */
function avatarEl(avatar, size = '') {
  const cls = `avatar ${size}`.trim();
  if (typeof avatar === 'string' && avatar.startsWith('upload:')) {
    const img = document.createElement('img');
    img.className = cls;
    img.alt = '';
    img.src = `/api/chat/avatars/${encodeURIComponent(avatar.slice(7))}`;
    return img;
  }
  const span = document.createElement('span');
  span.className = cls;
  span.setAttribute('aria-hidden', 'true');
  span.textContent = avatar || '🙂';
  return span;
}

function personaFor(id) {
  return id ? chat.personas.find((p) => p.id === id) || null : null;
}

/** Avatar for a conversation or message: the persona's, or the plain assistant's. */
function avatarFor(personaId, size) {
  const p = personaFor(personaId);
  return avatarEl(p ? p.avatar : PLAIN_AVATAR, size);
}

/** Short time: HH:MM today, weekday this week, else a short date. */
function fmtListTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = (Date.now() - d.getTime()) / 86400000;
  if (new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 6) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtMsgTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date().toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/* ----------------------------- load and list ----------------------------- */

/** Show the setup card or the chat UI, then load the conversation list. `route` carries deep links. */
async function loadChat(route) {
  const deep = route && route.chat;
  if (chat.view === 'loading') showSkeleton();
  // Phone: the route decides the screen. A link to the open chat shows it; anything else shows the list.
  if (isPhone()) setPane(deep && deep.c && chat.current && chat.current.id === deep.c ? 'chat' : 'list');
  chat.status = await chatRequest('/api/chat/status');
  renderThink();
  renderImage();
  if (!chat.status.enabled) { setChatView('setup'); return; }
  if (chat.view === 'setup' || chat.view === 'loading') setChatView('chat');
  if (!chat.status.running) showChatError('The chat engine is not running.', 'embernest chat enable');
  await refreshPersonas();
  await refreshConversations();
  // A conversation link that is not the open one (Back/Forward, or a shared link) opens it.
  const otherChat = Boolean(deep && deep.c && (!chat.current || chat.current.id !== deep.c));
  if (deep && (otherChat || (route.hash !== chat.deepKey && (deep.c || deep.new || deep.persona || deep.menu)))) {
    chat.deepKey = route.hash;
    await applyDeepLink(deep);
    return;
  }
  if (chat.view === 'chat' && !chat.current) await openDefaultConversation();
}

/**
 * Open a conversation from the list. On phone this pushes a history entry, so the
 * browser or Android Back button returns to the list. Desktop just opens it.
 */
function openChat(id) {
  if (isPhone()) {
    const hash = `#tab=chat&c=${encodeURIComponent(id)}`;
    if (location.hash !== hash) history.pushState({ pkFromList: true }, '', hash);
  }
  return openConversation(id);
}

/** The in-app back arrow: pop the entry we pushed, or go to the list route. */
function backToList() {
  toggleMenu(false);
  setPane('list');
  if (!isPhone()) return;
  if (history.state && history.state.pkFromList) history.back();
  else location.hash = '#tab=chat';
}

/** Desktop opens the newest chat; phone starts on the list. */
async function openDefaultConversation() {
  if (!isPhone() && chat.conversations.length) await openConversation(chat.conversations[0].id);
  else renderEmptyChat();
}

/** #tab=chat&c=<id> | &new=1 | &persona=<id>&edit=1[&focus=memories] | &menu=1 */
async function applyDeepLink(deep) {
  if (deep.c) {
    await openConversation(deep.c);
  } else if (deep.new) {
    await openDefaultConversation();
    openPicker();
  } else {
    await openDefaultConversation();
    const persona = personaFor(deep.persona);
    if (persona && deep.edit) openEditor(persona, 'chat', deep.focus);
  }
  if (deep.menu) toggleMenu(true);
}

async function refreshPersonas() {
  chat.personas = (await chatRequest('/api/chat/personas')).personas || [];
}

async function refreshConversations() {
  const data = await chatRequest('/api/chat/conversations');
  chat.conversations = data.conversations || [];
  renderConversationList();
}

function renderConversationList() {
  const q = chat.filter.trim().toLowerCase();
  const rows = chat.conversations.filter((c) => {
    if (!q) return true;
    const p = personaFor(c.personaId);
    return `${c.title || ''} ${p ? p.name : ''}`.toLowerCase().includes(q);
  });
  $('#chatListEmpty').hidden = chat.conversations.length > 0;
  $('#chatFilter').hidden = chat.conversations.length === 0;
  const items = rows.map((c) => {
    const persona = personaFor(c.personaId);
    const who = persona ? persona.name : (c.personaId ? '(deleted persona)' : 'Plain assistant');
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chat-item${chat.current && chat.current.id === c.id ? ' is-active' : ''}`;
    const text = document.createElement('span');
    text.className = 'chat-item-text';
    const title = document.createElement('span');
    title.className = 'chat-item-title';
    title.textContent = c.title || (persona ? persona.name : 'New chat');
    const sub = document.createElement('span');
    sub.className = 'chat-item-sub';
    sub.textContent = `${c.title ? who : 'New conversation'}${c.incognito ? ' · 🫥 Incognito' : ''}`;
    text.append(title, sub);
    const time = document.createElement('span');
    time.className = 'chat-item-time';
    time.textContent = fmtListTime(c.updatedAt);
    btn.append(avatarFor(c.personaId), text, time);
    btn.addEventListener('click', () => openChat(c.id).catch((err) => showChatError(err.message, err.hint)));
    li.append(btn);
    return li;
  });
  if (!items.length && chat.conversations.length) {
    const li = document.createElement('li');
    li.className = 'help';
    li.textContent = 'No chats match.';
    items.push(li);
  }
  $('#chatItems').replaceChildren(...items);
}

/* ----------------------------- header and menu ----------------------------- */

/** Header: avatar, persona name and tagline. Tap opens the persona sheet. */
function renderHeader() {
  const btn = $('#chatTitle');
  const conv = chat.current;
  const persona = conv ? personaFor(conv.personaId) : null;
  const deleted = Boolean(conv && conv.personaId && !persona);
  const title = persona ? persona.name : ((conv && conv.title) || (deleted ? '(deleted persona)' : 'New chat'));
  const sub = persona ? (persona.tagline || '') : (conv && conv.title ? 'Plain assistant' : '');
  const incognito = conv ? Boolean(conv.incognito) : chat.draftIncognito;
  const text = document.createElement('span');
  text.className = 'chat-who-text';
  const name = document.createElement('strong');
  name.textContent = title;
  const line = document.createElement('span');
  line.className = 'chat-who-sub';
  if (sub) line.append(document.createTextNode(sub));
  if (incognito) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-accent';
    badge.textContent = '🫥 Incognito';
    line.append(badge);
  }
  text.append(name);
  if (sub || incognito) text.append(line);
  btn.replaceChildren(avatarFor(conv ? conv.personaId : null, 'avatar-sm'), text);
  btn.disabled = !persona;
  btn.title = persona ? 'View or edit this persona' : '';
  renderMenu();
  renderSearch();
  renderThink();
  renderImage();
}

function renderMenu() {
  const on = chat.current ? Boolean(chat.current.incognito) : chat.draftIncognito;
  const inc = $('#chatIncognito');
  inc.setAttribute('aria-checked', String(on));
  $('#chatIncognitoState').textContent = on ? 'On' : 'Off';
  inc.title = on ? 'Incognito: this chat is not remembered' : 'Incognito: this chat will not be remembered';
  $('#chatPersonaBtn').disabled = !(chat.current && personaFor(chat.current.personaId));
  $('#chatRenameBtn').disabled = !chat.current;
  $('#chatDeleteBtn').disabled = !chat.current;
}

function toggleMenu(open) {
  const menu = $('#chatMenu');
  const next = typeof open === 'boolean' ? open : menu.hidden;
  menu.hidden = !next;
  $('#chatMenuBtn').setAttribute('aria-expanded', String(next));
  if (next) renderMenu();
}

/* ----------------------------- conversation ----------------------------- */

async function openConversation(id) {
  abortStream();
  const data = await chatRequest(`/api/chat/conversations/${encodeURIComponent(id)}`);
  chat.current = data.conversation;
  setChatView('chat');
  setPane('chat');
  renderHeader();
  renderMessages(chat.current.messages || []);
  renderConversationList();
  checkNewMemories(memoryPersonaOf(chat.current));
}

/** No conversation yet: a draft. Phone shows the list instead. */
function renderEmptyChat() {
  chat.current = null;
  chat.draftIncognito = false;
  setPane(isPhone() ? 'list' : 'chat');
  renderHeader();
  renderMessages([]);
  renderConversationList();
}

/**
 * One message row: avatar slot, bubble, tap/hover timestamp. User text is plain text;
 * model text goes through renderMarkdown. `first` marks the first row of a group.
 */
function messageEl(m, first, personaId) {
  const isUser = m.role === 'user';
  const row = document.createElement('div');
  row.className = `msg-row msg-row-${isUser ? 'user' : 'assistant'}${first ? ' is-first' : ''}`;
  row.dataset.role = isUser ? 'user' : 'assistant';
  if (!isUser) {
    const slot = document.createElement('div');
    slot.className = 'msg-avatar';
    if (first) slot.append(avatarFor(personaId, 'avatar-sm'));
    row.append(slot);
  }
  const col = document.createElement('div');
  col.className = 'msg-col';
  const bubble = document.createElement('div');
  bubble.className = `msg msg-${isUser ? 'user' : 'assistant'}`;
  const body = document.createElement('div');
  body.className = 'msg-body';
  if (isUser) body.textContent = m.content;
  else body.innerHTML = renderMarkdown(m.content);
  bubble.append(body);
  const extras = isUser ? null : extrasEl(m);
  if (extras) bubble.append(extras);
  if (m.thought) bubble.append(noteEl(typeof m.thinkMs === 'number' ? `Thought for ${Math.round(m.thinkMs / 1000)} s` : 'Thought'));
  if (m.stopped) bubble.append(noteEl('Stopped'));
  const time = document.createElement('time');
  time.className = 'msg-time';
  time.textContent = fmtMsgTime(m.createdAt || new Date().toISOString());
  col.append(bubble, time);
  row.append(col);
  row.addEventListener('click', (e) => {
    if (e.target.closest('a, summary')) return;
    row.classList.toggle('show-time');
  });
  return row;
}

function noteEl(text) {
  const note = document.createElement('div');
  note.className = 'msg-note';
  note.textContent = text;
  return note;
}

/** Append a message to the list, grouping it with the row before it when the sender is the same. */
function appendMessage(m) {
  const box = $('#chatMessages');
  box.querySelector('.chat-empty')?.remove();
  const role = m.role === 'user' ? 'user' : 'assistant';
  const last = box.lastElementChild;
  const row = messageEl(m, !last || last.dataset.role !== role, chat.current && chat.current.personaId);
  box.append(row);
  return row;
}

/** Intro shown in an empty conversation: the persona, or a prompt to pick one. */
function emptyChatEl() {
  const wrap = document.createElement('div');
  wrap.className = 'empty chat-empty';
  const persona = chat.current ? personaFor(chat.current.personaId) : null;
  const h = document.createElement('h3');
  const p = document.createElement('p');
  if (persona) {
    wrap.append(avatarEl(persona.avatar, 'avatar-lg'));
    h.textContent = persona.name;
    p.textContent = persona.tagline ? `${persona.tagline}. Say hello to start.` : 'Say hello to start.';
    wrap.append(h, p);
  } else if (chat.current) {
    h.textContent = 'Say hello';
    p.textContent = 'Your plain assistant is ready.';
    wrap.append(h, p);
  } else {
    h.textContent = 'Start a conversation';
    p.textContent = 'Type below to talk to the plain assistant, or pick a persona with their own character.';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn';
    pick.textContent = 'Choose a persona';
    pick.addEventListener('click', openPicker);
    wrap.append(h, p, pick);
  }
  return wrap;
}

function renderMessages(messages) {
  const box = $('#chatMessages');
  box.replaceChildren();
  const personaId = chat.current && chat.current.personaId;
  let prev = null;
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    box.append(messageEl(m, prev !== role, personaId));
    prev = role;
  }
  if (!messages.length) box.append(emptyChatEl());
  chat.stickToBottom = true;
  scrollChat();
}

function scrollChat() {
  const box = $('#chatMessages');
  if (chat.stickToBottom) box.scrollTop = box.scrollHeight;
}

/** Source chips and inline images for an assistant message, or null when it has neither. Built with DOM APIs only. */
function extrasEl(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-extras';
  const chips = (m.sources || []).map(sourceChip).filter(Boolean);
  if (chips.length) {
    const list = document.createElement('div');
    list.className = 'source-chips';
    list.append(...chips);
    wrap.append(list);
  }
  for (const img of m.images || []) {
    const src = localImageUrl(img && img.url);
    if (!src) continue;
    const a = document.createElement('a');
    a.href = src;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const pic = document.createElement('img');
    pic.src = src;
    pic.alt = 'Generated image';
    pic.loading = 'lazy';
    a.append(pic);
    wrap.append(a);
  }
  return wrap.childElementCount ? wrap : null;
}

/** One source as a chip showing only the hostname. */
function sourceChip(src) {
  const url = httpUrl(src && src.url);
  if (!url) return null;
  const a = document.createElement('a');
  a.className = 'source-chip';
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = String((src && src.title) || url.hostname).slice(0, 200);
  a.textContent = url.hostname;
  return a;
}

/** Generated images are only shown from our own /api/image proxy. */
function localImageUrl(value) {
  const s = String(value || '');
  return s.startsWith('/api/image?') ? s : null;
}

/** Text for the status line while a tool runs. */
function toolStatusText(tool) {
  if (tool.status === 'done') return '';
  if (tool.status === 'error') return tool.name === 'generate_image' ? 'The image could not be made.' : 'The web search failed.';
  if (tool.name === 'web_search') return 'Searching the web…';
  if (tool.name === 'generate_image') return typeof tool.percent === 'number' ? `Making an image… ${tool.percent}%` : 'Making an image…';
  return '';
}

/**
 * Collapsible reasoning block above a reply. Reasoning text goes in with textContent, never as HTML.
 * It collapses when the answer starts (`finish`); the timer stops then too.
 * @returns {{ add: (text: string) => void, finish: () => void }}
 */
function thoughtEl(bubble, body) {
  const det = document.createElement('details');
  det.className = 'msg-thought';
  det.open = true;
  const sum = document.createElement('summary');
  const text = document.createElement('div');
  text.className = 'msg-thought-text';
  det.append(sum, text);
  bubble.insertBefore(det, body);
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const tick = () => { sum.textContent = `Thinking… (${seconds()} s)`; };
  tick();
  let timer = setInterval(tick, 1000);
  return {
    add(part) { text.textContent += part; },
    finish() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      sum.textContent = `Thought for ${seconds()} s`;
      det.open = false;
    },
  };
}

/**
 * Read the SSE reply: `{tool}` status events, `{thinking}` reasoning text (Think harder),
 * `{delta}` text, then `{done, message}` or `{error}`.
 * @param {Response} res
 * @param {{ onDelta: Function, onTool: Function, onDone: Function, onThinking?: Function }} handlers
 */
async function readChatStream(res, { onDelta, onTool, onDone, onThinking = () => {} }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      if (!block.startsWith('data: ')) continue;
      const evt = JSON.parse(block.slice(6));
      if (evt.error) throw Object.assign(new Error(evt.error), { hint: evt.hint || '' });
      if (evt.tool) onTool(evt.tool);
      if (typeof evt.thinking === 'string') onThinking(evt.thinking);
      if (evt.delta) onDelta(evt.delta);
      if (evt.done) onDone(evt.done.message);
    }
  }
}

/** The three dots shown until the first token arrives. Static markup, no text from outside. */
function typingEl() {
  const el = document.createElement('span');
  el.className = 'typing';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'Typing');
  el.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  return el;
}

/** Send a message and stream the reply into a new bubble. */
async function sendChat(text) {
  if (!chat.current) {
    const data = await chatRequest('/api/chat/conversations', chatJson({}));
    chat.current = data.conversation;
    if (chat.draftIncognito) {
      const patch = { incognito: true };
      const patched = await chatRequest(`/api/chat/conversations/${chat.current.id}`, { ...chatJson(patch), method: 'PATCH' });
      chat.current = patched.conversation;
    }
    chat.draftIncognito = false;
    renderHeader();
    $('#chatMessages').replaceChildren();
  }
  // "Think harder" applies to this message only.
  const think = chat.think;
  const image = chat.image;
  // Search applies to this message only, like Think harder and Image; Image wins over Search.
  const search = chat.search && !image;
  chat.think = false;
  chat.image = false;
  chat.search = false;
  renderThink();
  renderImage();
  renderSearch();
  const now = new Date().toISOString();
  appendMessage({ role: 'user', content: text, createdAt: now });
  const reply = appendMessage({ role: 'assistant', content: '', createdAt: now });
  const bubble = reply.querySelector('.msg');
  const replyBody = reply.querySelector('.msg-body');
  replyBody.replaceChildren(typingEl());
  const statusEl = document.createElement('div');
  statusEl.className = 'msg-status';
  statusEl.setAttribute('aria-live', 'polite');
  bubble.append(statusEl);
  const thought = think ? thoughtEl(bubble, replyBody) : null;
  let answering = false;
  let typing = true;
  let acc = '';
  let frame = 0;
  const clearTyping = () => { if (typing) { typing = false; replyBody.replaceChildren(); } };
  const paint = () => {
    frame = 0;
    replyBody.innerHTML = renderMarkdown(acc);
    scrollChat();
  };
  chat.stickToBottom = true;
  scrollChat();

  checkNewMemories(memoryPersonaOf(chat.current));
  const ac = new AbortController();
  chat.stream = ac;
  setSending(true);
  showChatError('');
  try {
    const res = await fetch(`/api/chat/conversations/${chat.current.id}/messages`, {
      ...chatJson({
        content: text,
        ...(think ? { think: true } : {}),
        ...(image ? { image: true } : {}),
        ...(search ? { search: true } : {}),
      }), signal: ac.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.pair) { showPairCard(); throw new Error('This device is not paired yet.'); }
      throw Object.assign(new Error(data.error || `${res.status} ${res.statusText}`), { hint: data.hint || '' });
    }
    await readChatStream(res, {
      onThinking: (part) => { clearTyping(); if (thought) thought.add(part); scrollChat(); },
      onDelta: (delta) => {
        if (thought && !answering) { answering = true; thought.finish(); }
        clearTyping();
        acc += delta;
        statusEl.textContent = '';
        if (!frame) frame = requestAnimationFrame(paint);
      },
      onTool: (tool) => {
        clearTyping();
        statusEl.textContent = toolStatusText(tool);
        scrollChat();
      },
      onDone: (message) => {
        statusEl.remove();
        const extras = extrasEl(message || {});
        if (extras) bubble.append(extras);
        scrollChat();
      },
    });
  } catch (err) {
    if (ac.signal.aborted) {
      clearTyping();
      bubble.append(noteEl('Stopped'));
    } else {
      if (!acc) reply.remove();
      showChatError(err.message, err.hint);
    }
  } finally {
    if (frame) { cancelAnimationFrame(frame); paint(); }
    clearTyping();
    if (thought) thought.finish();
    chat.stream = null;
    setSending(false);
    refreshConversations().catch(() => {});
    scheduleMemoryChecks(memoryPersonaOf(chat.current));
  }
}

function abortStream() {
  if (chat.stream) chat.stream.abort();
}

function setSending(on) {
  $('#chatSend').hidden = on;
  $('#chatStop').hidden = !on;
}

async function renameChat() {
  if (!chat.current) return;
  const title = window.prompt('Rename this chat', chat.current.title || '');
  if (title === null) return;
  try {
    const data = await chatRequest(`/api/chat/conversations/${chat.current.id}`, { ...chatJson({ title: title.trim() }), method: 'PATCH' });
    chat.current.title = data.conversation.title;
    renderHeader();
    await refreshConversations();
  } catch (err) {
    showChatError(err.message, err.hint);
  }
}

async function deleteChat() {
  if (!chat.current || !window.confirm('Delete this conversation? This cannot be undone.')) return;
  abortStream();
  try {
    await chatRequest(`/api/chat/conversations/${chat.current.id}`, { method: 'DELETE' });
    renderEmptyChat();
    if (isPhone()) backToList();
    await refreshConversations();
    if (!isPhone() && chat.conversations.length) await openConversation(chat.conversations[0].id);
  } catch (err) {
    showChatError(err.message, err.hint);
  }
}

/* ----------------------------- personas ----------------------------- */

/** New-chat picker: the plain assistant plus each saved persona. */
function openPicker() {
  toggleMenu(false);
  renderPicker();
  setChatView('picker');
  refreshPersonas().then(renderPicker).catch((err) => showChatError(err.message, err.hint));
}

function renderPicker() {
  const plain = { id: null, name: 'Plain assistant', avatar: PLAIN_AVATAR, tagline: 'A helpful, friendly assistant. No character.' };
  $('#personaGrid').replaceChildren(...[plain, ...chat.personas].map(personaCard));
}

function personaCard(p) {
  const card = document.createElement('div');
  card.className = 'persona-card';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'persona-card-main';
  const text = document.createElement('span');
  text.className = 'persona-card-text';
  const name = document.createElement('strong');
  name.textContent = p.name;
  const tagline = document.createElement('small');
  tagline.textContent = p.tagline || '';
  text.append(name, tagline);
  start.append(avatarEl(p.avatar, 'avatar-lg'), text);
  start.addEventListener('click', () => startChat(p.id).catch((err) => showChatError(err.message, err.hint)));
  card.append(start);
  if (p.id) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-ghost btn-sm';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openEditor(p, 'picker'));
    card.append(edit);
  }
  return card;
}

/** Create a conversation with this persona (null = plain) and open it. */
async function startChat(personaId) {
  const data = await chatRequest('/api/chat/conversations', chatJson(personaId ? { personaId } : {}));
  await refreshConversations();
  await openChat(data.conversation.id);
}

function renderEmojiPicker() {
  $('#editorEmojis').replaceChildren(...EMOJIS.map((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `persona-emoji${chat.draftAvatar === e ? ' is-selected' : ''}`;
    b.textContent = e;
    b.setAttribute('aria-label', `Use ${e} as avatar`);
    b.addEventListener('click', () => { chat.draftAvatar = e; renderAvatarPreview(); });
    return b;
  }));
}

function renderAvatarPreview() {
  $('#editorAvatarPreview').replaceChildren(avatarEl(chat.draftAvatar, 'avatar-lg'));
  renderEmojiPicker();
}

function addExampleRow(example = { user: '', assistant: '' }) {
  const rows = $$('.example-row').length;
  if (rows >= 6) return;
  const row = document.createElement('div');
  row.className = 'example-row';
  const user = Object.assign(document.createElement('textarea'), { rows: 2, placeholder: 'They say…', maxLength: 4000, value: example.user });
  user.className = 'ex-user';
  const assistant = Object.assign(document.createElement('textarea'), { rows: 2, placeholder: 'The persona replies…', maxLength: 4000, value: example.assistant });
  assistant.className = 'ex-assistant';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn btn-ghost btn-sm';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', 'Remove example');
  remove.addEventListener('click', () => { row.remove(); updateAddExample(); });
  row.append(user, assistant, remove);
  $('#pExamples').append(row);
  updateAddExample();
}

function updateAddExample() {
  $('#addExampleBtn').disabled = $$('.example-row').length >= 6;
}

/** Open the persona sheet; `returnView` is 'chat' or 'picker'; `focus` 'memories' scrolls to the memories. */
function openEditor(persona, returnView, focus) {
  toggleMenu(false);
  chat.editing = persona;
  chat.editorReturn = returnView;
  chat.draftAvatar = persona ? persona.avatar : '🙂';
  $('#editorTitle').textContent = persona ? 'Edit persona' : 'New persona';
  $('#pName').value = persona ? persona.name : '';
  $('#pTagline').value = persona ? persona.tagline || '' : '';
  $('#pPersonality').value = persona ? persona.personality || '' : '';
  $('#pStyle').value = persona ? persona.style || '' : '';
  $('#pGreeting').value = persona ? persona.greeting || '' : '';
  $('#pExamples').replaceChildren();
  (persona ? persona.examples || [] : []).forEach((ex) => addExampleRow(ex));
  updateAddExample();
  $('#editorDeleteBtn').hidden = !persona;
  renderAvatarPreview();
  initMemories(persona, focus === 'memories');
  chat.editorOpen = true;
  showChatError('');
  $('#personaScrim').hidden = false;
  $('.sheet-body', $('#personaEditor')).scrollTop = 0;
}

/** Close the sheet and refresh whatever shows personas underneath. */
function closeEditor() {
  chat.editorOpen = false;
  chat.editing = null;
  $('#personaScrim').hidden = true;
  showChatError('');
  renderConversationList();
  if (chat.editorReturn === 'picker') { renderPicker(); return; }
  renderHeader();
  if (chat.current && !chat.stream) renderMessages(chat.current.messages || []);
}

/** Draft from the editor fields. Examples with both sides empty are dropped. */
function collectDraft() {
  const examples = $$('.example-row').map((row) => ({
    user: row.querySelector('.ex-user').value,
    assistant: row.querySelector('.ex-assistant').value,
  })).filter((ex) => ex.user.trim() || ex.assistant.trim());
  return {
    name: $('#pName').value,
    avatar: chat.draftAvatar,
    tagline: $('#pTagline').value,
    personality: $('#pPersonality').value,
    style: $('#pStyle').value,
    greeting: $('#pGreeting').value,
    examples,
  };
}

async function savePersona() {
  const body = collectDraft();
  try {
    if (chat.editing) await chatRequest(`/api/chat/personas/${chat.editing.id}`, { ...chatJson(body), method: 'PUT' });
    else await chatRequest('/api/chat/personas', chatJson(body));
    await refreshPersonas();
    toast('Persona saved', 'ok');
    closeEditor();
  } catch (err) {
    showChatError(err.message, err.hint);
  }
}

/** Delete a persona. Its conversations stay and show "(deleted persona)". */
async function deletePersona() {
  if (!chat.editing || !window.confirm(`Delete ${chat.editing.name}? Their chats stay, without the character.`)) return;
  try {
    await chatRequest(`/api/chat/personas/${chat.editing.id}`, { method: 'DELETE' });
    await refreshPersonas();
    toast('Persona deleted', 'ok');
    closeEditor();
    await refreshConversations();
  } catch (err) {
    showChatError(err.message, err.hint);
  }
}

/** Upload a PNG/JPEG/WebP avatar; the server checks the bytes again. */
async function uploadAvatar(file) {
  if (!file) return;
  if (!AVATAR_TYPES.includes(file.type)) { showChatError('Avatar must be a PNG, JPEG or WebP image'); return; }
  if (file.size > AVATAR_MAX_BYTES) { showChatError('Avatar must be 2 MB or smaller'); return; }
  const form = new FormData();
  form.append('file', file);
  try {
    const data = await chatRequest('/api/chat/avatars', { method: 'POST', body: form });
    chat.draftAvatar = data.avatar;
    renderAvatarPreview();
  } catch (err) {
    showChatError(err.message, err.hint);
  }
}

/* ----------------------------- memory ----------------------------- */

/** The persona whose memory this conversation reads and writes, or null (incognito or no persona). */
function memoryPersonaOf(conv) {
  return conv && conv.personaId && !conv.incognito ? conv.personaId : null;
}

/** Run an async handler and show its errors in the chat or sheet error box. */
function guard(fn) {
  return (...args) => fn(...args).catch((err) => showChatError(err.message, err.hint));
}

/**
 * The Search chip applies to the next message only. The server runs the search with your message,
 * so any model can use it.
 */
function renderSearch() {
  const btn = $('#chatSearch');
  btn.setAttribute('aria-pressed', String(chat.search));
  btn.textContent = chat.search ? '🔎 Search on' : '🔎 Search';
  const provider = (chat.status && chat.status.searchProvider) || 'DuckDuckGo';
  btn.title = chat.search
    ? `The next message is searched on the web. Tap to turn it off. Your message is sent to ${provider}.`
    : `Search the web for your next message. Your message is sent to ${provider}.`;
}

/** The Image chip applies to the next message only: your text becomes the image prompt. */
function renderImage() {
  const btn = $('#chatImage');
  btn.setAttribute('aria-pressed', String(chat.image));
  btn.textContent = chat.image ? '🎨 Image on' : '🎨 Image';
  btn.title = chat.image
    ? 'The next message is used as an image prompt. Tap to turn it off.'
    : 'Make an image from your next message (it is used as the prompt)';
}

function toggleImage() {
  chat.image = !chat.image;
  if (chat.image) chat.think = false;
  renderImage();
  renderThink();
}

/** The Think harder chip shows only when a think model is set; it applies to the next message. */
function renderThink() {
  const btn = $('#chatThink');
  const available = Boolean(chat.status && chat.status.thinkModel);
  btn.hidden = !available;
  btn.setAttribute('aria-pressed', String(chat.think));
  btn.textContent = chat.think ? '🧠 Thinking on' : '🧠 Think harder';
  btn.title = chat.think
    ? 'The next message uses the Think harder model. Tap to turn it off.'
    : 'Use the slower Think harder model for the next message only';
}

function toggleThink() {
  chat.think = !chat.think;
  if (chat.think) chat.image = false;
  renderThink();
  renderImage();
}

function toggleSearch() {
  chat.search = !chat.search;
  renderSearch();
  updateSearchHint();
}

async function toggleIncognito() {
  const next = !(chat.current ? chat.current.incognito : chat.draftIncognito);
  if (!chat.current) {
    chat.draftIncognito = next;
  } else {
    const data = await chatRequest(`/api/chat/conversations/${chat.current.id}`, { ...chatJson({ incognito: next }), method: 'PATCH' });
    chat.current = data.conversation;
    await refreshConversations();
  }
  renderHeader();
}

/** Remember the memory ids the user has seen, so only new ones raise the toast. */
function markSeen(personaId, memories) {
  chat.seen.set(personaId, new Set(memories.map((m) => m.id)));
}

/**
 * Background extraction finishes after the reply, so the done event cannot report it.
 * Poll the persona's memories instead and toast the ones that are new since the last look.
 */
async function checkNewMemories(personaId) {
  if (!personaId) return;
  try {
    const data = await chatRequest(`/api/chat/memory/${encodeURIComponent(personaId)}`);
    const memories = data.memories || [];
    const seen = chat.seen.get(personaId);
    const fresh = seen ? memories.filter((m) => !seen.has(m.id)).length : 0;
    markSeen(personaId, memories);
    if (fresh) toast(`🧠 remembered ${fresh} new ${fresh === 1 ? 'thing' : 'things'}`, 'ok');
  } catch (_) { /* the poll is best effort */ }
}

const MEMORY_CHECKS_MS = [4000, 20000, 60000];

function scheduleMemoryChecks(personaId) {
  chat.memoryTimers.forEach(clearTimeout);
  chat.memoryTimers = personaId ? MEMORY_CHECKS_MS.map((ms) => setTimeout(() => checkNewMemories(personaId), ms)) : [];
}

/** Show the memory list for a saved persona only, and load it. */
function initMemories(persona, scrollTo = false) {
  $('#memorySection').hidden = !persona;
  $('#memoryAdd').hidden = true;
  chat.memories = [];
  renderMemories();
  if (!persona) return;
  loadMemories(persona.id)
    .then(() => { if (scrollTo) $('#memorySection').scrollIntoView({ block: 'start' }); })
    .catch((err) => showChatError(err.message, err.hint));
}

async function loadMemories(personaId) {
  const data = await chatRequest(`/api/chat/memory/${encodeURIComponent(personaId)}`);
  chat.memories = data.memories || [];
  markSeen(personaId, chat.memories);
  renderMemories();
}

function renderMemories() {
  $('#memoryList').replaceChildren(...chat.memories.map(memoryItem));
  $('#memoryEmpty').hidden = chat.memories.length > 0;
  $('#memoryForget').hidden = chat.memories.length === 0;
}

/** One memory row. Text is set with textContent, never as HTML. */
function memoryItem(m) {
  const li = document.createElement('li');
  li.className = `memory-item${m.pinned ? ' is-pinned' : ''}`;
  const text = document.createElement('span');
  text.className = 'memory-text';
  if (m.pinned) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-accent memory-pinned-badge';
    badge.textContent = '📌 Pinned';
    text.append(badge);
  }
  text.append(document.createTextNode(m.text));
  const actions = document.createElement('div');
  actions.className = 'memory-actions';
  actions.append(
    memoryButton(m.pinned ? 'Unpin' : 'Pin', () => patchMemory(m.id, { pinned: !m.pinned })),
    memoryButton('Edit', () => editMemory(m)),
    memoryButton('Delete', () => deleteMemory(m), 'btn-danger-text'),
  );
  li.append(text, actions);
  return li;
}

function memoryButton(label, action, extra = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn btn-ghost btn-sm ${extra}`.trim();
  b.textContent = label;
  b.addEventListener('click', guard(action));
  return b;
}

function memoryUrl(id) {
  return `/api/chat/memory/${encodeURIComponent(chat.editing.id)}${id ? `/${encodeURIComponent(id)}` : ''}`;
}

async function patchMemory(id, patch) {
  await chatRequest(memoryUrl(id), { ...chatJson(patch), method: 'PATCH' });
  await loadMemories(chat.editing.id);
}

async function editMemory(m) {
  const text = window.prompt('Edit this memory', m.text);
  if (text === null || !text.trim() || text.trim() === m.text) return;
  await patchMemory(m.id, { text: text.trim() });
}

async function deleteMemory(m) {
  if (!window.confirm('Delete this memory?')) return;
  await chatRequest(memoryUrl(m.id), { method: 'DELETE' });
  await loadMemories(chat.editing.id);
}

async function addMemory() {
  const input = $('#memoryText');
  const text = input.value.trim();
  if (!text) return;
  await chatRequest(memoryUrl(null), chatJson({ text, pinned: $('#memoryPin').checked }));
  input.value = '';
  $('#memoryPin').checked = false;
  $('#memoryAdd').hidden = true;
  await loadMemories(chat.editing.id);
}

async function forgetAllMemories() {
  if (!chat.editing || !window.confirm(`Forget everything ${chat.editing.name} remembers? This cannot be undone.`)) return;
  await chatRequest(memoryUrl(null), { method: 'DELETE' });
  await loadMemories(chat.editing.id);
  toast('Memories cleared', 'ok');
}

/**
 * Phone keyboard: keep the conversation exactly as tall as the visible area, so the composer
 * stays above the on-screen keyboard. CSS reads --vvh / --vvtop.
 */
function bindViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vvtop', `${Math.round(vv.offsetTop)}px`);
    scrollChat();
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

const SEARCH_WORDS = /\b(search|look up|google|browse)\b/i;

/**
 * Small models ignore the capabilities line, so nudge: when the message asks for a web search
 * and the Search chip is off, show a one-line dismissible tip above the composer.
 */
function updateSearchHint() {
  const hint = $('#chatSearchHint');
  const text = $('#chatInput').value;
  const show = !chat.hintDismissed && !chat.search && SEARCH_WORDS.test(text);
  if (show) $('#chatSearchHintText').textContent = 'Tip: tap 🔎 Search to include web results';
  hint.hidden = !show;
}

/** Chat wiring: composer, menu, list, picker, persona sheet, memories. */
function bindChat() {
  const input = $('#chatInput');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  input.addEventListener('input', autosize);
  input.addEventListener('input', updateSearchHint);
  $('#chatSearchHintClose').addEventListener('click', () => { chat.hintDismissed = true; updateSearchHint(); });
  input.addEventListener('focus', () => setTimeout(scrollChat, 300));
  input.addEventListener('keydown', (e) => {
    // Desktop: Enter sends, Shift+Enter adds a line. Touch screens: Enter always adds a line.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
      e.preventDefault();
      $('#chatForm').requestSubmit();
    }
  });
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || chat.stream) return;
    input.value = '';
    autosize();
    chat.hintDismissed = false;
    updateSearchHint();
    sendChat(text).catch((err) => showChatError(err.message, err.hint));
  });
  $('#chatStop').addEventListener('click', abortStream);
  $('#chatNewBtn').addEventListener('click', openPicker);
  $('#chatBack').addEventListener('click', backToList);
  $('#chatFilter').addEventListener('input', (e) => { chat.filter = e.target.value; renderConversationList(); });
  $('#chatTitle').addEventListener('click', () => {
    const persona = chat.current ? personaFor(chat.current.personaId) : null;
    if (persona) openEditor(persona, 'chat');
  });
  $('#chatMessages').addEventListener('scroll', (e) => {
    const box = e.currentTarget;
    chat.stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  });

  // overflow menu
  $('#chatMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
  $('#chatMenu').addEventListener('click', (e) => { if (e.target.closest('.menu-item')) toggleMenu(false); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) toggleMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (chat.editorOpen) closeEditor();
    else if (!$('#chatMenu').hidden) { toggleMenu(false); $('#chatMenuBtn').focus(); }
  });
  $('#chatIncognito').addEventListener('click', guard(toggleIncognito));
  $('#chatPersonaBtn').addEventListener('click', () => {
    const persona = chat.current ? personaFor(chat.current.personaId) : null;
    if (persona) openEditor(persona, 'chat', 'memories');
  });
  $('#chatRenameBtn').addEventListener('click', renameChat);
  $('#chatDeleteBtn').addEventListener('click', deleteChat);
  $('#chatSearch').addEventListener('click', toggleSearch);
  $('#chatImage').addEventListener('click', toggleImage);
  $('#chatThink').addEventListener('click', toggleThink);

  // picker and persona sheet
  $('#pickerBackBtn').addEventListener('click', () => {
    if (!chat.current) renderEmptyChat();
    setChatView('chat');
    renderHeader();
  });
  $('#newPersonaBtn').addEventListener('click', () => openEditor(null, 'picker'));
  $('#editorCancelBtn').addEventListener('click', closeEditor);
  $('#personaScrim').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeEditor(); });
  $('#editorSaveBtn').addEventListener('click', savePersona);
  $('#editorDeleteBtn').addEventListener('click', deletePersona);
  $('#memAddBtn').addEventListener('click', () => {
    const box = $('#memoryAdd');
    box.hidden = !box.hidden;
    if (!box.hidden) $('#memoryText').focus();
  });
  $('#memorySaveBtn').addEventListener('click', guard(addMemory));
  $('#memoryForgetBtn').addEventListener('click', guard(forgetAllMemories));
  $('#addExampleBtn').addEventListener('click', () => addExampleRow());
  $('#editorAvatarFile').addEventListener('change', (e) => {
    uploadAvatar(e.target.files[0]);
    e.target.value = '';
  });
  bindViewport();
}
