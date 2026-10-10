'use strict';
const http = require('node:http');

/**
 * In-process OpenAI-style streaming server (llama-server stand-in). It echoes the
 * last user message word by word as chat.completion.chunk events.
 * Extraction requests (they carry `response_format`; they stream like llama-server does) and
 * non-streaming requests (`stream: false`) get `completion`: a string, or `(body) => string`, as the message content.
 * Streaming requests can be scripted with `script: (body, n) => reply | undefined` (n = streaming request
 * number from 0). A reply is `{ content }` or `{ toolCalls: [{ name, arguments }] }` (arguments is a raw string);
 * tool calls are streamed in llama-server's real shape (first fragment has id + name + "{", later ones only
 * `index` + `function.arguments`, then a `finish_reason: "tool_calls"` chunk). A reply may also carry `reasoning`, streamed
 * first as `delta.reasoning_content`. `undefined` falls back to the echo.
 * @param {{ delayMs?: number, port?: number, healthy?: boolean, completion?: string|Function, script?: Function }} [opts]
 * @returns {Promise<{ url: string, port: number, requests: object[], aborted: () => number, close: () => Promise<void> }>}
 */
const sse = (choice, extra = {}) => `data: ${JSON.stringify({ choices: [choice], ...extra })}\n\n`;

/** Stream a scripted reply the way llama-server b11429 does. */
function sendScripted(res, { content, toolCalls, reasoning }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(sse({ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }));
  // Reasoning in its own field, as llama-server sends it with --reasoning-format deepseek.
  if (reasoning) {
    for (const word of String(reasoning).split(/(?<= )/)) res.write(sse({ finish_reason: null, index: 0, delta: { reasoning_content: word } }));
  }
  if (toolCalls) {
    toolCalls.forEach((call, index) => {
      const args = call.arguments;
      const cut = Math.max(1, Math.floor(args.length / 2));
      const first = { index, id: `call${index}`, type: 'function', function: { name: call.name, arguments: args.slice(0, cut) } };
      res.write(sse({ finish_reason: null, index: 0, delta: { tool_calls: [first] } }));
      res.write(sse({ finish_reason: null, index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(cut) } }] } }));
    });
    res.write(sse({ finish_reason: 'tool_calls', index: 0, delta: {} }));
  } else {
    for (const word of String(content).split(/(?<= )/)) res.write(sse({ finish_reason: null, index: 0, delta: { content: word } }));
    res.write(sse({ finish_reason: 'stop', index: 0, delta: {} }));
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function startFakeLlm({ delayMs = 0, port: listenPort = 0, healthy = true, completion = '{}', script = null } = {}) {
  const requests = [];
  let aborted = 0;
  let streams = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = healthy ? 200 : 503;
      return res.end(JSON.stringify({ status: healthy ? 'ok' : 'loading model' }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      return res.end();
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (body.stream === false) {
        const content = typeof completion === 'function' ? completion(body) : completion;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content } }] }));
      }
      if (body.response_format) return sendScripted(res, { content: typeof completion === 'function' ? completion(body) : completion });
      const scripted = script ? script(body, streams) : undefined;
      streams++;
      if (scripted) return sendScripted(res, scripted);
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const words = String(lastUser ? lastUser.content : '').split(/\s+/).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let i = 0;
      let closed = false;
      res.on('close', () => { if (!res.writableFinished) { closed = true; aborted++; } });
      const chunk = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
      const tick = () => {
        if (closed) return;
        if (i < words.length) {
          res.write(chunk({ content: `${i ? ' ' : ''}${words[i++]}` }));
          setTimeout(tick, delayMs);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: words.length }, timings: { cache_n: 0, prompt_n: 1, predicted_n: words.length, predicted_per_second: 10 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      };
      res.write(chunk({ role: 'assistant' }));
      tick();
      return undefined;
    });
    return undefined;
  });
  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    aborted: () => aborted,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

module.exports = { startFakeLlm };
