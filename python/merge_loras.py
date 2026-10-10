#!/usr/bin/env python3
"""
merge_loras.py — merge two same-base SD LoRAs into one .safetensors LoRA.

Exact (lossless) merge: bake each LoRA's alpha/rank scale and the user's strength
into its up/down matrices, then concatenate the two along the rank dimension.
The result is a rank-(rA+rB) LoRA with alpha = new rank, so ComfyUI applies it at
full scale (alpha/rank == 1).

Why not ComfyUI's LoraSave node? Its SVD pass materialises the full UNet diff in
float32 (~4.4 GB -> ~9 GB) and OOMs on a 16 GB RAM box. This script only holds
the two source LoRAs in memory (~300 MB each), so it fits on 6 GB VRAM / 16 GB RAM.

Usage:
  merge_loras.py --a a.safetensors --b b.safetensors --out merged.safetensors \
                 [--strength-a 1.0] [--strength-b 1.0]
"""
import argparse
import sys

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def alpha_key(name: str) -> str:
    return name.replace(".lora_up.weight", ".alpha").replace(".lora_down.weight", ".alpha")


def read_safetensors(path):
    with safe_open(path, framework="pt") as f:
        meta = dict(f.metadata() or {})
        tensors = {k: f.get_tensor(k) for k in f.keys()}
    return tensors, meta


def merge(a_path, b_path, out_path, strength_a=1.0, strength_b=1.0, dtype=torch.float16):
    ta, meta_a = read_safetensors(a_path)
    tb, meta_b = read_safetensors(b_path)

    common = set(ta.keys()) & set(tb.keys())
    a_only = sorted(set(ta.keys()) - common)
    b_only = sorted(set(tb.keys()) - common)
    if a_only or b_only:
        print(f"WARNING: key sets differ — only-in-A={len(a_only)}, only-in-B={len(b_only)}",
              file=sys.stderr)

    strength_a = min(2.0, max(-2.0, float(strength_a)))
    strength_b = min(2.0, max(-2.0, float(strength_b)))

    out = {}
    skipped = []
    ranks = []
    for k in sorted(set(ta.keys()) | set(tb.keys())):
        in_a = k in ta
        in_b = k in tb
        if k.endswith(".lora_down.weight"):
            if in_a and in_b:
                ak = alpha_key(k)
                if ak not in ta or ak not in tb:
                    skipped.append(k)
                    continue
                rank_a = int(ta[k].shape[0])
                rank_b = int(tb[k].shape[0])
                ranks.append((rank_a, rank_b))
                alpha_a = float(ta[ak].item())
                alpha_b = float(tb[ak].item())
                # ComfyUI applies: strength * (alpha / rank) * (up @ down). Bake the
                # full signed scale onto the down side so negative strengths work.
                scale_a = strength_a * (alpha_a / rank_a)
                scale_b = strength_b * (alpha_b / rank_b)
                wa = ta[k].to(torch.float32) * scale_a
                wb = tb[k].to(torch.float32) * scale_b
                out[k] = torch.cat([wa, wb], dim=0).to(dtype).contiguous()
            else:
                # One-sided key (partial-coverage LoRA): bake that LoRA's strength
                # and keep its rank, rather than dropping the other side's key.
                src = ta if in_a else tb
                ak = alpha_key(k)
                if ak not in src:
                    skipped.append(k)
                    continue
                strength = strength_a if in_a else strength_b
                rank = int(src[k].shape[0])
                alpha = float(src[ak].item())
                scale = strength * (alpha / rank)
                out[k] = (src[k].to(torch.float32) * scale).to(dtype).contiguous()
        elif k.endswith(".lora_up.weight"):
            # Up side stays unscaled; the signed scale lives on the down side.
            if in_a and in_b:
                out[k] = torch.cat([ta[k].to(dtype), tb[k].to(dtype)], dim=1).contiguous()
            else:
                out[k] = (ta[k] if in_a else tb[k]).to(dtype).contiguous()
        elif k.endswith(".alpha"):
            up_key = k.replace(".alpha", ".lora_up.weight")
            if in_a and in_b and up_key in ta and up_key in tb:
                new_rank = int(ta[up_key].shape[1]) + int(tb[up_key].shape[1])
                out[k] = torch.full_like(ta[k].to(torch.float32), float(new_rank))
            else:
                src = ta if in_a else tb
                r = int(src[up_key].shape[1]) if up_key in src else 1
                out[k] = torch.full_like(src[k].to(torch.float32), float(r))
        else:
            out[k] = ta[k] if in_a else tb[k]

    meta = dict(meta_a)
    meta["ss_output_name"] = out_path.rsplit("/", 1)[-1].replace(".safetensors", "")
    meta["ss_merged_from"] = (
        f"{a_path.split('/')[-1]} ({strength_a:+.2f}) + {b_path.split('/')[-1]} ({strength_b:+.2f})"
    )
    if meta_a.get("ss_sd_model_name") and meta_a.get("ss_sd_model_name") != meta_b.get("ss_sd_model_name"):
        print(f"WARNING: base mismatch — A={meta_a.get('ss_sd_model_name')} "
              f"B={meta_b.get('ss_sd_model_name')}", file=sys.stderr)

    save_file(out, out_path, metadata=meta)
    return {
        "keys_written": len(out),
        "skipped": skipped,
        "a_only": a_only,
        "b_only": b_only,
        "base_a": meta_a.get("ss_sd_model_name"),
        "base_b": meta_b.get("ss_sd_model_name"),
        "rank_pairs": sorted(set(ranks)),
    }


def main():
    p = argparse.ArgumentParser(description="Merge two SD LoRAs into one.")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--strength-a", type=float, default=1.0)
    p.add_argument("--strength-b", type=float, default=1.0)
    args = p.parse_args()

    info = merge(args.a, args.b, args.out, args.strength_a, args.strength_b)
    print(f"merged -> {args.out}")
    print(f"  keys: {info['keys_written']}  skipped: {len(info['skipped'])}")
    print(f"  base A: {info['base_a']}  base B: {info['base_b']}")
    print(f"  rank pairs (rA, rB): {info['rank_pairs']}")


if __name__ == "__main__":
    main()
