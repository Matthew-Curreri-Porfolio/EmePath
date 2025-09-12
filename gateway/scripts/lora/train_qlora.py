#!/usr/bin/env python3
# QLoRA trainer: base in 4-bit (bnb), train small LoRA adapters only.
# Data: JSONL with {"text": "..."} per line.
import os, json, math, argparse
from dataclasses import dataclass
from typing import Dict, List
import torch
from torch.utils.data import Dataset
from transformers import (AutoTokenizer, AutoModelForCausalLM, DataCollatorForLanguageModeling,
                          Trainer, TrainingArguments, BitsAndBytesConfig)
from peft import LoraConfig, get_peft_model, TaskType

class JsonlText(Dataset):
    def __init__(self, path, tokenizer, max_len=2048):
        self.rows = []
        with open(path, "r", encoding="utf-8") as f:
            for ln in f:
                if ln.strip():
                    obj = json.loads(ln)
                    self.rows.append(obj["text"])
        self.tok = tokenizer; self.max_len = max_len
    def __len__(self): return len(self.rows)
    def __getitem__(self, i):
        enc = self.tok(self.rows[i], truncation=True, max_length=self.max_len, return_tensors="pt")
        return {k: v.squeeze(0) for k, v in enc.items()}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="HF id or local path (FP16 recommended for merge; 4-bit used for training)")
    ap.add_argument("--data", required=True, help="JSONL with {'text': ...}")
    ap.add_argument("--out", required=True, help="output dir for LoRA adapters")
    ap.add_argument("--r", type=int, default=16)
    ap.add_argument("--alpha", type=int, default=32)
    ap.add_argument("--dropout", type=float, default=0.05)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--bsz", type=int, default=2)
    ap.add_argument("--grad_accum", type=int, default=8)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--max_len", type=int, default=2048)
    ap.add_argument("--bf16", action="store_true")
    ap.add_argument("--save_steps", type=int, default=1000)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    tok = AutoTokenizer.from_pretrained(args.base, use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    # 4-bit load for QLoRA (train only adapters)
    quant_cfg = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16 if args.bf16 else torch.float16,
                                   bnb_4bit_use_double_quant=True, bnb_4bit_quant_type="nf4")
    model = AutoModelForCausalLM.from_pretrained(args.base, quantization_config=quant_cfg, device_map="auto")
    model.config.use_cache = False

    # Target modules: common LLaMA/GPT layers ("q_proj","k_proj","v_proj","o_proj","gate_up","down_proj")
    lcfg = LoraConfig(
        r=args.r, lora_alpha=args.alpha, lora_dropout=args.dropout,
        bias="none", task_type=TaskType.CAUSAL_LM,
        target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"]
    )
    model = get_peft_model(model, lcfg)
    model.print_trainable_parameters()

    ds = JsonlText(args.data, tok, max_len=args.max_len)
    coll = DataCollatorForLanguageModeling(tok, mlm=False)

    steps_per_epoch = max(1, len(ds) // (args.bsz * args.grad_accum))
    save_steps = args.save_steps if args.save_steps > 0 else steps_per_epoch

    targs = TrainingArguments(
        output_dir=args.out, per_device_train_batch_size=args.bsz, gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr, num_train_epochs=args.epochs, bf16=args.bf16, fp16=not args.bf16,
        logging_steps=50, save_steps=save_steps, save_total_limit=2, optim="paged_adamw_32bit",
        lr_scheduler_type="cosine", warmup_ratio=0.03, dataloader_num_workers=2,
        gradient_checkpointing=True, report_to=[]
    )
    trainer = Trainer(model=model, args=targs, data_collator=coll, train_dataset=ds)
    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    print(f"[OK] LoRA adapters saved to: {args.out}")

if __name__ == "__main__":
    main()
