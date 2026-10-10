'use strict';
const jobs = require('./jobs');
const { buildTxt2ImgWorkflow, clampSize } = require('./workflow');
const { toNum, DEFAULT_NEGATIVE } = require('./util');

const NO_CHECKPOINT = { error: 'No checkpoint installed in ComfyUI/models/checkpoints' };

/** A request the caller can answer as-is: HTTP status plus JSON body. */
class GenerateError extends Error {
  constructor(status, payload) {
    super(payload.error);
    this.name = 'GenerateError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Start a txt2img job with the tier defaults (sizes clamped to the plan's maxSize).
 * Shared by POST /api/generate and the chat `generate_image` tool.
 * Body: { prompt|positive, negative, width, height, steps, cfg, sampler, scheduler, seed, checkpoint, loraName, loraStrength }
 * @param {{ comfy: Function, getConfig: Function, getPlan: Function }} ctx
 * @param {object} [body]
 * @returns {Promise<object>} the job snapshot
 * @throws {GenerateError} for 409/400 problems (no or unknown checkpoint)
 */
async function startGenerate(ctx, body = {}) {
  const client = ctx.comfy();
  const checkpoints = await client.listCheckpoints();
  const checkpoint = body.checkpoint || checkpoints[0];

  if (!checkpoint) throw new GenerateError(409, NO_CHECKPOINT);
  if (!checkpoints.includes(checkpoint)) {
    throw new GenerateError(400, { error: `Unknown checkpoint "${checkpoint}"`, checkpoints });
  }

  const { plan } = await ctx.getPlan();
  const maxSize = plan.image.maxSize;
  const defaults = ctx.getConfig().defaults;

  const inputs = {
    checkpoint,
    positive: body.prompt || body.positive || '',
    negative: body.negative || DEFAULT_NEGATIVE,
    width: clampSize(body.width != null ? body.width : maxSize, maxSize),
    height: clampSize(body.height != null ? body.height : maxSize, maxSize),
    maxSize,
    steps: Math.round(toNum(body.steps, defaults.steps)),
    cfg: toNum(body.cfg, defaults.cfg),
    sampler: body.sampler || defaults.sampler,
    scheduler: body.scheduler || defaults.scheduler,
    seed: Math.round(toNum(body.seed, defaults.seed)),
    loraName: body.loraName || '',
    loraStrength: toNum(body.loraStrength, 1.0),
    timeout: 900000,
  };

  return jobs.startJob({ kind: 'generate', client, inputs, buildWorkflow: buildTxt2ImgWorkflow });
}

module.exports = { startGenerate, GenerateError };
