#!/usr/bin/env python3
"""
unblock_qmarks.py — Surgical fine-tune utility to remove "????" runs

Modes
  - --mode lora: train a small LoRA adapter to suppress placeholder question-mark runs
  - --mode sft:  small SFT on base weights OR merge an existing LoRA into the base (use --merge-only)

Data format (JSONL)
  Each line is a JSON object with fields:
    - system     (optional string)
    - developer  (optional string)
    - user       (required string)
    - assistant  (required string; TARGET with no "????")

Example
  {
    "system": "You are a helpful assistant. Never output placeholder punctuation like '????'.",
    "user": "Explain the photoelectric effect and give the equation.",
    "assistant": "The photoelectric effect occurs when ... KE_max = h f - c ..."
  }

Quick start
  # LoRA training (recommended first)
  python tools/unblock_qmarks.py --mode lora \
    --model /path/to/base-or-hf-id \
    --train data/unblock_qmarks.sample.jsonl \
    --out runs/unblock-lora

  # Merge LoRA adapter into base weights (optional)
  python tools/unblock_qmarks.py --mode sft \
    --model /path/to/base-or-hf-id \
    --lora  runs/unblock-lora \
    --merge-only \
    --out   /path/to/model-unblocked

  # Direct small SFT on base (no LoRA)
  python tools/unblock_qmarks.py --mode sft \
    --model /path/to/base-or-hf-id \
    --train data/unblock_qmarks.sample.jsonl \
    --out   runs/unblock-sft

Recommended dataset size
  - Minimal effective: ~200–400 examples
  - Solid patch:       ~600–1,200 examples (include physics, cooking, general Q&A)
  - Add 50–150 refusal examples that use explicit refusal text (not "????")
  - Token budget target: ~100k–600k tokens total for a quick, safe nudge

Hyperparameters (defaults are conservative)
  - LoRA rank 16, alpha 16, dropout 0.05
  - LR 5e-6 to 1e-5; epochs 1–2; batch 8; grad-accum 2–4; seq len 2048

"""

import argparse
import json
import os
from dataclasses import dataclass
from typing import List, Dict, Any, Optional

import torch
from torch.utils.data import Dataset

from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
)

try:
    from peft import LoraConfig, get_peft_model, PeftModel
    PEFT_AVAILABLE = True
except Exception:
    PEFT_AVAILABLE = False


def read_jsonl(path: str) -> List[Dict[str, Any]]:
    data = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                data.append(json.loads(line))
            except Exception:
                pass
    return data


def auto_repair_qmarks(text: str, replacement: str = 'Unknown') -> str:
    # Replace any run of >=2 question marks with a neutral token
    out = []
    i = 0
    while i < len(text):
        if text[i] == '?':
            j = i
            while j < len(text) and text[j] == '?':
                j += 1
            run_len = j - i
            if run_len >= 2:
                out.append(f'({replacement})')
            else:
                out.append('?')
            i = j
        else:
            out.append(text[i])
            i += 1
    return ''.join(out)


def build_prompt(sample: Dict[str, Any]) -> str:
    sys = sample.get('system') or ''
    dev = sample.get('developer') or ''
    usr = sample.get('user') or ''
    parts = []
    if sys:
        parts.append(f"<SYS>\n{sys}\n</SYS>\n")
    if dev:
        parts.append(f"<DEV>\n{dev}\n</DEV>\n")
    parts.append(f"<USER>\n{usr}\n</USER>\n")
    parts.append("<ASSISTANT>\n")
    return ''.join(parts)


@dataclass
class SftRecord:
    input_ids: List[int]
    attention_mask: List[int]
    labels: List[int]


class ChatSftDataset(Dataset):
    def __init__(self, tokenizer: AutoTokenizer, data: List[Dict[str, Any]], cutoff_len: int = 2048, auto_repair: bool = True, repair_token: str = 'Unknown'):
        self.tokenizer = tokenizer
        self.cutoff_len = cutoff_len
        self.records: List[SftRecord] = []
        for s in data:
            user = s.get('user')
            asst = s.get('assistant')
            if not isinstance(user, str) or not isinstance(asst, str):
                continue
            if auto_repair:
                asst = auto_repair_qmarks(asst, repair_token)
            prompt = build_prompt(s)
            full = prompt + asst + "\n</ASSISTANT>"

            prompt_ids = tokenizer(prompt, add_special_tokens=False)['input_ids']
            full_enc = tokenizer(full, add_special_tokens=False, truncation=True, max_length=cutoff_len)
            inp = full_enc['input_ids']
            att = full_enc['attention_mask']

            # mask prompt tokens from loss
            labels = [-100] * len(inp)
            p_len = min(len(prompt_ids), len(inp))
            for i in range(p_len, len(inp)):
                labels[i] = inp[i]

            self.records.append(SftRecord(inp, att, labels))

    def __len__(self):
        return len(self.records)

    def __getitem__(self, idx):
        r = self.records[idx]
        return {
            'input_ids': torch.tensor(r.input_ids, dtype=torch.long),
            'attention_mask': torch.tensor(r.attention_mask, dtype=torch.long),
            'labels': torch.tensor(r.labels, dtype=torch.long),
        }


