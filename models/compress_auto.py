#!/usr/bin/env python3
import os, sys, time, gc, argparse

# ---- ENV SANITY (fix your earlier crash) ----
for k in ("TORCH_LOGS","ACCELERATE_USE_XPU","HUGGINGFACE_ACCELERATE_USE_XPU"):
    v=os.environ.get(k)
    if v and v.strip().startswith("{"): os.environ.pop(k,None)
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF","expandable_segments:True")
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER","1")
os.environ.setdefault("TOKENIZERS_PARALLELISM","false")

def log(x): print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {x}", flush=True)
def empty():
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize(); torch.cuda.empty_cache()
    except Exception: pass
    gc.collect()

# ---- LIGHT PROBES ----
def bytes_h(n): return f"{int(n/2**20)}MiB"
def get_ram_bytes():
    try:
        import psutil; return psutil.virtual_memory().total
    except Exception:
        try:
            d={}
            with open("/proc/meminfo") as f:
                for line in f:
                    k,v=line.split(":",1); d[k]=int(v.split()[0])*1024
            return d.get("MemTotal", 16*2**30)
        except Exception:
            return 16*2**30

def get_gpu_probe():
    try:
        import torch
        if not torch.cuda.is_available(): return {"has_cuda":False}
        p=torch.cuda.get_device_properties(0)
        return {
            "has_cuda":True,
            "name":p.name,
            "total_vram":int(p.total_memory),
            "cc":f"{p.major}.{p.minor}",
            "torch":torch.__version__,
            "cuda":getattr(torch.version,"cuda","unknown"),
            "triton":getattr(torch.version,"triton","unknown"),
        }
    except Exception as e:
        return {"has_cuda":False,"err":str(e)}

def decide_dtype(gpu): return "float16" if gpu.get("has_cuda") else "bfloat16"
def pick_memory(ram_bytes, vram_bytes, safety=0.88):
    cpu=max(int(ram_bytes*safety), 8*2**30)
    gpu=max(int(vram_bytes*safety), 8*2**30) if vram_bytes else 0
    return cpu, gpu
def pick_batches(vram_bytes): return 1 if (not vram_bytes or vram_bytes<24*2**30) else 2

# ---- MODEL OPS ----
import torch, torch.nn as nn
from transformers import AutoModelForCausalLM, AutoTokenizer

def enable_tensor_cores():
    try: torch.backends.cuda.matmul.allow_tf32=True
    except Exception: pass
    try: torch.set_float32_matmul_precision("high")
    except Exception: pass

