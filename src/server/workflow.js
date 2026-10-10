/**
 * workflow.js — build the proven ComfyUI inpainting graph.
 *
 * The graph (18 nodes, per the plan / the validated Python script) does:
 *
 *   LoadImage
 *     -> ImageScale (downscale to maxSize, multiple of 8)         [optional]
 *     -> LoadBackgroundRemovalModel -> RemoveBackground           (person MASK)
 *     -> LoadMediaPipeFaceLandmarker -> MediaPipeFaceLandmarker
 *        -> MediaPipeFaceMask -> GrowMask(face)
 *        -> MaskComposite(subtract)                               (body MASK)
 *     -> GrowMask(body)
 *     -> CheckpointLoaderSimple -> CLIPTextEncode(+/-)
 *        -> VAEEncodeForInpaint -> KSampler -> VAEDecode
 *     -> ImageScale (restore original size)                       [optional]
 *     -> SaveImage
 *
 * Two hard-won rules baked in:
 *   - SD 1.5 quality collapses above ~768px, so we downscale before sampling
 *     and scale the result back up to the original size.
 *   - A whole-person mask destroys identity on person edits, so we always
 *     subtract the (grown) MediaPipe face mask from the person mask.
 *
 * The returned object is plain ComfyUI API-format prompt JSON.
 */
'use strict';

/**
 * Work out the downscaled dimensions for a given maxSize.
 * Returns null when no downscale is needed (or dimensions are unknown).
 * Sizes are floored to a multiple of 8, as diffusion latent grids require.
 */
