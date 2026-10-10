'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const brand = require('../brand');
const { loadConfig } = require('../core/config');
const { run } = require('../core/exec');
const { detectHardware } = require('../core/hardware');
const { getLanIps, isPortFree } = require('../core/net');
const { isWindows } = require('../core/platform');
const { readJson } = require('../core/state');
const { planForHardware } = require('../core/tiers');
const { getManifest } = require('../install/manifest');
const { planModels, missingModels } = require('../install/models');
const { probeTorch, EXPECTED_DEVICE } = require('../install/torch');
const { uvVersion } = require('../install/uv');
const { venvVersion } = require('../install/python');
const { MARKER } = require('../install/comfyui');
const { pidAlive, healthy, firewallHint } = require('./server-runner');
const { warmup } = require('../server/safety');
const { chatInstall } = require('./llm-supervisor');

const MIN_NODE_MAJOR = 22;
const MIN_FREE_DISK_GB = 15;
const CHECKPOINT_EXT = /\.(safetensors|ckpt|pt|pth|gguf)$/i;

const ok = (id, message, hint = '') => ({ id, status: 'ok', message, hint });
const warn = (id, message, hint = '') => ({ id, status: 'warn', message, hint });
const fail = (id, message, hint = '') => ({ id, status: 'fail', message, hint });

/** @param {object} f facts @returns {boolean} */
const isExternal = (f) => f.cfg.comfy.mode === 'external';

// ---- pure checks: (facts) => result | null (null = does not apply) ----

