'use strict';
const path = require('node:path');
const ui = require('../ui');

/**
 * Register `embernest setup`.
 * @param {import('commander').Command} program
 */
function register(program) {
  program
    .command('setup')
    .description('Detect hardware and install everything Embernest needs')
    .option('--yes', 'do not ask for confirmation')
    .option('--dry-run', 'show the plan and what would run, then stop')
    .option('--gpu <vendor>', 'override the detected GPU: nvidia, amd, apple, intel or cpu')
    .option('--no-models', 'do not download models')
    .option('--starter', 'also download the starter checkpoint for this machine (CLI and headless installs)')
    .option('--no-starter', 'no starter checkpoint (this is the default now; kept so old scripts still work)')
    .option('--port <n>', 'Embernest web app port', (v) => Number.parseInt(v, 10))
    .option('--no-lan', 'only listen on this computer, not the local network')
    .option('--comfy-dir <dir>', 'use your own ComfyUI folder instead of installing one')
    .option('--comfy-python <path>', 'python that runs your own ComfyUI (with --comfy-dir)')
    .option('--comfy-url <url>', 'use a ComfyUI that is already running at this URL')
    .option('--chat', 'add the local chat companion (llama.cpp + a model for this machine)')
    .option('--no-chat', 'do not add the chat companion, and turn it off')
    .option('--chat-model <id>', 'chat model to install (an id from the manifest); implies --chat')
    .option('--chat-think', 'also add a "Think harder" reasoning model for tricky questions')
    .option('--no-chat-think', 'do not add a Think harder model, and clear the saved one')
    .option('--chat-think-model <id>', 'think model to install (an id from the manifest)')
    .option('--import-config <path>', 'import settings and tokens from a v0.1 config.json')
    .action(async (options) => {
      const { runSetup } = require('../../install/setup');
      const { ok, summary } = await runSetup(options);
      if (!ok) {
        if (summary.cancelled) ui.info('Cancelled, nothing was changed.');
        process.exitCode = 1;
        return;
      }
      if (options.dryRun) return;
      ui.ok('Embernest is ready.');
      ui.info('  Start it:   embernest start');
      if (!options.starter) ui.info('  First model: pick your first model in the app (Models → Suggested), or re-run setup with --starter');
      ui.info('  Phone:      embernest start  (scan the QR code)');
    });
}

/** Resolve --home before anything reads paths. */
function applyHome(opts) {
  if (opts.home) process.env.EMBERNEST_HOME = path.resolve(opts.home);
}

module.exports = { register, applyHome };
