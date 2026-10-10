#!/usr/bin/env python3
"""Nudity classifier worker for Embernest's photo-edit safety filter.

Protocol (JSON lines):
  stdin : {"id": "...", "path": "/abs/img.png"}
  stdout: {"ready": true}                    once, after the model is loaded
          {"id": "...", "nsfw": 0.93}        per request
          {"id": "...", "error": "..."}      when one image could not be read
Run with --warmup to download + load the model, then exit 0.
Always runs on CPU so it never competes with ComfyUI for VRAM.
"""
import argparse
import json
import os
import sys

# Keep stdout clean for the protocol: library chatter goes to stderr.
_out = sys.stdout
sys.stdout = sys.stderr

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


def emit(obj):
    _out.write(json.dumps(obj) + "\n")
    _out.flush()


def load(repo, revision, offline):
    if offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    import torch
    from transformers import AutoImageProcessor, AutoModelForImageClassification

    processor = AutoImageProcessor.from_pretrained(repo, revision=revision)
    model = AutoModelForImageClassification.from_pretrained(repo, revision=revision)
    model.to("cpu").eval()
    labels = {int(k): str(v).lower() for k, v in model.config.id2label.items()}
    nsfw_index = next((i for i, name in labels.items() if name == "nsfw"), None)
    if nsfw_index is None:
        raise RuntimeError("model has no 'nsfw' label: %r" % (labels,))
    return torch, processor, model, nsfw_index


def score(torch, processor, model, nsfw_index, path):
    from PIL import Image

    with Image.open(path) as img:
        img = img.convert("RGB")
        inputs = processor(images=img, return_tensors="pt")
    with torch.no_grad():
        logits = model(**inputs).logits
    return float(torch.softmax(logits, dim=-1)[0][nsfw_index])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--revision", required=True)
    ap.add_argument("--warmup", action="store_true")
    ap.add_argument("--offline", action="store_true", help="never touch the network")
    args = ap.parse_args()

    # Serving always runs offline: the model was fetched by `--warmup` at setup.
    offline = args.offline or not args.warmup
    torch, processor, model, nsfw_index = load(args.repo, args.revision, offline)
    if args.warmup:
        print("model ready", file=sys.stderr)
        return 0

    emit({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            emit({"id": req_id, "nsfw": score(torch, processor, model, nsfw_index, req["path"])})
        except Exception as err:  # keep serving; the caller fails closed on errors
            emit({"id": req_id, "error": str(err)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
