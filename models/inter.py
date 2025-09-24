# inter_clean.py
import os, torch
from transformers import AutoModelForCausalLM, AutoTokenizer

os.environ.setdefault("PYTORCH_ALLOC_CONF","expandable_segments:True,max_split_size_mb:256")
os.environ.setdefault("CUDA_VISIBLE_DEVICES","0")

model_dir = "./export/gpt-oss-20b-fp16-clean"

tok = AutoTokenizer.from_pretrained(model_dir, use_fast=True, trust_remote_code=True, local_files_only=True)
if tok.pad_token_id is None and tok.eos_token_id is not None:
    tok.pad_token = tok.eos_token

model = AutoModelForCausalLM.from_pretrained(
    model_dir,
    trust_remote_code=True,
    device_map="auto",
    dtype="auto",                 # fine; will pick fp16 on GPU
    low_cpu_mem_usage=True,
    local_files_only=True,
)

prompt = "You are a helpful assistant. Briefly introduce yourself in one sentence."
inputs = tok(prompt, return_tensors="pt").to(model.device)

with torch.inference_mode():
    out = model.generate(**inputs, max_new_tokens=64, do_sample=False)
print(tok.decode(out[0], skip_special_tokens=True))