function computeScale(width, height, maxSize) {
  if (!maxSize || width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  if (longest <= maxSize) return null;
  const ratio = maxSize / longest;
  const w = Math.max(8, Math.floor((width * ratio) / 8) * 8);
  const h = Math.max(8, Math.floor((height * ratio) / 8) * 8);
  return { width: w, height: h };
}

/**
 * Clamp a requested dimension to `maxSize` and snap it to a multiple of 8.
 * EmptyLatentImage requires multiples of 8; SD 1.5 collapses above ~768px, so
 * `maxSize` is a hard ceiling (gotcha in section 8).
 */
function clampSize(value, maxSize) {
  const n = Math.round(Number(value));
  const safe = Number.isFinite(n) && n > 0 ? n : maxSize;
  const capped = Math.min(safe, maxSize);
  return Math.max(64, Math.round(capped / 8) * 8);
}

/**
 * Random seed covering ComfyUI's full unsigned 64-bit range (0 .. 2^64-1).
 * Returned as a STRING because JS Numbers lose precision above 2^53, and
 * ComfyUI coerces INT inputs with int(value), which accepts numeric strings.
 */
function randomSeed() {
  const hi = BigInt(Math.floor(Math.random() * 0x100000000)); // 32 bits
  const lo = BigInt(Math.floor(Math.random() * 0x100000000)); // 32 bits
  return ((hi << 32n) | lo).toString();
}

/**
 * Build the inpainting workflow.
 *
 * @param {object} o
 * @param {string} o.imageName          File name already uploaded to ComfyUI input.
 * @param {string} o.checkpoint         ckpt_name (from CheckpointLoaderSimple).
 * @param {string} o.bgRemovalModel     bg_removal_name (BiRefNet, in models/background_removal).
 * @param {string} [o.faceModel]        model_name (MediaPipe face, in models/detection).
 * @param {string} [o.positive]         Positive prompt.
 * @param {string} [o.negative]         Negative prompt.
 * @param {number} [o.width]            Original image width  (for scale/restore).
 * @param {number} [o.height]           Original image height (for scale/restore).
 * @param {number} [o.maxSize=768]       Longest side to sample at (0 = keep).
 * @param {boolean} [o.preserveFace=true] Subtract the face mask (needs faceModel).
 * @param {boolean} [o.restoreSize=true]  Scale result back to original size.
 * @param {number} [o.denoise=0.9]
 * @param {number} [o.steps=28]
 * @param {number} [o.cfg=7]
 * @param {string} [o.sampler='dpmpp_2m']
 * @param {string} [o.scheduler='karras']
 * @param {number} [o.seed=-1]           -1 = random.
 * @param {number} [o.growMask=10]       Grow the body mask by N px.
 * @param {number} [o.faceExpand=40]     Grow the face mask by N px before subtracting.
 * @param {number} [o.growMaskBy=6]      VAEEncodeForInpaint grow_mask_by.
 * @param {string} [o.filenamePrefix='embernest']
 * @returns {object} ComfyUI API-format workflow
 */
function buildInpaintWorkflow(o = {}) {
  const {
    imageName,
    checkpoint,
    bgRemovalModel,
    faceModel = null,
    positive = '',
    negative = '',
    width = 0,
    height = 0,
    maxSize = 768,
    preserveFace = true,
    restoreSize = true,
    denoise = 0.9,
    steps = 28,
    cfg = 7,
    sampler = 'dpmpp_2m',
    scheduler = 'karras',
    seed = -1,
    loraName = '',
    loraStrength = 1.0,
    growMask = 10,
    faceExpand = 90,
    growMaskBy = 6,
    filenamePrefix = 'embernest',
  } = o;

  if (!imageName) throw new Error('buildInpaintWorkflow: imageName is required');
  if (!checkpoint) throw new Error('buildInpaintWorkflow: checkpoint is required');
  if (!bgRemovalModel) throw new Error('buildInpaintWorkflow: bgRemovalModel is required');

  const workflow = {};
  const add = (id, class_type, inputs, title) => {
    workflow[id] = { class_type, inputs };
    if (title) workflow[id]._meta = { title };
  };

  // 1. Load the uploaded image from ComfyUI's input folder.
  add('1', 'LoadImage', { image: imageName }, 'Load Image');
  let imageRef = ['1', 0];

  // 2. Optional downscale (SD 1.5 collapses above ~768px).
  const scale = computeScale(width, height, maxSize);
  if (scale) {
    add('2', 'ImageScale', {
      image: imageRef,
      upscale_method: 'lanczos',
      width: scale.width,
      height: scale.height,
      crop: 'disabled',
    }, `Downscale to ${scale.width}x${scale.height}`);
    imageRef = ['2', 0];
  }

  // 3-4. Remove the background -> person mask.
  add('3', 'LoadBackgroundRemovalModel', { bg_removal_name: bgRemovalModel }, 'Load Background Removal Model');
  add('4', 'RemoveBackground', {
    bg_removal_model: ['3', 0],
    image: imageRef,
  }, 'Remove Background (person mask)');
  let maskRef = ['4', 0];

  // 5-9. Face detection -> face mask -> grow -> subtract from person mask.
  // Without this the whole person (including the face) is regenerated and
  // identity is destroyed.
  if (preserveFace && faceModel) {
    add('5', 'LoadMediaPipeFaceLandmarker', { model_name: faceModel }, 'Load Face Landmarker');
    add('6', 'MediaPipeFaceLandmarker', {
      face_detection_model: ['5', 0],
      image: imageRef,
      detector_variant: 'short',
      num_faces: 3,
      min_confidence: 0.5,
      missing_frame_fallback: 'empty',
    }, 'Detect Face Landmarks');
    add('7', 'MediaPipeFaceMask', {
      face_landmarks: ['6', 0],
      regions: 'all',
    }, 'Face Mask');
    add('8', 'GrowMask', {
      mask: ['7', 0],
      expand: faceExpand,
      tapered_corners: true,
    }, `Grow Face Mask (+${faceExpand}px)`);
    add('9', 'MaskComposite', {
      destination: maskRef,
      source: ['8', 0],
      x: 0,
      y: 0,
      operation: 'subtract',
    }, 'Person Mask minus Face');
    maskRef = ['9', 0];
  }

  // 10. Grow the body mask so the seam blends into the kept regions.
  add('10', 'GrowMask', {
    mask: maskRef,
    expand: growMask,
    tapered_corners: true,
  }, `Grow Body Mask (+${growMask}px)`);

  // 11. Checkpoint -> MODEL, CLIP, VAE.
  add('11', 'CheckpointLoaderSimple', { ckpt_name: checkpoint }, 'Load Checkpoint');

  // 11b. Optional LoRA applied on top of the checkpoint (node 19 = free id).
  let modelRef = ['11', 0];
  let clipRef = ['11', 1];
  if (loraName) {
    add('19', 'LoraLoader', {
      model: modelRef,
      clip: clipRef,
      lora_name: loraName,
      strength_model: loraStrength,
      strength_clip: loraStrength,
    }, `LoRA ${loraName}`);
    modelRef = ['19', 0];
    clipRef = ['19', 1];
  }

  // 12-13. Text conditioning.
  add('12', 'CLIPTextEncode', { text: positive, clip: clipRef }, 'Positive Prompt');
  add('13', 'CLIPTextEncode', { text: negative, clip: clipRef }, 'Negative Prompt');

  // 14. Encode the (scaled) image + mask to a latent for inpainting.
  add('14', 'VAEEncodeForInpaint', {
    pixels: imageRef,
    vae: ['11', 2],
    mask: ['10', 0],
    grow_mask_by: growMaskBy,
  }, 'VAE Encode for Inpaint');

  // 15. Sample.
  add('15', 'KSampler', {
    model: modelRef,
    seed: seed >= 0 ? Math.floor(seed) : randomSeed(),
    steps,
    cfg,
    sampler_name: sampler,
    scheduler,
    positive: ['12', 0],
    negative: ['13', 0],
    latent_image: ['14', 0],
    denoise,
  }, 'KSampler');

  // 16. Decode the latent back to pixels.
  add('16', 'VAEDecode', { samples: ['15', 0], vae: ['11', 2] }, 'VAE Decode');
  let outRef = ['16', 0];

  // 17. Optional restore to the original dimensions.
  if (restoreSize && scale && width > 0 && height > 0) {
    add('17', 'ImageScale', {
      image: outRef,
      upscale_method: 'lanczos',
      width,
      height,
      crop: 'disabled',
    }, `Restore to ${width}x${height}`);
    outRef = ['17', 0];
  }

  // 18. Save the result so /history can find it.
  add('18', 'SaveImage', {
    images: outRef,
    filename_prefix: filenamePrefix,
  }, 'Save Image');

  return workflow;
}

module.exports = {
  buildInpaintWorkflow,
  buildTxt2ImgWorkflow,
  buildImg2ImgWorkflow,
  computeScale,
  clampSize,
  randomSeed,
};

/**
 * Build a plain text-to-image workflow.
 *
 *   EmptyLatentImage -> KSampler (denoise 1.0) -> VAEDecode -> SaveImage
 *   CheckpointLoaderSimple -> CLIPTextEncode(+/-)
 *
 * `width`/`height` should already be clamped to the spec-recommended maxSize
 * by the caller; clampSize() is a final safety net here too.
 *
 * @param {object} o
 * @param {string} o.checkpoint   ckpt_name
 * @param {string} [o.positive]   Positive prompt.
 * @param {string} [o.negative]   Negative prompt.
 * @param {number} [o.width=768]
 * @param {number} [o.height=768]
 * @param {number} [o.steps=28]
 * @param {number} [o.cfg=7]
 * @param {string} [o.sampler='dpmpp_2m']
 * @param {string} [o.scheduler='karras']
 * @param {number} [o.seed=-1]    -1 = random.
 * @param {string} [o.filenamePrefix='embernest_gen']
 * @returns {object} ComfyUI API-format workflow
 */
function buildTxt2ImgWorkflow(o = {}) {
  const {
    checkpoint,
    positive = '',
    negative = '',
    width = 768,
    height = 768,
    steps = 28,
    cfg = 7,
    sampler = 'dpmpp_2m',
    scheduler = 'karras',
    seed = -1,
    loraName = '',
    loraStrength = 1.0,
    filenamePrefix = 'embernest_gen',
  } = o;

  if (!checkpoint) throw new Error('buildTxt2ImgWorkflow: checkpoint is required');

  const w = clampSize(width, 8192);
  const h = clampSize(height, 8192);

  const workflow = {};
  let nid = 0;
  const add = (class_type, inputs, title) => {
    nid += 1;
    const id = String(nid);
    workflow[id] = { class_type, inputs };
    if (title) workflow[id]._meta = { title };
    return id;
  };

  // 1. Empty latent canvas.
  const emptyId = add('EmptyLatentImage', { width: w, height: h, batch_size: 1 }, `Empty Latent ${w}x${h}`);

  // 2. Checkpoint -> MODEL, CLIP, VAE.
  const ckptId = add('CheckpointLoaderSimple', { ckpt_name: checkpoint }, 'Load Checkpoint');

  // 2b. Optional LoRA applied on top of the checkpoint.
  let modelRef = [ckptId, 0];
  let clipRef = [ckptId, 1];
  if (loraName) {
    const loraId = add('LoraLoader', {
      model: modelRef,
      clip: clipRef,
      lora_name: loraName,
      strength_model: loraStrength,
      strength_clip: loraStrength,
    }, `LoRA ${loraName}`);
    modelRef = [loraId, 0];
    clipRef = [loraId, 1];
  }

  // 3-4. Text conditioning.
  const posId = add('CLIPTextEncode', { text: positive, clip: clipRef }, 'Positive Prompt');
  const negId = add('CLIPTextEncode', { text: negative, clip: clipRef }, 'Negative Prompt');

  // 5. Sample at full denoise (this is txt2img).
  const sampleId = add('KSampler', {
    model: modelRef,
    seed: seed >= 0 ? Math.floor(seed) : randomSeed(),
    steps,
    cfg,
    sampler_name: sampler,
    scheduler,
    positive: [posId, 0],
    negative: [negId, 0],
    latent_image: [emptyId, 0],
    denoise: 1.0,
  }, 'KSampler');

  // 6. Decode the latent back to pixels.
  const decId = add('VAEDecode', { samples: [sampleId, 0], vae: [ckptId, 2] }, 'VAE Decode');

  // 7. Save the result so /history can find it.
  add('SaveImage', { images: [decId, 0], filename_prefix: filenamePrefix }, 'Save Image');

  return workflow;
}

/**
 * Build an img2img (Transform) workflow.
 *
 *   LoadImage
 *     -> ImageScale (downscale to maxSize, multiple of 8)      [optional]
 *     -> CheckpointLoaderSimple -> CLIPTextEncode(+/-)
 *     -> VAEEncode            <-- plain encode, NO mask/inpaint
 *     -> KSampler (denoise = user strength)
 *     -> VAEDecode
 *     -> ImageScale (restore original size)                   [optional]
 *     -> SaveImage
 *
 * Gotcha (section 8): img2img must use `VAEEncode`, not
 * `VAEEncodeForInpaint` — there is no mask here.
 *
 * @param {object} o
 * @param {string} o.imageName          File name uploaded to ComfyUI input.
 * @param {string} o.checkpoint
 * @param {string} [o.positive]
 * @param {string} [o.negative]
 * @param {number} [o.width]            Original width  (for scale/restore).
 * @param {number} [o.height]           Original height (for scale/restore).
 * @param {number} [o.maxSize=768]      Longest side to sample at.
 * @param {boolean} [o.restoreSize=true]
 * @param {number} [o.denoise=0.6]      Strength: 0.25–1.0 (1.0 ≈ txt2img).
 * @param {number} [o.steps=28]
 * @param {number} [o.cfg=7]
 * @param {string} [o.sampler='dpmpp_2m']
 * @param {string} [o.scheduler='karras']
 * @param {number} [o.seed=-1]          -1 = random.
 * @param {string} [o.filenamePrefix='embernest_tf']
 * @returns {object} ComfyUI API-format workflow
 */
function buildImg2ImgWorkflow(o = {}) {
  const {
    imageName,
    checkpoint,
    positive = '',
    negative = '',
    width = 0,
    height = 0,
    maxSize = 768,
    restoreSize = true,
    denoise = 0.6,
    steps = 28,
    cfg = 7,
    sampler = 'dpmpp_2m',
    scheduler = 'karras',
    seed = -1,
    loraName = '',
    loraStrength = 1.0,
    filenamePrefix = 'embernest_tf',
  } = o;

  if (!imageName) throw new Error('buildImg2ImgWorkflow: imageName is required');
  if (!checkpoint) throw new Error('buildImg2ImgWorkflow: checkpoint is required');

  const workflow = {};
  let nid = 0;
  const add = (class_type, inputs, title) => {
    nid += 1;
    const id = String(nid);
    workflow[id] = { class_type, inputs };
    if (title) workflow[id]._meta = { title };
    return id;
  };

  // 1. Load the uploaded image from ComfyUI's input folder.
  const imgId = add('LoadImage', { image: imageName }, 'Load Image');
  let imageRef = [imgId, 0];

  // 2. Optional downscale (SD 1.5 collapses above ~768px).
  const scale = computeScale(width, height, maxSize);
  if (scale) {
    const scId = add('ImageScale', {
      image: imageRef,
      upscale_method: 'lanczos',
      width: scale.width,
      height: scale.height,
      crop: 'disabled',
    }, `Downscale to ${scale.width}x${scale.height}`);
    imageRef = [scId, 0];
  }

  // 3. Checkpoint -> MODEL, CLIP, VAE.
  const ckptId = add('CheckpointLoaderSimple', { ckpt_name: checkpoint }, 'Load Checkpoint');

  // 3b. Optional LoRA applied on top of the checkpoint.
  let modelRef = [ckptId, 0];
  let clipRef = [ckptId, 1];
  if (loraName) {
    const loraId = add('LoraLoader', {
      model: modelRef,
      clip: clipRef,
      lora_name: loraName,
      strength_model: loraStrength,
      strength_clip: loraStrength,
    }, `LoRA ${loraName}`);
    modelRef = [loraId, 0];
    clipRef = [loraId, 1];
  }

  // 4-5. Text conditioning.
  const posId = add('CLIPTextEncode', { text: positive, clip: clipRef }, 'Positive Prompt');
  const negId = add('CLIPTextEncode', { text: negative, clip: clipRef }, 'Negative Prompt');

  // 6. Encode the (scaled) image to a latent — plain VAEEncode, no mask.
  const encId = add('VAEEncode', { pixels: imageRef, vae: [ckptId, 2] }, 'VAE Encode');

  // 7. Sample with the user's denoise strength.
  const sampleId = add('KSampler', {
    model: modelRef,
    seed: seed >= 0 ? Math.floor(seed) : randomSeed(),
    steps,
    cfg,
    sampler_name: sampler,
    scheduler,
    positive: [posId, 0],
    negative: [negId, 0],
    latent_image: [encId, 0],
    denoise,
  }, 'KSampler');

  // 8. Decode the latent back to pixels.
  const decId = add('VAEDecode', { samples: [sampleId, 0], vae: [ckptId, 2] }, 'VAE Decode');
  let outRef = [decId, 0];

  // 9. Optional restore to the original dimensions.
  if (restoreSize && scale && width > 0 && height > 0) {
    const rsId = add('ImageScale', {
      image: outRef,
      upscale_method: 'lanczos',
      width,
      height,
      crop: 'disabled',
    }, `Restore to ${width}x${height}`);
    outRef = [rsId, 0];
  }

  // 10. Save the result so /history can find it.
  add('SaveImage', { images: outRef, filename_prefix: filenamePrefix }, 'Save Image');

  return workflow;
}