/** Node version must be >= 22. */
function checkNode(f) {
  const major = Number(String(f.nodeVersion).split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? ok('node', `Node ${f.nodeVersion}`)
    : fail('node', `Node ${f.nodeVersion} is too old (need ${MIN_NODE_MAJOR}+)`,
      'Install Node 22 or newer, or re-run the Embernest install script (it bundles Node)');
}

/** Data folder must be writable. */
function checkDataFolder(f) {
  return f.homeWritable
    ? ok('data-folder', `${f.paths.home} is writable`)
    : fail('data-folder', `${f.paths.home} is not writable`, 'Fix its permissions, or pick another folder with --home');
}

/** Free disk >= 15 GB. */
function checkDisk(f) {
  if (!(f.freeDiskGB > 0)) return warn('disk', 'free disk space could not be determined');
  return f.freeDiskGB >= MIN_FREE_DISK_GB
    ? ok('disk', `${f.freeDiskGB} GB free`)
    : warn('disk', `only ${f.freeDiskGB} GB free (need about ${MIN_FREE_DISK_GB} GB)`,
      'Free some disk space, or move Embernest with --home <other folder>');
}

/**
 * Setup is complete when the steps that always leave a record (config, verify)
 * are in run/setup.json. The other steps are checked against real state below
 * (steps that were already done are not re-recorded).
 */
function checkSetup(f) {
  const missing = ['config', 'verify'].filter((id) => !f.setupSteps[id]);
  return missing.length
    ? fail('setup', `setup has not completed (missing: ${missing.join(', ')})`, 'Run: embernest setup')
    : ok('setup', 'setup completed');
}

/** The managed uv binary runs and matches the manifest. */
function checkUv(f) {
  if (isExternal(f)) return null;
  if (!f.uvVersion) return fail('uv', `uv does not run (${f.paths.uv})`, 'Run: embernest setup');
  return f.uvVersion === f.manifest.uv.version
    ? ok('uv', `uv ${f.uvVersion}`)
    : warn('uv', `uv ${f.uvVersion}, expected ${f.manifest.uv.version}`, 'Run: embernest setup');
}

/** The venv python runs (managed), or the external python can import torch. */
function checkPython(f) {
  if (isExternal(f)) {
    if (!f.cfg.comfy.python) return null;
    return f.externalTorchOk
      ? ok('python', `${f.cfg.comfy.python} can import torch`)
      : fail('python', `${f.cfg.comfy.python} cannot import torch`,
        'Re-run `embernest setup --comfy-dir <dir> --comfy-python <python>` with the python that runs your ComfyUI');
  }
  return f.venvVersion
    ? ok('python', `Python ${f.venvVersion} in the venv`)
    : fail('python', `the venv python does not run (${f.paths.venvPython})`, 'Run: embernest setup');
}

/** Driver hint per GPU vendor and OS. */
function torchHint(vendor, plat) {
  if (vendor === 'nvidia') return 'Update the NVIDIA driver, then run: embernest setup';
  if (vendor === 'amd' && plat === 'linux') {
    return 'Install ROCm; some cards need HSA_OVERRIDE_GFX_VERSION (e.g. 10.3.0 or 11.0.0). Then run: embernest setup';
  }
  if (vendor === 'amd') return 'Update the AMD driver, then run: embernest setup';
  return 'Run: embernest setup';
}

/** probeTorch's device must match what the tier planned. */
function checkTorch(f) {
  if (isExternal(f) || !f.venvVersion) return null;
  if (!f.torch) return fail('torch', 'PyTorch cannot be imported in the venv', 'Run: embernest setup');
  const vendor = (f.cfg.hardware.gpu || {}).vendor || 'none';
  const backend = f.plan ? f.plan.torch.backend : 'cpu';
  const want = EXPECTED_DEVICE[backend];
  return f.torch.device === want
    ? ok('torch', `PyTorch ${f.torch.torch} on ${f.torch.device} (${f.torch.name})`)
    : fail('torch', `PyTorch ${f.torch.torch} uses "${f.torch.device}" but this machine needs "${want}"`,
      torchHint(vendor, f.platform));
}

/** GPU still the one setup saw. */
function checkHardware(f) {
  const saved = f.cfg.hardware || {};
  if (!saved.gpu) return warn('hardware', 'no hardware recorded', 'Run: embernest setup');
  const key = (g) => `${g.vendor}|${g.name || ''}`;
  const was = saved.gpu;
  const now = f.hw.gpu;
  return key(was) === key(now)
    ? ok('hardware', `GPU unchanged: ${now.name || now.vendor}`)
    : warn('hardware', `GPU changed: was ${was.name || was.vendor}, now ${now.name || now.vendor}`,
      'Run: embernest setup (PyTorch may need to change)');
}

/** ComfyUI folder exists and matches the manifest. */
function checkComfy(f) {
  const dir = f.cfg.comfy.dir;
  if (isExternal(f)) {
    if (!dir) return null;
    return f.comfyMain
      ? ok('comfyui', `external ComfyUI at ${dir}`)
      : fail('comfyui', `no main.py in ${dir}`, 'Run `embernest setup --comfy-dir <your ComfyUI folder>`');
  }
  if (!f.comfyMain || !f.comfyMarker) {
    return fail('comfyui', `ComfyUI is not installed at ${dir}`, 'Run: embernest setup');
  }
  const have = f.cfg.comfy.version;
  const want = f.manifest.comfyui.tag;
  return have === want
    ? ok('comfyui', `ComfyUI ${have}`)
    : warn('comfyui', `ComfyUI ${have || 'unknown'}, this Embernest expects ${want}`, 'Run: embernest update engine');
}

/** Models the manifest requires. */
function checkModels(f) {
  if (!f.modelsDir) return null;
  return f.missingModels.length
    ? fail('models', `missing: ${f.missingModels.map((m) => `${m.folder}/${m.file}`).join(', ')}`,
      'Run: embernest setup (downloads only the missing files)')
    : ok('models', 'required models present');
}

/** The photo-edit safety model loads from the local cache (edits are blocked without it). */
function checkSafety(f) {
  if (brand.getEnv('NO_SAFETY') === '1') {
    return ok('safety', 'safety checks disabled for testing');
  }
  if (!f.safety) return null;
  return f.safety.ok
    ? ok('safety', `photo-edit safety model ready (${f.manifest.safety.repo})`)
    : fail('safety', `photo-edit safety model cannot load${f.safety.error ? `: ${f.safety.error}` : ''}`,
      'Run: embernest setup (edits and transforms stay blocked until it works)');
}

/** At least one checkpoint to generate with. */
function checkCheckpoint(f) {
  if (!f.modelsDir) return null;
  return f.checkpointCount > 0
    ? ok('checkpoint', `${f.checkpointCount} checkpoint${f.checkpointCount === 1 ? '' : 's'} found`)
    : warn('checkpoint', 'no checkpoint found', 'Run: embernest models pull <url> --type checkpoint, or use the Models tab');
}

/** Engine reachable (when running) and has every required node. */
function checkEngine(f) {
  const e = f.engine;
  if (!e.reachable) {
    if (f.running) {
      return fail('engine', `Embernest is running but ComfyUI is not reachable (${e.error || 'no answer'})`,
        'Check: embernest logs engine');
    }
    return ok('engine', 'engine not running (required nodes are checked while it runs)');
  }
  const missing = f.manifest.comfyui.requiredNodes.filter((n) => !(e.nodes || []).includes(n));
  return missing.length
    ? fail('engine', `ComfyUI is missing nodes: ${missing.join(', ')}`, 'Run: embernest update engine')
    : ok('engine', 'ComfyUI reachable, all required nodes present');
}

/** Ports free, or owned by us. */
function checkPorts(f) {
  const { server, comfy } = f.ports;
  const problems = [];
  if (!f.running && !server.free) problems.push(`port ${server.port} (web app) is in use`);
  if (!f.running && comfy.local && !comfy.free && !isExternal(f)) problems.push(`port ${comfy.port} (engine) is in use`);
  if (problems.length) {
    return fail('ports', `${problems.join('; ')} by another program`,
      `Change \`port\` or \`comfy.port\` in ${f.paths.config}, or stop the other program`);
  }
  return ok('ports', f.running ? `in use by Embernest (${server.port}, ${comfy.port})` : `${server.port} and ${comfy.port} are free`);
}

/** LAN: address found, with the firewall hint for this OS. */
function checkLan(f) {
  if (!f.cfg.listenOnLan) return ok('lan', 'LAN access is off (phone pairing needs it)');
  if (!f.lanIps.length) return warn('lan', 'LAN access is on but no network address was found', 'Connect to Wi-Fi or Ethernet');
  return ok('lan', `phone URL http://${f.lanIps[0].address}:${f.cfg.port}`,
    `If the phone cannot connect, open the port: ${firewallHint(f.cfg.port, f.platform).join(' | ')}`);
}

/** config.json holds secrets: owner-only on POSIX. */
function checkConfigMode(f) {
  if (f.platform === 'win32' || f.configMode === null) return null;
  return (f.configMode & 0o077) === 0
    ? ok('config-mode', 'config.json is owner-only')
    : warn('config-mode', `config.json is readable by others (mode ${f.configMode.toString(8)})`, `chmod 600 ${f.paths.config}`);
}

/**
 * Chat engine (only when chat is enabled): llama-server installed and runs, the
 * model file is whole, and /health answers while Embernest is running.
 */
function checkChat(f) {
  if (!f.cfg.chat || !f.cfg.chat.enabled || !f.chat) return null;
  const c = f.chat;
  const fix = 'Run: embernest setup --chat';
  if (!c.model) return fail('chat', `chat model "${f.cfg.chat.model}" is not in this Embernest's model list`, fix);
  if (!c.bin) return fail('chat', 'the chat engine (llama-server) is not installed', fix);
  if (!c.version) return fail('chat', `llama-server does not run (${c.bin})`, fix);
  if (c.modelBytes === null) return fail('chat', `chat model file is missing (${c.modelFile})`, fix);
  // Manifest sizeMB is decimal megabytes (Hugging Face's size), rounded.
  if (c.modelBytes < c.model.sizeMB * 1e6 * 0.99) {
    return fail('chat', `chat model file is incomplete (${Math.round(c.modelBytes / 1e6)} of ${c.model.sizeMB} MB)`,
      `Delete ${c.modelFile}, then: embernest setup --chat`);
  }
  if (f.running && !c.healthOk) {
    return fail('chat', `Embernest is running but the chat engine does not answer on ${f.cfg.chat.url}/health`,
      'Check: embernest logs chat');
  }
  if (f.running && c.defaultLoaded === false) {
    return fail('chat', `the chat engine answers, but the default model (${c.model.id}) is not loaded`, 'Check: embernest logs chat');
  }
  const loaded = f.running && c.defaultLoaded ? ', default model loaded' : '';
  return ok('chat', `${c.version}, ${c.model.label}${f.running ? `, /health ok${loaded}` : ''}`);
}

const CHECKS = [checkNode, checkDataFolder, checkDisk, checkSetup, checkUv, checkPython, checkTorch, checkHardware,
  checkComfy, checkModels, checkSafety, checkCheckpoint, checkEngine, checkPorts, checkLan, checkConfigMode, checkChat];

/**
 * Run every check against injected facts.
 * @param {object} facts from gatherFacts() (or hand-made in tests)
 * @returns {Array<{ id: string, status: 'ok'|'warn'|'fail', message: string, hint: string }>}
 */
function runChecks(facts) {
  return CHECKS.map((check) => {
    try {
      return check(facts);
    } catch (err) {
      return fail(check.name.replace(/^check/, '').toLowerCase(), `check crashed: ${err.message}`);
    }
  }).filter(Boolean);
}

// ---- fact gathering (touches disk, processes and the network) ----

async function listCheckpoints(dir) {
  try {
    const entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile() && CHECKPOINT_EXT.test(e.name)).length;
  } catch (_) {
    return 0;
  }
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** GET <url>/object_info; never throws. */
async function fetchEngine(url, fetchFn) {
  try {
    const res = await fetchFn(`${url}/object_info`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    return { reachable: true, nodes: Object.keys(await res.json()) };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

function urlPort(url, fallback) {
  try {
    return Number(new URL(url).port) || fallback;
  } catch (_) {
    return fallback;
  }
}

/** Load the pinned safety model offline with the engine's python; never throws. */
async function gatherSafety(paths, cfg, manifest) {
  if (brand.getEnv('NO_SAFETY') === '1') {
    return { ok: true }; // skip loading when disabled
  }
  const python = cfg.comfy.mode === 'external' ? cfg.comfy.python : paths.venvPython;
  if (!python) return { ok: false, error: 'no Python configured' };
  try {
    await warmup(paths, python, manifest.safety, { offline: true, timeoutMs: 120000 });
    return { ok: true };
  } catch (err) {
    const tail = String(err.stderr || err.message).trim().split('\n').pop();
    return { ok: false, error: tail.slice(0, 200) };
  }
}

/** Router mode: is the default model loaded (GET /models)? null when the server has no such endpoint. */
async function defaultModelLoaded(cfg, id, fetchFn) {
  try {
    const res = await fetchFn(`${cfg.chat.url}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const entry = ((await res.json()).data || []).find((m) => m.id === id);
    return entry && entry.status ? entry.status.value === 'loaded' : null;
  } catch (_) {
    return null;
  }
}

/** Chat engine facts: binary, its version, model file size, /health. Never throws. */
async function gatherChat(paths, cfg, manifest, running, fetchFn) {
  const { model, bin, gguf } = chatInstall(paths, cfg, manifest);
  const out = { model, bin, version: null, modelFile: gguf, modelBytes: null, healthOk: false, defaultLoaded: null };
  if (bin) {
    const res = await run(bin, ['--version'], { timeoutMs: 30000 }).catch(() => null);
    const line = res && `${res.stdout}\n${res.stderr}`.split('\n').find((l) => /^version:/i.test(l.trim()));
    out.version = line ? `llama-server ${line.trim().replace(/^version:\s*/i, '')}` : null;
  }
  try {
    out.modelBytes = gguf ? fs.statSync(gguf).size : null;
  } catch (_) {
    out.modelBytes = null;
  }
  if (running) {
    out.healthOk = await fetchFn(`${cfg.chat.url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (out.healthOk && model) out.defaultLoaded = await defaultModelLoaded(cfg, model.id, fetchFn);
  }
  return out;
}

/**
 * Collect everything the checks need. Reuses the install/runtime probes.
 * @param {Record<string, string>} paths
 * @param {{ fetch?: Function, detect?: Function }} [deps]
 * @returns {Promise<object>}
 */
async function gatherFacts(paths, { fetch: fetchFn = fetch, detect = detectHardware } = {}) {
  const cfg = loadConfig(paths);
  const manifest = getManifest();
  const external = cfg.comfy.mode === 'external';
  const hw = await detect({ dataDir: paths.home });
  const state = readJson(paths.state, null);
  const running = Boolean(state) && pidAlive(state.pid) && await healthy(state.port);
  const comfyDir = cfg.comfy.dir;
  const modelsDir = external ? (comfyDir ? path.join(comfyDir, 'models') : null) : paths.models;
  const plan = (cfg.hardware || {}).gpu ? planForHardware(cfg.hardware) : null;

  const facts = {
    platform: process.platform, nodeVersion: process.versions.node, paths, cfg, manifest, hw, plan, running,
    homeWritable: writable(paths.home), freeDiskGB: hw.freeDiskGB,
    setupSteps: (readJson(paths.setupState, {}) || {}).steps || {},
    comfyMain: Boolean(comfyDir) && fs.existsSync(path.join(comfyDir, 'main.py')),
    comfyMarker: Boolean(comfyDir) && fs.existsSync(path.join(comfyDir, MARKER)),
    modelsDir, missingModels: [], checkpointCount: 0,
    lanIps: getLanIps(),
    configMode: isWindows() || !fs.existsSync(paths.config) ? null : fs.statSync(paths.config).mode & 0o777,
    uvVersion: null, venvVersion: null, torch: null, externalTorchOk: false,
  };

  if (external) {
    if (cfg.comfy.python) {
      facts.externalTorchOk = await run(cfg.comfy.python, ['-c', 'import torch'], { timeoutMs: 120000 })
        .then(() => true, () => false);
    }
  } else {
    facts.uvVersion = await uvVersion(paths.uv);
    facts.venvVersion = await venvVersion(paths);
    if (facts.venvVersion) facts.torch = await probeTorch(paths).catch(() => null);
  }
  if (modelsDir) {
    facts.missingModels = await missingModels(paths, planModels(manifest, 'low', { includeStarter: false }), { modelsDir });
    facts.checkpointCount = await listCheckpoints(path.join(modelsDir, 'checkpoints'));
  }

  facts.safety = await gatherSafety(paths, cfg, manifest);
  facts.chat = cfg.chat.enabled ? await gatherChat(paths, cfg, manifest, running, fetchFn) : null;

  const comfyPort = cfg.comfy.port || urlPort(cfg.comfy.url, 8188);
  const local = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])/i.test(cfg.comfy.url);
  facts.engine = await fetchEngine(cfg.comfy.url.replace(/\/+$/, ''), fetchFn);
  facts.ports = {
    server: { port: cfg.port, free: running ? false : await isPortFree(cfg.port, cfg.listenOnLan ? '0.0.0.0' : '127.0.0.1') },
    comfy: { port: comfyPort, local, free: running || !local ? false : await isPortFree(comfyPort, '127.0.0.1') },
  };
  return facts;
}

/**
 * Gather facts and run all checks.
 * @param {Record<string, string>} paths
 * @param {object} [deps] see gatherFacts
 * @returns {Promise<{ ok: boolean, checks: Array<object> }>}
 */
async function runDoctor(paths, deps) {
  const checks = runChecks(await gatherFacts(paths, deps));
  return { ok: !checks.some((c) => c.status === 'fail'), checks };
}

module.exports = { runDoctor, runChecks, gatherFacts, CHECKS, torchHint };
