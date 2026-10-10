'use strict';
// Stand-in for llama-server. Takes the real flags (--port N, -m FILE ...), loads
// "slowly" (503 on /health) for --load-ms, then answers 200. Used by supervisor tests.
const http = require('node:http');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const loadMs = Number(flag('--load-ms', 0));
const routerModel = flag('--router-model', '');
let ready = false;

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.statusCode = ready || routerModel ? 200 : 503;
    res.end(JSON.stringify({ status: ready ? 'ok' : 'loading model' }));
    return;
  }
  if (routerModel && req.url === '/models') {
    // Router mode: /health is 200 at once; the model itself loads later.
    res.end(JSON.stringify({ data: [{ id: routerModel, status: { value: ready ? 'loaded' : 'loading' } }, { id: 'other', status: { value: 'unloaded' } }] }));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(Number(flag('--port', 8189)), flag('--host', '127.0.0.1'), () => {
  console.log(`fake llama-server listening, args: ${args.join(' ')}`);
  setTimeout(() => { ready = true; console.log('fake llama ready'); }, loadMs);
});
