'use strict';
const jobs = require('../jobs');
const { startGenerate, GenerateError } = require('../generate');
const { getManifest } = require('../../install/manifest');

const MAX_ROUNDS = 3;
const IMAGE_WAIT_MS = 120000;
const POLL_MS = 500;
const IMAGE_DONE = 'Image created and shown to the user.';

const GENERATE_IMAGE = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Create an image from a description. The image is shown to the user automatically.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show, in English, with style and detail' },
        negative: { type: 'string', description: 'Optional: things to avoid' },
      },
      required: ['prompt'],
    },
  },
};

/**
 * Does the model support tool calling? Unknown models are given the benefit of the doubt.
 * @param {{ id: string, toolCalling?: boolean }[]} models
 * @param {string} modelId
 */
function supportsToolsIn(models, modelId) {
  const model = models.find((m) => m.id === modelId);
  return !model || model.toolCalling !== false;
}

/**
 * Should the model be offered OpenAI-style `tools`? Only known models that are not in the
 * `fast` role and have `toolCalling` set: 1.5B models misuse tools and degrade, and a model
 * we know nothing about gets none.
 * @param {{ id: string, role?: string, toolCalling?: boolean }[]} models
 * @param {string} modelId
 */
function nativeToolsIn(models, modelId) {
  const model = models.find((m) => m.id === modelId);
  return Boolean(model) && model.role !== 'fast' && model.toolCalling === true;
}

/** Does the configured chat model (from the manifest) support tool calling? */
function modelSupportsTools(modelId) {
  try {
    return supportsToolsIn(getManifest().llm.models, modelId);
  } catch {
    return true;
  }
}

/** Does the configured chat model get native tool calling (see nativeToolsIn)? */
function modelNativeTools(modelId) {
  try {
    return nativeToolsIn(getManifest().llm.models, modelId);
  } catch {
    return false;
  }
}

/** Is the image engine answering? */
async function imageEngineUp(ctx) {
  try {
    await ctx.comfy().health();
    return true;
  } catch {
    return false;
  }
}

/**
 * Which tool definitions to offer: [] unless the model gets native tool calling, then
 * generate_image when ComfyUI answers. Web search is not a tool: the server runs it
 * before the model is called (see routes/chat.js).
 * @returns {Promise<object[]>}
 */
async function availableTools(ctx, cfg) {
  if (!modelNativeTools(cfg.chat.model)) return [];
  return (await imageEngineUp(ctx)) ? [GENERATE_IMAGE] : [];
}

