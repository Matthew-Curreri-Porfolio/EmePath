# make_fp16_clean_export.py
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

model_id = "openai/gpt-oss-20b"
out_dir  = "./export/gpt-oss-20b-fp16-clean"

tok = AutoTokenizer.from_pretrained(model_id, use_fast=True, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(
    model_id,
    trust_remote_code=True,
    torch_dtype=torch.float16,   # force fp16
    device_map=None,             # load on CPU to save cleanly
)

tok.save_pretrained(out_dir)
model.save_pretrained(out_dir, safe_serialization=True)
print("Saved clean FP16 to", out_dir)