def blockSparseMask(W, blk=16, frac=0.5):
    r,c=W.shape; pr=(blk-(r%blk))%blk; pc=(blk-(c%blk))%blk
    Wp=nn.functional.pad(W,(0,pc,0,pr)) if (pr or pc) else W
    R,C=Wp.shape; B=Wp.view(R//blk,blk,C//blk,blk)
    N=(B**2).sum(dim=(1,3)).sqrt().flatten(); k=int(N.numel()*frac)
    if k<=0: return torch.ones_like(W,dtype=torch.bool)
    th=torch.topk(N,k,largest=False).values.max()
    P=(N<=th).view(R//blk,C//blk)
    P=P.unsqueeze(1).unsqueeze(-1).expand(-1,blk,-1,blk).contiguous().view(R,C)
    return (~P)[:r,:c]

def applyPrune(lin, blk, frac):
    with torch.no_grad():
        W=lin.weight.data
        if W.device.type=="meta": raise NotImplementedError("meta")
        M=blockSparseMask(W, blk=blk, frac=frac)
        W.mul_(M.to(W.dtype))

class FactorizedLinear(nn.Module):
    def __init__(self, inF, outF, r, bias=True, dtype=torch.float16, device="cpu"):
        super().__init__()
        self.linIn=nn.Linear(inF,r,bias=False,dtype=dtype,device=device)
        self.linOut=nn.Linear(r,outF,bias=bias,dtype=dtype,device=device)
    def forward(self,x): return self.linOut(self.linIn(x))

def svdLowRank(W, rank):
    Wf=W.detach().to(torch.float32,copy=True)
    m=min(Wf.shape); q=min(m,max(rank*2,rank+8))
    U,S,V=torch.svd_lowrank(Wf,q=q,niter=4)
    U=U[:,:rank]; S=S[:rank]; V=V[:,:rank]
    A=(U*S).to(torch.float16); B=(V.t()).to(torch.float16)
    return A,B

def replaceLinear(mod,name,rankRatio,blk,frac):
    lin=getattr(mod,name)
    if not isinstance(lin,nn.Linear): return False
    dev=lin.weight.device
    if dev.type=="meta": raise NotImplementedError("meta")
    applyPrune(lin, blk, frac)
    m=min(lin.in_features,lin.out_features); r=max(1,int(m*rankRatio))
    A,B=svdLowRank(lin.weight.data, r)
    fl=FactorizedLinear(
        lin.in_features, lin.out_features, r,
        bias=(lin.bias is not None), dtype=torch.float16, device=dev
    )
    with torch.no_grad():
        fl.linOut.weight.copy_(A.to(dev))
        fl.linIn.weight.copy_(B.to(dev))
        if lin.bias is not None:
            fl.linOut.bias.copy_(lin.bias.data.to(torch.float16).to(dev))
    setattr(mod,name,fl)
    return True

def iterFirstLevelLinears(m):
    for n,ch in m.named_children():
        if isinstance(ch,nn.Linear): yield n

def processBlock(b, rankRatio, blk, frac):
    # DO NOT MOVE THE BLOCK. Work in-place per-Linear on its device.
    changed=False
    for n in list(iterFirstLevelLinears(b)):
        changed |= replaceLinear(b,n,rankRatio,blk,frac)
    for _,ch in b.named_children():
        if isinstance(ch,nn.Linear): continue
        for n in list(iterFirstLevelLinears(ch)):
            changed |= replaceLinear(ch,n,rankRatio,blk,frac)
    return changed

def findBlocks(model):
    paths=["model.layers","model.transformer.h","transformer.h","layers","blocks","gpt_neox.layers"]
    for p in paths:
        try:
            obj=model
            for part in p.split('.'): obj=getattr(obj,part)
            if isinstance(obj,(nn.ModuleList,list)) and len(obj)>=4: return p,obj
        except Exception: pass
    best=None; path=None; size=0
    for n,m in model.named_modules():
        if isinstance(m,nn.ModuleList) and len(m)>size:
            best=m; path=n; size=len(m)
    if best is None: raise RuntimeError("no transformer block list found")
    return path,best

def quantize4bit_inplace(model, compute_dtype=torch.bfloat16):
    try:
        import bitsandbytes as bnb
    except Exception as e:
        raise RuntimeError(f"bitsandbytes not available: {e}")
    def repl(m):
        for n,ch in list(m.named_children()):
            if isinstance(ch,nn.Linear):
                q=bnb.nn.Linear4bit.from_float(ch,compute_dtype=compute_dtype,quant_type="nf4",compress_statistics=True)
                setattr(m,n,q)
            else:
                repl(ch)
    repl(model)

def writeCard(outDir, baseId, layers, batch, blk, frac, rank, q, dtype):
    with open(os.path.join(outDir,"README.md"),"w") as f:
        f.write(f"# Compressed {os.path.basename(outDir)}\nBase: {baseId}\nBlocks: {layers} in batches of {batch}\nPrune: {blk}x{blk} @ {int(frac*100)}%\nLow-rank: {int(rank*100)}%\nQuant: {'NF4-4bit' if q else 'none'}\nDType: {dtype}\n")

def writeOllama(outDir):
    d=os.path.join(outDir,"ollama"); os.makedirs(d,exist_ok=True)
    with open(os.path.join(d,"Modelfile"),"w") as f:
        f.write('FROM hf://.\n\nTEMPLATE "{{ if .System }}<|system|>{{ .System }}{{ end }}<|user|>{{ .Prompt }}<|assistant|>"\n\nPARAMETER temperature 0.7\nPARAMETER num_ctx 8192\nPARAMETER num_gpu 1\n')

def warm_materialize(model, tok):
    # Tiny forward to force accelerate to materialize offloaded/meta weights.
    try:
        device = next((p.device for p in model.parameters() if p.device.type!="meta"), torch.device("cuda" if torch.cuda.is_available() else "cpu"))
        with torch.inference_mode():
            x = tok("hi", return_tensors="pt").to(device)
            _ = model.generate(**x, max_new_tokens=1)
    except Exception as e:
        log(f"warm materialize failed (continuing anyway): {e}")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--model-id", default="openai/gpt-oss-20b")
    ap.add_argument("--out", required=True)
    ap.add_argument("--gpu-layer-batch", type=int, default=0)  # 0=auto
    ap.add_argument("--prune-frac", type=float, default=0.5)
    ap.add_argument("--prune-block", type=int, default=16)
    ap.add_argument("--rank-ratio", type=float, default=0.5)
    ap.add_argument("--quantize", action="store_true")
    ap.add_argument("--dtype", choices=["auto","float16","bfloat16"], default="auto")
    args=ap.parse_args()

    # Probe
    ram_bytes=get_ram_bytes()
    gpu=get_gpu_probe()
    log(f"probe gpu={gpu} ram={bytes_h(ram_bytes)}")
    if not gpu.get("has_cuda"): raise SystemExit("CUDA not available.")

    # Plan
    dtype = decide_dtype(gpu) if args.dtype=="auto" else args.dtype
    cpu_mem, gpu_mem = pick_memory(ram_bytes, gpu.get("total_vram",0))
    bsz = args.gpu_layer_batch if args.gpu_layer_batch>0 else pick_batches(gpu.get("total_vram",0))
    triton = gpu.get("triton","unknown")
    if isinstance(triton,str) and triton not in ("3.4.0","3.5.0","3.6.0"):
        log(f"note: triton={triton}; MXFP4 kernels likely unavailable; we run {dtype} on GPU + offload")

    offload=os.path.join(args.out,"offload"); os.makedirs(offload,exist_ok=True)
    enable_tensor_cores()
    max_memory={"cpu": f"{int(cpu_mem/2**30)}GiB", 0: f"{int(gpu_mem/2**30)}GiB"}
    log(f"plan dtype={dtype} bsz={bsz} max_memory={max_memory}")

    # Load
    try:
        model=AutoModelForCausalLM.from_pretrained(
            args.model_id,
            dtype=torch.float16 if dtype=="float16" else torch.bfloat16,
            device_map="auto",
            low_cpu_mem_usage=True,
            trust_remote_code=True,
            offload_folder=offload,
            max_memory=max_memory
        )
    except Exception as e:
        # shrink GPU allotment, grow CPU once
        log(f"load failed: {e}")
        try:
            max_memory[0]=f"{max(10,int(int(max_memory[0][:-3])*0.75))}GiB"
            max_memory["cpu"]=f"{max(12,int(int(max_memory['cpu'][:-3])*1.25))}GiB"
            log(f"retry with max_memory={max_memory}")
            model=AutoModelForCausalLM.from_pretrained(
                args.model_id,
                dtype=torch.float16 if dtype=="float16" else torch.bfloat16,
                device_map="auto",
                low_cpu_mem_usage=True,
                trust_remote_code=True,
                offload_folder=offload,
                max_memory=max_memory
            )
        except Exception as e2:
            raise SystemExit(f"Failed to load after fallback: {e2}")

    try:
        tok=AutoTokenizer.from_pretrained(args.model_id, use_fast=True)
    except Exception as e:
        # hf_transfer missing, or no tokenizer in repo
        os.environ.pop("HF_HUB_ENABLE_HF_TRANSFER", None)
        try:
            tok=AutoTokenizer.from_pretrained(args.model_id, use_fast=True)
        except Exception as e2:
            raise SystemExit(f"Failed to load tokenizer: {e2}")

    # Blocks
    try:
        path,blocks=findBlocks(model); n=len(blocks)
        log(f"blocks {n} at {path}")
    except Exception as e:
        raise SystemExit(f"Failed to locate blocks: {e}")

    # Process with meta-safe strategy
    target_rank=args.rank_ratio; target_prune=args.prune_frac
    warmed=False
    try:
        for i in range(0,n,bsz):
            j=min(n,i+bsz); log(f"process [{i}:{j}) meta-safe")
            for k in range(i,j):
                try:
                    _=processBlock(blocks[k], target_rank, args.prune_block, target_prune)
                except NotImplementedError as e:
                    if "meta" in str(e) and not warmed:
                        log("meta weights detected → warm materialize")
                        warm_materialize(model, tok); warmed=True
                        _=processBlock(blocks[k], target_rank, args.prune_block, target_prune)
                    else:
                        raise
            empty()
    except RuntimeError as e:
        empty()
        if bsz>1:
            log("retry: reduce batch to 1"); bsz=1
        elif target_rank>0.35:
            log("retry: lower rank_ratio to 0.35"); target_rank=0.35
        elif target_prune<0.6:
            log("retry: raise prune_frac to 0.6"); target_prune=0.6
        else:
            raise SystemExit(f"Processing failed: {e}")
        for i in range(0,n,bsz):
            j=min(n,i+bsz); log(f"re-process [{i}:{j})")
            for k in range(i,j):
                _=processBlock(blocks[k], target_rank, args.prune_block, target_prune)
            empty()

    if args.quantize:
        log("quantize 4-bit inplace (NF4)")
        try:
            quantize4bit_inplace(model, compute_dtype=torch.bfloat16)
        except Exception as e:
            log(f"warn: 4-bit quantization skipped: {e}")

    log(f"saving → {args.out}")
    try:
        model.save_pretrained(args.out, safe_serialization=True); tok.save_pretrained(args.out)
    except Exception as e:
        raise SystemExit(f"Save failed: {e}")
    writeCard(args.out, args.model_id, n, bsz, args.prune_block, target_prune, target_rank, args.quantize, dtype)
    writeOllama(args.out)
    log("done")

if __name__=="__main__":
    try: main()
    finally: empty()

