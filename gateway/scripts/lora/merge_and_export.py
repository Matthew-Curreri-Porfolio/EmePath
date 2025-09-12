#!/usr/bin/env python3
# Merge LoRA into FP16 base -> save HF -> convert to GGUF -> quantize for llama.cpp
import argparse, os, subprocess, sys, json, shutil, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

def sh(cmd, cwd=None):
    print("[RUN]", " ".join(cmd))
    r = subprocess.run(cmd, cwd=cwd)
    if r.returncode != 0: sys.exit(r.returncode)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base_fp16", required=True, help="FP16 HF model dir or hub id (must be float!)")
    ap.add_argument("--lora_dir", required=True, help="LoRA adapters dir (from train_qlora)")
    ap.add_argument("--out_hf", required=True, help="output HF dir (merged FP16)")
    ap.add_argument("--llama_cpp", default="./llama.cpp", help="path to llama.cpp repo")
    ap.add_argument("--gguf_out", default="merged-f16.gguf")
    ap.add_argument("--qtype", default="Q4_K_M")
    args = ap.parse_args()

    os.makedirs(args.out_hf, exist_ok=True)

    print("[*] Loading base FP16 …")
    model = AutoModelForCausalLM.from_pretrained(args.base_fp16, torch_dtype=torch.float16, device_map="cpu")
    tok = AutoTokenizer.from_pretrained(args.base_fp16, use_fast=True)
    print("[*] Applying LoRA …")
    model = PeftModel.from_pretrained(model, args.lora_dir)
    print("[*] Merging LoRA into base …")
    model = model.merge_and_unload()
    model = model.to(torch.float16)

    print("[*] Saving merged HF model ->", args.out_hf)
    model.save_pretrained(args.out_hf, safe_serialization=True)
    tok.save_pretrained(args.out_hf)

    conv = os.path.join(args.llama_cpp, "convert_hf_to_gguf.py")
    if not os.path.exists(conv):
        conv = os.path.join(args.llama_cpp, "convert-hf-to-gguf.py")
    if not os.path.exists(conv):
        print("ERR: convert-hf-to-gguf.py not found in llama.cpp", file=sys.stderr); sys.exit(2)

    print("[*] Converting HF -> GGUF (FP16) …")
    sh([sys.executable, conv, args.out_hf, "--outfile", args.gguf_out, "--outtype", "f16"])

    quant_bin = os.path.join(args.llama_cpp, "build", "bin", "quantize")
    if not os.path.exists(quant_bin):
        print("ERR: llama.cpp quantize binary missing. Build llama.cpp first.", file=sys.stderr); sys.exit(2)

    q_out = os.path.splitext(args.gguf_out)[0] + f"_{args.qtype}.gguf"
    print("[*] Quantizing ->", q_out)
    sh([quant_bin, args.gguf_out, q_out, args.qtype])

    meta = {
        "base_fp16": args.base_fp16,
        "lora_dir": args.lora_dir,
        "out_hf": args.out_hf,
        "gguf_f16": os.path.abspath(args.gguf_out),
        "gguf_quant": os.path.abspath(q_out),
        "qtype": args.qtype
    }
    with open("merge_export_meta.json", "w") as f: f.write(json.dumps(meta, indent=2))
    print("[OK] Export complete.")
    print(json.dumps(meta, indent=2))

if __name__ == "__main__":
    main()
# EOF