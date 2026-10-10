'use strict';

/** The chat engine (llama-server) could not be reached or answered with an error. */
class ChatUnavailableError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ChatUnavailableError';
    this.status = status;
  }
}

/** `model` (router mode needs it) and `cache_prompt` for every request. */
function modelFields(model) {
  return { ...(model ? { model } : {}), cache_prompt: true };
}

/**
 * One log line per reply: prompt tokens, cached tokens, time to first token, generation speed.
 * Reads llama-server's `timings` (`cache_n`, `prompt_n`, `predicted_per_second`) and falls back to
 * `usage.prompt_tokens_details.cached_tokens`. Pure.
 * @param {{ model?: string, ttftMs?: number|null, usage?: object, timings?: object }} o
 * @returns {string}
 */
function timingLine({ model, ttftMs, usage, timings }) {
  const t = timings || {};
  const cached = Number.isFinite(t.cache_n) ? t.cache_n
    : (usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  const prompt = (usage && usage.prompt_tokens) || (Number.isFinite(t.prompt_n) ? t.prompt_n + cached : 0);
  const tps = Number.isFinite(t.predicted_per_second) ? t.predicted_per_second.toFixed(1) : 'n/a';
  const ttft = Number.isFinite(ttftMs) ? Math.round(ttftMs) : 'n/a';
  return `chat reply: model=${model || 'default'} prompt_tokens=${prompt} cached_tokens=${cached} ttft_ms=${ttft} tokens_per_s=${tps}`;
}

/** Turn one SSE `data:` payload into an event, or null to skip it. */
function parseData(data) {
  if (data === '[DONE]') return { done: true };
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const out = {};
  const choice = json.choices && json.choices[0];
  const delta = choice && choice.delta && choice.delta.content;
  if (typeof delta === 'string' && delta) out.delta = delta;
  // llama-server --reasoning-format deepseek sends a think model's reasoning here, not in content.
  const reasoning = choice && choice.delta && choice.delta.reasoning_content;
  if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
  const calls = choice && choice.delta && choice.delta.tool_calls;
  if (Array.isArray(calls) && calls.length) out.toolCalls = calls;
  if (json.usage) out.usage = json.usage;
  if (json.timings) out.timings = json.timings;
  return out.delta !== undefined || out.reasoning !== undefined || out.usage || out.toolCalls || out.timings ? out : null;
}

/**
 * Stream a chat completion from an OpenAI-style server.
 * Yields `{ delta }` per token, `{ reasoning }` for reasoning_content deltas (think models), `{ toolCalls }` (raw OpenAI `tool_calls` delta fragments, see
 * tools.js), `{ usage, timings }` when reported (llama-server's final chunk), and `{ done: true }` at the end.
 * `model` picks the model in llama-server's router mode; `cache_prompt` lets it reuse the KV cache.
 * Aborting `signal` rejects with the usual AbortError (not ChatUnavailableError).
 * @param {{ url: string, model?: string, messages: object[], signal?: AbortSignal, params?: object }} o
 * @returns {AsyncGenerator<{ delta?: string, toolCalls?: object[], done?: boolean, usage?: object, timings?: object }>}
 */
async function* streamChat({ url, model, messages, signal, params = {} }) {
  let res;
  try {
    res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...modelFields(model), messages, stream: true, ...params }),
      signal,
    });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw new ChatUnavailableError(`chat engine is not reachable: ${err.message}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ChatUnavailableError(`chat engine answered HTTP ${res.status}`, res.status);
  }

  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const evt = parseData(line.slice(5).trim());
        if (!evt) continue;
        yield evt;
        if (evt.done) return;
      }
    }
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw new ChatUnavailableError(`chat stream broke: ${err.message}`);
  }
  yield { done: true };
}

/**
 * One completion, returned as a single string. It streams internally on purpose: llama-server
 * cancels a streamed request as soon as the client disconnects, but keeps generating for a
 * non-streamed one until it hits max_tokens (checked live on b11429). So aborting `signal` really
 * frees the server. `params.response_format` is dropped and retried once if the server answers HTTP 400.
 * @param {{ url: string, model?: string, messages: object[], signal?: AbortSignal, params?: object }} o
 * @returns {Promise<string>}
 */
async function completeChat({ url, model, messages, signal, params = {} }) {
  const run = async (extra) => {
    let text = '';
    for await (const evt of streamChat({ url, model, messages, signal, params: extra })) {
      if (evt.delta) text += evt.delta;
    }
    return text;
  };
  try {
    return await run(params);
  } catch (err) {
    if (err instanceof ChatUnavailableError && err.status === 400 && params.response_format) {
      const { response_format: _dropped, ...rest } = params;
      return run(rest);
    }
    throw err;
  }
}

module.exports = { streamChat, completeChat, timingLine, ChatUnavailableError };
