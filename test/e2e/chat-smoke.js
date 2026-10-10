'use strict';
// E2E check: create a conversation, send one message, parse the SSE stream and
// assert at least one non-empty delta and a done event. Run from loopback.
// Usage: node test/e2e/chat-smoke.js [baseUrl]   (default http://127.0.0.1:3000)
const base = process.argv[2] || process.env.EMBERNEST_URL || 'http://127.0.0.1:3000';
const TIMEOUT_MS = Number(process.env.CHAT_SMOKE_TIMEOUT_MS) || 15 * 60 * 1000;

async function waitForChat() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/chat/status`);
      const s = res.ok ? await res.json() : {};
      if (s.enabled && s.running) return;
    } catch { /* server not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('chat never reported running: true');
}

async function main() {
  await waitForChat();
  const created = await fetch(`${base}/api/chat/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!created.ok) throw new Error(`create conversation: HTTP ${created.status}`);
  const { conversation } = await created.json();

  const res = await fetch(`${base}/api/chat/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Say hello in one short sentence.' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`send message: HTTP ${res.status} ${await res.text()}`);

  let buf = '';
  let reply = '';
  let done = false;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame.startsWith('data: ')) continue;
      const ev = JSON.parse(frame.slice(6));
      if (ev.error) throw new Error(`stream error: ${ev.error}`);
      if (typeof ev.delta === 'string') reply += ev.delta;
      if (ev.done) done = true;
    }
  }
  if (!reply.trim()) throw new Error('stream had no non-empty delta');
  if (!done) throw new Error('stream ended without a done event');
  console.log(`chat OK: ${reply.trim().length} characters streamed, done event received`);
}

main().catch((err) => {
  console.error(`chat smoke failed: ${err.message}`);
  process.exit(1);
});
