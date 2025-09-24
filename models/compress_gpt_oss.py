#!/usr/bin/env python3
import os, sys, argparse, time, gc, json
os.environ.setdefault("PYTORCH_ALLOC_CONF","expandable_segments:True,max_split_size_mb:256")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF","expandable_segments:True")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER","1")
os.environ.setdefault("TOKENIZERS_PARALLELISM","false")

import torch
import torch.nn as nn
from transformers import AutoModelForCausalLM, AutoTokenizer


def log(x):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {x}", flush=True)


def empty():
    try:
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()


def enableFast():
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
    except Exception:
        pass
    try:
        torch.set_float32_matmul_precision("high")
    except Exception:
        pass


def blockMask(W, blk=16, prune_frac=0.5):
    r, c = W.shape
    pr = (blk - (r % blk)) % blk
    pc = (blk - (c % blk)) % blk
    Wp = nn.functional.pad(W, (0, pc, 0, pr)) if (pr or pc) else W
    R, C = Wp.shape
    B = Wp.view(R // blk, blk, C // blk, blk)
    norms = (B * B).sum(dim=(1, 3)).sqrt().contiguous().view(-1)
    k = int(norms.numel() * prune_frac)
    if k <= 0:
        return torch.ones_like(W, dtype=torch.bool)
    th = torch.topk(norms, k, largest=False).values.max()
    keepBlocks = (norms > th).view(R // blk, C // blk)
    keep = keepBlocks.unsqueeze(1).unsqueeze(-1).expand(-1, blk, -1, blk).contiguous().view(R, C)
    return keep[:r, :c]


@torch.no_grad()
def pruneLinear_(lin, blk, prune_frac):
    W = lin.weight.data
    M = blockMask(W, blk=blk, prune_frac=prune_frac).to(W.device)
    W.mul_(M.to(W.dtype))


@torch.no_grad()
def svdLowRank_(lin, rankRatio, target_dtype):
    W = lin.weight.data
    m = min(W.shape[0], W.shape[1])
    r = max(1, int(m * rankRatio))
    Wf = W.to(torch.float32)
    q = min(m, max(2 * r, r + 8))
    U, S, V = torch.svd_lowrank(Wf, q=q, niter=4)
    U = U[:, :r]
    S = S[:r]
    V = V[:, :r]
    What = (U @ torch.diag(S) @ V.t()).to(target_dtype)
    lin.weight.copy_(What)


def findBlocks(model):
    paths = ["model.layers","model.transformer.h","transformer.h","layers","blocks","gpt_neox.layers"]
    for p in paths:
        try:
            obj = model
            for part in p.split('.'):
                obj = getattr(obj, part)
            if isinstance(obj, (nn.ModuleList, list)) and len(obj) >= 4:
                return p, obj
        except Exception:
            pass
    best, path, sz = None, None, 0
    for n, m in model.named_modules():
        if isinstance(m, nn.ModuleList) and len(m) > sz:
            best, path, sz = m, n, len(m)
    if best is None:
        raise RuntimeError("no transformer block list found")
    return path, best


def tryQuantize4bit_(model, compute_dtype=torch.bfloat16):
    try:
        import bitsandbytes as bnb
    except Exception:
        return
    if not (hasattr(bnb.nn, "Linear4bit") and hasattr(bnb.nn.Linear4bit, "from_float")):
        return
    def repl(m):
        for n, ch in list(m.named_children()):
            if isinstance(ch, nn.Linear):
                q = bnb.nn.Linear4bit.from_float(
                    ch,
                    compute_dtype=compute_dtype,
                    quant_type="nf4",
                    compress_statistics=True
                )
                setattr(m, n, q)
            else:
                repl(ch)
    repl(model)


def writeReadme(outDir, baseId, layers, batch, blk, frac, rank, q, dtype):
    meta = {
        "base": baseId,
        "layers_processed": layers,
        "layer_batch": batch,
        "structured_pruning": {"block": blk, "prune_frac": frac},
        "low_rank_ratio": rank,
        "quantization": "nf4_4bit" if q else "none",
        "dtype": dtype
    }
    with open(os.path.join(outDir, "compression.json"), "w") as f:
        json.dump(meta, f, indent=2)
    s = f"""# Compressed {os.path.basename(outDir)}

Base: {baseId}
Blocks processed: {layers} (batch {batch})
Pruning: {int(frac*100)}% at {blk}×{blk}
Low-rank: {int(rank*100)}% of min(in,out)
Quantization: {'4-bit NF4' if q else 'none'}
DType: {dtype}

Quick test:

```python
from transformers import AutoModelForCausalLM, AutoTokenizer
m = AutoModelForCausalLM.from_pretrained("{outDir}", device_map="auto", dtype="{dtype}", trust_remote_code=True)
t = AutoTokenizer.from_pretrained("{outDir}")
print(t.decode(m.generate(**t("Hello", return_tensors="pt").to(next(m.parameters()).device), max_new_tokens=64)[0]))
```
"""
    with open(os.path.join(outDir, "README.md"), "w") as f:
        f.write(s)


def writeOllama(outDir):
    d = os.path.join(outDir, "ollama")
    os.makedirs(d, exist_ok=True)
    mf = """FROM hf://.

TEMPLATE "{{ if .System }}<|system|>{{ .System }}{{ end }}<|user|>{{ .Prompt }}<|assistant|>"

PARAMETER temperature 0.7
PARAMETER num_ctx 8192
PARAMETER num_gpu 1
"""
    with open(os.path.join(d, "Modelfile"), "w") as f:
        f.write(mf)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model-id", default="openai/gpt-oss-20b")
    p.add_argument("--out", required=True)
    p.add_argument("--gpu-layer-batch", type=int, default=1)
    p.add_argument("--prune-frac", type=float, default=0.5)
    p.add_argument("--prune-block", type=int, default=16)
    p.add_argument("--rank-ratio", type=float, default=0.5)
    p.add_argument("--quantize", action="store_true")
    p.add_argument("--dtype", choices=["float16","bfloat16"], default="float16")
    p.add_argument("--attn-impl", choices=["eager","sdpa"], default="eager")
    p.add_argument("--gpu-mem", type=str, default="22GiB")
    p.add_argument("--cpu-mem", type=str, default="24GiB")
    args = p.parse_args()

    if args.attn_impl == "eager":
        os.environ.setdefault("TORCH_FORCE_FALLBACK_EAGER","1")

    enableFast()
    os.makedirs(args.out, exist_ok=True)
    offload = os.path.join(args.out, "offload")
    os.makedirs(offload, exist_ok=True)
    target_dtype = torch.float16 if args.dtype == "float16" else torch.bfloat16

    if not torch.cuda.is_available():
        raise SystemExit("CUDA not available")
    if torch.cuda.device_count() < 1:
        raise SystemExit("No CUDA devices visible")

    max_memory = {"cpu": args.cpu_mem, 0: args.gpu_mem}

    log(f"loading {args.model_id}")
    try:
        model = AutoModelForCausalLM.from_pretrained(
            args.model_id,
            dtype=target_dtype,
            device_map="auto",
            low_cpu_mem_usage=True,
            trust_remote_code=True,
            offload_folder=offload,
            max_memory=max_memory
        )
    except Exception as e:
        raise SystemExit(f"Failed to load model: {e}")

    try:
        tok = AutoTokenizer.from_pretrained(args.model_id, use_fast=True, trust_remote_code=True)
    except Exception as e:
        raise SystemExit(f"Failed to load tokenizer: {e}")

    try:
        path, blocks = findBlocks(model)
        n = len(blocks)
        log(f"blocks {n} at {path}")
    except Exception as e:
        raise SystemExit(f"Failed to locate blocks: {e}")

    bsz = max(1, int(args.gpu_layer_batch))

    try:
        for i in range(0, n, bsz):
            j = min(n, i + bsz)
            log(f"processing layers [{i}:{j})")
            for k in range(i, j):
                blkMod = blocks[k]
                blkMod.to("cuda")
                for m in blkMod.modules():
                    if isinstance(m, nn.Linear):
                        pruneLinear_(m, args.prune_block, args.prune_frac)
                        svdLowRank_(m, args.rank_ratio, target_dtype)
                empty()
    except RuntimeError as e:
        empty()
        raise SystemExit(f"Processing error [{i}:{j}): {e}")

    if args.quantize:
        log("quantizing 4-bit in place")
        try:
            tryQuantize4bit_(model, compute_dtype=torch.bfloat16)
        except Exception as e:
            raise SystemExit(f"4-bit quantization failed: {e}")

    log(f"saving to {args.out}")
    try:
        model.save_pretrained(args.out, safe_serialization=True)
        tok.save_pretrained(args.out)
    except Exception as e:
        raise SystemExit(f"Save failed: {e}")

    writeReadme(args.out, args.model_id, n, bsz, args.prune_block, args.prune_frac, args.rank_ratio, args.quantize, args.dtype)
    writeOllama(args.out)
    log("done")


if __name__ == "__main__":
    try:
        main()
    finally:
        empty()