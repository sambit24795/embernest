'use strict';
const { availableTools, executeTool, runToolLoop, modelSupportsTools, modelNativeTools, waitForJob } = require('../chat/tools');
const { searchProviderName, webSearch, SearchError, searchQueryFrom, searchContextBlock } = require('../chat/search');
const jobs = require('../jobs');
const { startGenerate, GenerateError } = require('../generate');
const { createStore, validId } = require('../chat/store');
const { streamChat, timingLine, ChatUnavailableError } = require('../chat/llm-client');
const { createThinkSplitter } = require('../chat/think');
const multer = require('multer');
const { createLogger } = require('../../core/log');
const { createMemoryStore, createExtractor } = require('../chat/memory');
const { createPersonaStore, buildSystemPrompt, contextBlock, withStoredContext, PersonaError } = require('../chat/personas');
const { MAX_AVATAR_BYTES, saveAvatar, readAvatar, removeAvatar } = require('../chat/avatars');

const HINT = 'embernest chat enable';
const THINK_HINT = 'embernest chat think enable';
const MAX_TOKENS = 1024;
const CHARS_PER_TOKEN = 3.5;
const MAX_MESSAGE_CHARS = 20000;
// The 🎨 Image reply is a fixed line: a 1.5B model adds nothing to it and may not even be running.
const IMAGE_READY = 'Here is your image.';

const estimateTokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN);

const TRIM_BLOCK = 6;

/**
 * The system prompt plus as many recent messages as fit in `contextSize * 0.75` tokens.
 * Old history is dropped in blocks of 6 messages (not one by one) so the start of the
 * prompt stays the same for several turns and llama.cpp can keep its cache. The newest
 * message is always kept.
 * @param {{ system: string, messages: {role: string, content: string}[], contextSize: number }} o
 * @returns {{ role: string, content: string }[]}
 */
function fitContext({ system, messages, contextSize }) {
  const budget = Math.floor(contextSize * 0.75) - estimateTokens(system);
  const costs = messages.map((m) => estimateTokens(m.content));
  let used = costs.reduce((a, b) => a + b, 0);
  let start = 0;
  while (used > budget && start < messages.length - 1) {
    const end = Math.min(start + TRIM_BLOCK, messages.length - 1);
    for (; start < end; start++) used -= costs[start];
  }
  const kept = messages.slice(start).map((m) => ({ role: m.role, content: m.content }));
  return [{ role: 'system', content: system }, ...kept];
}

/**
 * A conversation as the browser sees it: the stored `context` blocks (recalled memories
 * replayed to the model) are never sent out.
 */
function publicConversation(conv) {
  if (!conv) return conv;
  return { ...conv, messages: conv.messages.map(({ context: _context, ...m }) => m) };
}

/** Sampling params from the request body; only temperature is user-tunable. */
function paramsFrom(body) {
  const params = { max_tokens: MAX_TOKENS };
  const t = Number(body.temperature);
  if (body.temperature != null && Number.isFinite(t)) params.temperature = Math.min(2, Math.max(0, t));
  return params;
}

/** Only role and content go to the model; stored extras (createdAt, sources, images, thought…) stay home. */
function toModelMessage(m) {
  return { role: m.role, content: m.role === 'user' && m.context ? withStoredContext(m.content, m.context) : m.content };
}

/**
 * Run the web search for one user turn (the server does it, not the model).
 * Never throws: a failure becomes a note in the context block.
 * @returns {Promise<{ block: string, sources: {title: string, url: string}[] }>}
 */
async function searchForTurn(cfg, message, onTool) {
  const query = searchQueryFrom(message);
  const name = 'web_search';
  onTool({ name, status: 'running' });
  try {
    const results = await webSearch(query, { searxngUrl: cfg.chat.search && cfg.chat.search.searxngUrl });
    onTool({ name, status: 'done' });
    return { block: searchContextBlock(query, results), sources: results.map((r) => ({ title: r.title, url: r.url })) };
  } catch (err) {
    onTool({ name, status: 'error' });
    const why = err instanceof SearchError ? err.message : `unexpected error (${err.message})`;
    return { block: searchContextBlock(query, [], why), sources: [] };
  }
}

