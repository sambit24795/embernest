#!/usr/bin/env python3
"""
merge_checkpoints.py — weighted merge of two same-base SD checkpoints.

Replicates ComfyUI's ModelMergeSimple + CheckpointSave(A's CLIP + VAE):
    UNet = A * ratio + B * (1 - ratio)
    CLIP = A
    VAE  = A

Runs lazily (one tensor at a time) so it fits on 6 GB VRAM / 16 GB RAM — unlike
ComfyUI, which loads both full checkpoints at once and OOMs on 16 GB.

Refuses to merge an inpainting UNet (9 mask channels) with a regular one (4):
that hybrid would be structurally broken.
"""
import argparse
import sys

import torch
from safetensors import safe_open
from safetensors.torch import save_file

UNET_PREFIX = "model.diffusion_model."
IN_CHANNEL_KEY = "model.diffusion_model.input_blocks.0.0.weight"


def merge(a_path, b_path, out_path, ratio=0.5, dtype=torch.float16):
    ratio = min(1.0, max(0.0, float(ratio)))

    with safe_open(a_path, framework="pt") as fa, safe_open(b_path, framework="pt") as fb:
        meta_a = dict(fa.metadata() or {})
        meta_b = dict(fb.metadata() or {})
        keys_a = set(fa.keys())
        keys_b = set(fb.keys())

        # Safety: inpainting UNets take 9 input channels, regular ones 4.
        def in_channels(f):
            return f.get_slice(IN_CHANNEL_KEY).get_shape()[1] if IN_CHANNEL_KEY in f.keys() else None

        ca, cb = in_channels(fa), in_channels(fb)
        if ca is not None and cb is not None and ca != cb:
            raise ValueError(
                f"refusing to merge: UNet input channels differ (A={ca}, B={cb}). "
                "Merging an inpainting checkpoint with a regular one produces a broken model."
            )

        common = keys_a & keys_b
        a_only = sorted(keys_a - common)
        b_only = sorted(keys_b - common)
        if a_only or b_only:
            print(f"WARNING: key sets differ — only-in-A={len(a_only)}, only-in-B={len(b_only)}",
                  file=sys.stderr)

        out = {}
        for k in sorted(keys_a | keys_b):
            if k.startswith("model_ema."):
                continue  # EMA tracking scalars — not part of the model, drop them
            if k.startswith(UNET_PREFIX) and k in common:
                wa = fa.get_tensor(k).to(torch.float32)
                wb = fb.get_tensor(k).to(torch.float32)
                out[k] = (wa * ratio + wb * (1.0 - ratio)).to(dtype).contiguous()
            elif k in keys_a:
                out[k] = fa.get_tensor(k)  # CLIP / VAE verbatim from A
            else:
                out[k] = fb.get_tensor(k)

        meta = dict(meta_a)
        meta["ss_output_name"] = out_path.rsplit("/", 1)[-1].replace(".safetensors", "")
        meta["ss_merged_from"] = (
            f"{a_path.split('/')[-1]} ({ratio:.2f}) + {b_path.split('/')[-1]} ({1 - ratio:.2f})"
        )

        save_file(out, out_path, metadata=meta)

    return {
        "keys": len(out),
        "unet_blended": sum(1 for k in out if k.startswith(UNET_PREFIX)),
        "a_only": a_only,
        "b_only": b_only,
        "in_channels": (ca, cb),
        "arch_a": meta_a.get("modelspec.architecture"),
        "arch_b": meta_b.get("modelspec.architecture"),
    }


def main():
    p = argparse.ArgumentParser(description="Weighted merge of two SD checkpoints.")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--ratio", type=float, default=0.5, help="weight of checkpoint A (0-1)")
    args = p.parse_args()

    info = merge(args.a, args.b, args.out, args.ratio)
    print(f"merged -> {args.out}")
    print(f"  keys: {info['keys']}  unet_blended: {info['unet_blended']}")
    print(f"  in_channels A/B: {info['in_channels']}")
    print(f"  arch A: {info['arch_a']}  arch B: {info['arch_b']}")
    if info["a_only"] or info["b_only"]:
        print(f"  only-in-A: {info['a_only'][:5]}  only-in-B: {info['b_only'][:5]}")


if __name__ == "__main__":
    main()
