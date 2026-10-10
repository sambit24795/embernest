'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

// A valid 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const MODEL_FOLDERS = ['checkpoints', 'loras', 'vae', 'upscale_models', 'embeddings', 'controlnet',
  'background_removal', 'detection'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ComfyUI's current combo input format. */
const combo = (options) => ['COMBO', { options }];

/**
 * Start an in-process fake ComfyUI (HTTP + WebSocket at /ws) on a random port (or `port`).
 * Only the endpoints Embernest uses are implemented.
 * @param {{ checkpoints?: string[], loras?: string[], failPrompt?: boolean, port?: number }} [opts]
 * @returns {Promise<{ url: string, port: number, calls: string[], modelsDir: string, close: () => Promise<void> }>}
 */
async function startFakeComfy({ checkpoints = ['a.safetensors'], loras = [], failPrompt = false, port: listenPort = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-comfy-'));
  const modelsDir = path.join(root, 'models');
  for (const name of MODEL_FOLDERS) fs.mkdirSync(path.join(modelsDir, name), { recursive: true });
  fs.mkdirSync(path.join(root, 'output'), { recursive: true });

  const nodes = {
    CheckpointLoaderSimple: { ckpt_name: checkpoints },
    LoraLoader: { lora_name: loras },
    KSampler: {
      sampler_name: ['euler', 'dpmpp_2m'],
      scheduler: ['normal', 'karras'],
    },
    LoadBackgroundRemovalModel: { bg_removal_name: ['birefnet.safetensors'] },
    LoadMediaPipeFaceLandmarker: { model_name: ['mediapipe_face_fp32.safetensors'] },
  };
  const objectInfo = (name) => ({
    input: {
      required: Object.fromEntries(Object.entries(nodes[name]).map(([k, v]) => [k, combo(v)])),
    },
  });

  const calls = [];
  const history = {}; // prompt_id -> entry (insertion order = execution order)
  const queue = { running: [], pending: [] };
  const sockets = new Map(); // clientId -> WebSocket
  const sent = (ws, type, data) => ws.send(JSON.stringify({ type, data }));

  /** Play the execution of one prompt over the client's WebSocket. */
  async function execute(promptId, clientId) {
    // jobs.js connects its WebSocket only after /prompt returns; wait for it.
    for (let i = 0; i < 40 && !sockets.has(clientId); i += 1) await sleep(25);
    const ws = sockets.get(clientId);
    const live = () => ws && ws.readyState === 1;
    const base = { prompt_id: promptId };

    if (live()) sent(ws, 'execution_start', base);
    if (failPrompt) {
      const messages = [['execution_error', {
        node_id: '3', node_type: 'KSampler', exception_type: 'RuntimeError', exception_message: 'fake failure',
      }]];
      history[promptId] = { outputs: {}, status: { status_str: 'error', completed: false, messages } };
      if (live()) sent(ws, 'execution_error', { ...base, node_id: '3', node_type: 'KSampler', exception_message: 'fake failure' });
      return;
    }
    for (let value = 1; value <= 3; value += 1) {
      if (live()) sent(ws, 'progress', { ...base, node: '3', value, max: 3 });
      await sleep(10);
    }
    history[promptId] = {
      outputs: { 9: { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] } },
      status: { status_str: 'success', completed: true, messages: [] },
    };
    queue.running = queue.running.filter((e) => e[1] !== promptId);
    if (live()) {
      sent(ws, 'executing', { ...base, node: null });
      // Real ComfyUI also emits this; jobs.js waits for it.
      sent(ws, 'execution_success', base);
    }
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const json = (res, body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://fake');
    const p = u.pathname;
    if (p !== '/ws') calls.push(`${req.method} ${p}`);
    const body = req.method === 'POST' ? await readBody(req) : null;
    const parsed = () => { try { return JSON.parse(body.toString() || '{}'); } catch (_) { return {}; } };

    if (req.method === 'GET' && p === '/system_stats') {
      return json(res, { system: { os: 'fake', comfyui_version: '0.0.0-fake' }, devices: [] });
    }
    if (req.method === 'GET' && p === '/object_info') {
      return json(res, Object.fromEntries(Object.keys(nodes).map((n) => [n, objectInfo(n)])));
    }
    if (req.method === 'GET' && p.startsWith('/object_info/')) {
      const name = decodeURIComponent(p.slice('/object_info/'.length));
      return json(res, nodes[name] ? { [name]: objectInfo(name) } : {});
    }
    if (req.method === 'GET' && p === '/experiment/models') {
      return json(res, MODEL_FOLDERS.map((name) => ({
        name, folders: [path.join(modelsDir, name)], extensions: ['.safetensors'],
      })));
    }
    if (req.method === 'POST' && p === '/upload/image') {
      const text = body.toString('latin1');
      const name = (/filename="([^"]+)"/.exec(text) || [])[1] || 'upload.png';
      const subfolder = (/name="subfolder"\r\n\r\n([^\r]*)/.exec(text) || [])[1] || '';
      return json(res, { name, subfolder, type: 'input' });
    }
    if (req.method === 'POST' && p === '/prompt') {
      const { client_id: clientId } = parsed();
      const promptId = crypto.randomUUID();
      queue.running.push([1, promptId, parsed().prompt || {}, { client_id: clientId }]);
      execute(promptId, clientId).catch(() => {});
      return json(res, { prompt_id: promptId, number: 1, node_errors: {} });
    }
    if (req.method === 'GET' && p.startsWith('/history/')) {
      const id = decodeURIComponent(p.slice('/history/'.length));
      return json(res, history[id] ? { [id]: history[id] } : {});
    }
    if (req.method === 'GET' && p === '/history') return json(res, history);
    if (req.method === 'POST' && p === '/history') {
      for (const id of parsed().delete || []) delete history[id];
      return json(res, {});
    }
    if (req.method === 'GET' && p === '/queue') {
      return json(res, { queue_running: queue.running, queue_pending: queue.pending });
    }
    if (req.method === 'POST' && p === '/queue') {
      const del = new Set(parsed().delete || []);
      queue.pending = queue.pending.filter((e) => !del.has(e[1]));
      return json(res, {});
    }
    if (req.method === 'POST' && p === '/interrupt') return json(res, {});
    if (req.method === 'GET' && p === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG_1X1);
    }
    return json(res, { error: 'not found' }, 404);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const clientId = new URL(req.url, 'http://fake').searchParams.get('clientId');
    if (clientId) sockets.set(clientId, ws);
    ws.on('close', () => { if (sockets.get(clientId) === ws) sockets.delete(clientId); });
    ws.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    modelsDir,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { startFakeComfy, PNG_1X1 };