/** Wait for a generate job, reporting percent changes through `onProgress`. */
async function waitForJob(ctx, id, onProgress) {
  const deadline = Date.now() + IMAGE_WAIT_MS;
  let lastPercent = -1;
  for (;;) {
    const job = jobs.getJob(id);
    if (!job) return { status: 'error', error: 'the image job disappeared' };
    if (['done', 'error', 'cancelled', 'blocked'].includes(job.status)) return job;
    if (typeof job.percent === 'number' && job.percent !== lastPercent) {
      lastPercent = job.percent;
      onProgress(Math.round(job.percent));
    }
    if (Date.now() > deadline) {
      await jobs.cancelJob(id, ctx.comfy()).catch(() => {});
      return { status: 'error', error: 'the image took too long (over 120 s)' };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Run one tool call. Never throws: problems come back as `{ text }` for the model.
 * @returns {Promise<{ text: string, sources?: object[], images?: object[] }>}
 */
async function executeTool(name, args, { ctx, signal, onTool }) {
  if (name === 'generate_image') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return { text: 'Error: generate_image needs a "prompt" string.' };
    onTool({ name, status: 'running', percent: 0 });
    let job;
    try {
      job = await startGenerate(ctx, { prompt, negative: typeof args.negative === 'string' ? args.negative : undefined });
    } catch (err) {
      const why = err instanceof GenerateError ? err.message : `could not reach the image engine (${err.message})`;
      return { text: `Error: image generation failed: ${why}.` };
    }
    const abort = () => { jobs.cancelJob(job.id, ctx.comfy()).catch(() => {}); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const final = await waitForJob(ctx, job.id, (percent) => onTool({ name, status: 'running', percent }));
    if (signal) signal.removeEventListener('abort', abort);
    if (final.status !== 'done' || !final.images || !final.images.length) {
      return { text: `Error: image generation failed: ${final.error || final.status}.` };
    }
    return { text: IMAGE_DONE, images: final.images.map((i) => ({ url: i.url })) };
  }
  return { text: `Error: unknown tool "${name}".` };
}

/** Merge OpenAI streaming `tool_calls` fragments (keyed by `index`) into whole calls. */
function mergeToolCalls(acc, fragments) {
  for (const f of fragments) {
    const i = Number.isInteger(f.index) ? f.index : 0;
    const cur = acc[i] || (acc[i] = { id: '', name: '', arguments: '' });
    if (f.id) cur.id = f.id;
    if (f.function && f.function.name) cur.name += f.function.name;
    if (f.function && typeof f.function.arguments === 'string') cur.arguments += f.function.arguments;
  }
}

/**
 * Chat with tools: stream a completion; when the model asks for tools, run them and ask again.
 * At most MAX_ROUNDS tool rounds, then one last request without tools. Text deltas stream as they arrive
 * (models normally emit none before a tool call). Malformed tool arguments get one error message back.
 * @param {object} o
 * @param {Function} o.stream       (messages, tools) => async iterable of llm-client events
 * @param {object[]} o.messages     the conversation so far (not mutated)
 * @param {object[]} o.tools        tool definitions to offer ([] = plain chat)
 * @param {(text: string) => void} o.onDelta
 * @param {(evt: {name: string, status: string, percent?: number}) => void} o.onTool
 * @param {Function} o.exec         (name, args) => Promise<{ text, sources?, images? }>
 * @returns {Promise<{ reply: string, usage?: object, sources: object[], images: object[] }>}
 */
async function runToolLoop({ stream, messages, tools, onDelta, onTool, exec }) {
  const convo = [...messages];
  const sources = [];
  const images = [];
  let reply = '';
  let usage;
  for (let round = 0; ; round++) {
    const offer = round < MAX_ROUNDS ? tools : [];
    const calls = [];
    let text = '';
    for await (const evt of stream(convo, offer)) {
      if (evt.usage) usage = evt.usage;
      if (evt.toolCalls) mergeToolCalls(calls, evt.toolCalls);
      if (evt.delta) {
        text += evt.delta;
        reply += evt.delta;
        onDelta(evt.delta);
      }
    }
    const made = calls.filter(Boolean);
    if (!made.length || !offer.length) break;

    made.forEach((c, i) => { if (!c.id) c.id = `call_${round}_${i}`; });
    convo.push({
      role: 'assistant',
      content: text || null,
      tool_calls: made.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const c of made) {
      let result;
      let args = null;
      try {
        args = JSON.parse(c.arguments || '{}');
      } catch { /* reported below */ }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        result = { text: 'Error: the tool arguments were not valid JSON. Call the tool again with a valid JSON object, or answer without it.' };
      } else {
        result = await exec(c.name, args);
      }
      if (result.sources) for (const s of result.sources) if (!sources.some((x) => x.url === s.url)) sources.push(s);
      if (result.images) images.push(...result.images);
      onTool({ name: c.name, status: result.text.startsWith('Error') ? 'error' : 'done' });
      convo.push({ role: 'tool', tool_call_id: c.id, content: result.text });
    }
  }
  return { reply, usage, sources, images };
}

module.exports = {
  availableTools, executeTool, runToolLoop, modelSupportsTools, modelNativeTools, supportsToolsIn, nativeToolsIn, waitForJob,
  MAX_ROUNDS, IMAGE_DONE,
};