def load_model_and_tokenizer(model_name_or_path: str, bf16: bool = True):
    tok = AutoTokenizer.from_pretrained(model_name_or_path, use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if bf16 and torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
    model = AutoModelForCausalLM.from_pretrained(
        model_name_or_path,
        torch_dtype=dtype,
        device_map='auto'
    )
    return model, tok


def train_lora(args):
    if not PEFT_AVAILABLE:
        raise SystemExit("peft is required for --mode lora. pip install peft")
    if not args.train:
        raise SystemExit("--train is required for lora mode")
    os.makedirs(args.out, exist_ok=True)

    model, tok = load_model_and_tokenizer(args.model, bf16=args.bf16)
    lora_cfg = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias='none',
        task_type='CAUSAL_LM',
        target_modules=args.lora_targets.split(',') if args.lora_targets else None,
    )
    model = get_peft_model(model, lora_cfg)

    data = read_jsonl(args.train)
    ds = ChatSftDataset(tok, data, cutoff_len=args.cutoff_len, auto_repair=args.auto_repair, repair_token=args.repair_token)

    targs = TrainingArguments(
        output_dir=args.out,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        num_train_epochs=args.epochs,
        logging_steps=max(1, args.logging_steps),
        save_strategy='epoch',
        bf16=args.bf16,
        fp16=(not args.bf16),
        optim='adamw_torch',
        report_to='none',
    )
    trainer = Trainer(model=model, args=targs, train_dataset=ds)
    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    print(f"[OK] LoRA saved at: {args.out}")


def train_sft(args):
    if args.merge_only:
        if not (args.lora and os.path.isdir(args.lora)):
            raise SystemExit("--merge-only requires --lora to be a trained adapter directory")
        os.makedirs(args.out, exist_ok=True)
        base, tok = load_model_and_tokenizer(args.model, bf16=args.bf16)
        if not PEFT_AVAILABLE:
            raise SystemExit("peft is required to merge LoRA into base")
        merged = PeftModel.from_pretrained(base, args.lora)
        merged = merged.merge_and_unload()
        merged.save_pretrained(args.out)
        tok.save_pretrained(args.out)
        print(f"[OK] Merged weights saved at: {args.out}")
        return

    if not args.train:
        raise SystemExit("--train is required for sft mode (unless --merge-only)")
    os.makedirs(args.out, exist_ok=True)
    model, tok = load_model_and_tokenizer(args.model, bf16=args.bf16)
    data = read_jsonl(args.train)
    ds = ChatSftDataset(tok, data, cutoff_len=args.cutoff_len, auto_repair=args.auto_repair, repair_token=args.repair_token)

    targs = TrainingArguments(
        output_dir=args.out,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        num_train_epochs=args.epochs,
        logging_steps=max(1, args.logging_steps),
        save_strategy='epoch',
        bf16=args.bf16,
        fp16=(not args.bf16),
        optim='adamw_torch',
        report_to='none',
    )
    trainer = Trainer(model=model, args=targs, train_dataset=ds)
    trainer.train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)
    print(f"[OK] SFT model saved at: {args.out}")


def main():
    ap = argparse.ArgumentParser(description='Surgical fine-tune to remove "????" runs (LoRA or SFT).')
    ap.add_argument('--mode', choices=['lora', 'sft'], required=True)
    ap.add_argument('--model', required=True, help='Base model name or path')
    ap.add_argument('--train', help='Train JSONL path (system/developer/user/assistant fields)')
    ap.add_argument('--out', required=True, help='Output directory')
    ap.add_argument('--lora', help='LoRA adapter dir (for --merge-only)')
    ap.add_argument('--merge-only', action='store_true', help='Merge LoRA adapter into base and save to --out')

    # Data handling
    ap.add_argument('--cutoff-len', type=int, default=2048)
    ap.add_argument('--auto-repair', action='store_true', help='Auto-repair runs of question marks in targets')
    ap.add_argument('--repair-token', default='Unknown', help='Replacement used when auto-repairing runs of ?')

    # Train hparams
    ap.add_argument('--batch-size', type=int, default=8)
    ap.add_argument('--grad-accum', type=int, default=2)
    ap.add_argument('--epochs', type=float, default=1.5)
    ap.add_argument('--lr', type=float, default=5e-6)
    ap.add_argument('--logging-steps', type=int, default=10)
    ap.add_argument('--bf16', action='store_true', help='Use bfloat16 if supported (recommended on Ampere+)')

    # LoRA params
    ap.add_argument('--lora-r', type=int, default=16)
    ap.add_argument('--lora-alpha', type=int, default=16)
    ap.add_argument('--lora-dropout', type=float, default=0.05)
    ap.add_argument('--lora-targets', help='Comma-separated module name fragments to target (optional)')

    args = ap.parse_args()

    if args.mode == 'lora':
        train_lora(args)
    else:
        train_sft(args)


if __name__ == '__main__':
    main()