/** Is llama-server answering? Uses the supervisor when we run it, else a quick /health probe. */
async function isRunning(ctx, cfg) {
  if (ctx.chatSupervisor) return ctx.chatSupervisor.status().state === 'running';
  try {
    const res = await fetch(`${cfg.chat.url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** @param {import('express').Express} app @param {object} ctx */
function register(app, ctx) {
  const store = createStore(ctx.paths);
  const personas = createPersonaStore(ctx.paths);
  const memory = createMemoryStore(ctx.paths);
  let logger = null;
  try { logger = createLogger(ctx.paths.serverLog); } catch { /* logging is optional */ }
  const extractor = createExtractor({ store, memory, getConfig: ctx.getConfig, logger, ...(ctx.memoryTiming || {}) });
  app.locals.chatMemory = extractor;
  const personaError = (res, err) => res.status(400).json({ error: err.message });
  /** Maps PersonaError to 400; anything else goes to the error handler. */
  const validated = (handler) => (req, res, ...rest) => {
    try {
      return handler(req, res, ...rest);
    } catch (err) {
      if (err instanceof PersonaError) return personaError(res, err);
      throw err;
    }
  };
  /** Remove the stored file behind an "upload:<name>" avatar. */
  const dropUpload = (avatar) => {
    if (typeof avatar === 'string' && avatar.startsWith('upload:')) removeAvatar(ctx.paths, avatar.slice(7));
  };
  const withPersona = (handler) => (req, res) => {
    const persona = validId(req.params.id) ? personas.get(req.params.id) : null;
    if (!persona) return res.status(404).json({ error: 'Persona not found' });
    return handler(req, res, persona);
  };
  const unavailable = (res, error = 'Chat is not running') => res.status(503).json({ error, hint: HINT });

  /** Resolve :id to a conversation or send 404. */
  const withConversation = (handler) => (req, res) => {
    const conv = validId(req.params.id) ? store.get(req.params.id) : null;
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    return handler(req, res, conv);
  };

  app.get('/api/chat/status', async (req, res) => {
    const cfg = ctx.getConfig();
    const enabled = Boolean(cfg.chat.enabled);
    res.json({
      enabled,
      running: enabled ? await isRunning(ctx, cfg) : false,
      model: cfg.chat.model,
      thinkModel: cfg.chat.thinkModel || '',
      device: cfg.chat.device,
      toolCalling: modelSupportsTools(cfg.chat.model),
      nativeTools: modelNativeTools(cfg.chat.model),
      searchProvider: searchProviderName(cfg.chat.search && cfg.chat.search.searxngUrl),
    });
  });

  app.get('/api/chat/conversations', (req, res) => res.json({ conversations: store.list() }));

  app.post('/api/chat/conversations', (req, res) => {
    const { personaId } = req.body || {};
    const persona = typeof personaId === 'string' ? personas.get(personaId) : null;
    const created = store.create({ personaId: persona ? persona.id : null });
    if (persona && persona.greeting) store.append(created.id, { role: 'assistant', content: persona.greeting });
    res.status(201).json({ conversation: publicConversation(store.get(created.id)) });
  });

  app.get('/api/chat/personas', (req, res) => res.json({ personas: personas.list() }));

  app.post('/api/chat/personas', validated((req, res) => {
    res.status(201).json({ persona: personas.create(req.body) });
  }));

  app.get('/api/chat/personas/:id', withPersona((req, res, persona) => res.json({ persona })));

  app.put('/api/chat/personas/:id', withPersona(validated((req, res, persona) => {
    const updated = personas.update(persona.id, req.body);
    if (persona.avatar !== updated.avatar) dropUpload(persona.avatar);
    res.json({ persona: updated });
  })));

  app.delete('/api/chat/personas/:id', (req, res) => {
    // Conversations keep their personaId; the UI shows "(deleted persona)" for them.
    const persona = validId(req.params.id) ? personas.get(req.params.id) : null;
    if (!persona || !personas.remove(persona.id)) return res.status(404).json({ error: 'Persona not found' });
    dropUpload(persona.avatar);
    memory.clear(persona.id);
    return res.json({ ok: true });
  });

  // Memories. Reading and adding need the persona; deleting also works after it is gone.
  const withMemoryPersona = (handler) => (req, res) => {
    if (!validId(req.params.personaId) || !personas.get(req.params.personaId)) {
      return res.status(404).json({ error: 'Persona not found' });
    }
    return handler(req, res, req.params.personaId);
  };
  app.get('/api/chat/memory/:personaId', withMemoryPersona((req, res, pid) => res.json({ memories: memory.list(pid) })));

  app.post('/api/chat/memory/:personaId', withMemoryPersona((req, res, pid) => {
    const body = req.body || {};
    const created = memory.add(pid, body.text, { pinned: body.pinned === true });
    if (!created) return res.status(400).json({ error: 'text is required (a short note without passwords or card numbers)' });
    return res.status(201).json({ memory: created });
  }));

  app.patch('/api/chat/memory/:personaId/:memoryId', (req, res) => {
    const body = req.body || {};
    const updated = memory.update(req.params.personaId, req.params.memoryId, { text: body.text, pinned: body.pinned });
    if (!updated) return res.status(404).json({ error: 'Memory not found, or the text is empty' });
    return res.json({ memory: updated });
  });

  app.delete('/api/chat/memory/:personaId/:memoryId', (req, res) => {
    if (!memory.remove(req.params.personaId, req.params.memoryId)) return res.status(404).json({ error: 'Memory not found' });
    return res.json({ ok: true });
  });

  app.delete('/api/chat/memory/:personaId', (req, res) => {
    if (!validId(req.params.personaId)) return res.status(404).json({ error: 'Persona not found' });
    memory.clear(req.params.personaId);
    return res.json({ ok: true });
  });

  // Avatar uploads: 2 MB, PNG/JPEG/WebP by magic bytes, stored under a random name.
  const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } });
  app.post('/api/chat/avatars', avatarUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an image file' });
    const name = saveAvatar(ctx.paths, req.file.buffer);
    if (!name) return res.status(400).json({ error: 'Avatar must be a PNG, JPEG or WebP image up to 2 MB' });
    return res.status(201).json({ avatar: `upload:${name}` });
  });

  app.get('/api/chat/avatars/:file', (req, res) => {
    const image = readAvatar(ctx.paths, req.params.file);
    if (!image) return res.status(404).json({ error: 'Avatar not found' });
    res.set({
      'Content-Type': image.contentType,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-cache',
    });
    return res.send(image.buf);
  });

  app.get('/api/chat/conversations/:id', withConversation((req, res, conversation) => res.json({ conversation: publicConversation(conversation) })));

  app.patch('/api/chat/conversations/:id', withConversation((req, res, conv) => {
    const body = req.body || {};
    const conversation = store.update(conv.id, body);
    res.json({ conversation: publicConversation(conversation) });
  }));

  app.delete('/api/chat/conversations/:id', withConversation((req, res, conv) => {
    store.remove(conv.id);
    res.json({ ok: true });
  }));

  /**
   * The 🎨 Image path: start a generate job with the user's text as the prompt, stream its progress,
   * attach the finished image to the assistant message. Problems before anything is stored (engine
   * down, no checkpoint) are plain HTTP errors; the user message is saved only once the job runs.
   */
  async function imageReply(res, conv, content, { ac, send, start, onTool, markFinished }) {
    let job;
    try {
      job = await startGenerate(ctx, { prompt: content });
    } catch (err) {
      markFinished();
      if (err instanceof GenerateError) return res.status(err.status).json(err.payload);
      return res.status(503).json({ error: 'The image engine (ComfyUI) is not running, so no image can be made. Start it and try again.' });
    }
    store.append(conv.id, { role: 'user', content });
    const abort = () => { jobs.cancelJob(job.id, ctx.comfy()).catch(() => {}); };
    ac.signal.addEventListener('abort', abort, { once: true });
    const name = 'generate_image';
    onTool({ name, status: 'running', percent: 0 });
    const final = await waitForJob(ctx, job.id, (percent) => onTool({ name, status: 'running', percent }));
    ac.signal.removeEventListener('abort', abort);
    markFinished();
    if (ac.signal.aborted) return res.end();
    const ok = final.status === 'done' && final.images && final.images.length;
    onTool({ name, status: ok ? 'done' : 'error' });
    const message = store.append(conv.id, ok
      ? { role: 'assistant', content: IMAGE_READY, images: final.images.map((i) => ({ url: i.url })) }
      : { role: 'assistant', content: `I could not make the image: ${final.error || final.status}.` });
    send({ delta: message.content });
    send({ done: true, message });
    return res.end();
  }

  app.post('/api/chat/conversations/:id/messages', withConversation(async (req, res, conv) => {
    const body = req.body || {};
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'content is required' });
    if (content.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: 'message is too long' });

    const cfg = ctx.getConfig();
    // "Think harder": this reply only, from the think model (no tools, reasoning is not kept).
    const think = body.think === true;
    // "Image": this message only; the user's text is the prompt and the model is not involved.
    // Image wins over Search: the image branch returns before any search runs.
    const image = body.image === true;
    if (think && image) return res.status(400).json({ error: 'Choose either Image or Think harder, not both' });
    if (think && !cfg.chat.thinkModel) {
      return res.status(400).json({ error: 'Think harder is not set up', hint: THINK_HINT });
    }
    if (!image && (!cfg.chat.enabled || !(await isRunning(ctx, cfg)))) {
      return unavailable(res, cfg.chat.enabled ? 'Chat is not running' : 'Chat is turned off');
    }

    const ac = new AbortController();
    let finished = false;
    let started = false;
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const start = () => {
      started = true;
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
    };
    const onTool = (tool) => {
      if (!started) start();
      send({ tool });
    };

    extractor.messageStarted(conv.id);
    // 'close' on the response also fires after a normal end, hence `finished`.
    // The extractor hears about the end only after the response is closed, so it never delays the reply.
    res.on('close', () => {
      if (!finished) ac.abort();
      extractor.replyEnded(conv.id);
    });

    if (image) return imageReply(res, conv, content, { ac, send, start, onTool, markFinished: () => { finished = true; } });

    const persona = conv.personaId ? personas.get(conv.personaId) : null;
    // Incognito chats neither read nor write memory.
    const query = [...conv.messages.filter((m) => m.role === 'user').map((m) => m.content), content].slice(-3).join('\n');
    const memories = persona && !conv.incognito ? memory.recall(persona.id, query).map((m) => m.text) : [];
    // Search on for this message: the server searches with the user's text before the model is called.
    const searched = body.search === true ? await searchForTurn(cfg, content, onTool) : { block: '', sources: [] };
    // The context block (memories, web results) is stored on the message and replayed unchanged on
    // every later turn, so the prompt prefix stays byte-identical and llama.cpp keeps its cache.
    const context = [contextBlock(memories), searched.block].filter(Boolean).join('\n\n');
    store.append(conv.id, { role: 'user', content, ...(context ? { context } : {}) });
    const history = store.get(conv.id).messages;
    // Messages saved before `context` existed have none and replay as plain text.
    const messages = fitContext({ system: buildSystemPrompt(persona), messages: history.map(toModelMessage), contextSize: cfg.chat.contextSize });

    let reply = '';
    let usage;
    const params = paramsFrom(body);
    const model = think ? cfg.chat.thinkModel : cfg.chat.model;
    const t0 = Date.now();
    let ttftMs = null;
    let timings;
    const splitter = think ? createThinkSplitter({ implicitOpen: true }) : null;
    let thinkMs = null; // time until the answer starts
    const sendThought = (text) => {
      if (!started) start();
      send({ thinking: text });
    };
    const thoughtFields = () => (think ? { thought: true, thinkMs: thinkMs === null ? Date.now() - t0 : thinkMs } : {});

    try {
      const tools = think ? [] : await availableTools(ctx, cfg);
      const result = await runToolLoop({
        messages,
        tools,
        stream: async function* stream(msgs, offered) {
          for await (const evt of streamChat({
            url: cfg.chat.url,
            model,
            messages: msgs,
            signal: ac.signal,
            params: offered.length ? { ...params, tools: offered } : params,
          })) {
            if (evt.timings) timings = evt.timings;
            if (!splitter) {
              yield evt;
              continue;
            }
            const parts = evt.reasoning !== undefined ? splitter.reasoning(evt.reasoning)
              : evt.delta !== undefined ? splitter.feed(evt.delta) : [];
            for (const part of parts) {
              if (part.thinking !== undefined) sendThought(part.thinking);
              else yield { delta: part.delta };
            }
            const rest = { ...evt };
            delete rest.delta;
            delete rest.reasoning;
            if (Object.keys(rest).length) yield rest;
          }
          if (splitter) {
            for (const part of splitter.flush()) {
              if (part.thinking !== undefined) sendThought(part.thinking);
              else yield { delta: part.delta };
            }
          }
        },
        exec: (name, args) => executeTool(name, args, { ctx, cfg, conv, signal: ac.signal, onTool }),
        onDelta: (delta) => {
          if (!started) start();
          if (ttftMs === null) ttftMs = Date.now() - t0;
          if (think && thinkMs === null) thinkMs = Date.now() - t0;
          reply += delta;
          send({ delta });
        },
        onTool,
      });
      usage = result.usage;
      if (logger) {
        try { logger.info(timingLine({ model, ttftMs, usage, timings })); } catch { /* logging is optional */ }
      }
      if (!started) start();
      const allSources = [...searched.sources];
      for (const src of result.sources) if (!allSources.some((x) => x.url === src.url)) allSources.push(src);
      const message = store.append(conv.id, {
        role: 'assistant',
        content: reply,
        ...(usage ? { usage } : {}),
        ...(allSources.length ? { sources: allSources } : {}),
        ...(result.images.length ? { images: result.images } : {}),
        ...thoughtFields(),
      });
      finished = true;
      send({ done: true, message });
      res.end();
    } catch (err) {
      finished = true;
      if (ac.signal.aborted) {
        // Client went away: keep what was generated so far.
        if (reply) store.append(conv.id, { role: 'assistant', content: reply, stopped: true, ...thoughtFields() });
        return res.end();
      }
      if (reply) store.append(conv.id, { role: 'assistant', content: reply, stopped: true, ...thoughtFields() });
      if (!started) {
        return err instanceof ChatUnavailableError
          ? unavailable(res, err.message)
          : res.status(500).json({ error: err.message });
      }
      send({ error: err.message, hint: HINT });
      return res.end();
    }
    return undefined;
  }));
}

module.exports = { register, fitContext, paramsFrom, publicConversation };
