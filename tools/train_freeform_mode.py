#!/usr/bin/env python3
"""
train_freeform_mode.py — Fine-tune for "freeform thoughts" mode (LoRA or SFT)

This script nudges a base model toward emitting explicit reasoning/thoughts
followed by a final answer, while preserving safety constraints you include
in the targets. Use with responsibility in regulated settings.

Data format (JSONL per line)
  Required fields:
    - user                : string
    - assistant_answer    : string (final answer)
  Optional fields:
    - system              : string
    - developer           : string
    - assistant_thoughts  : string (freeform rationale)
    - assistant_combined  : string (manual combined thoughts+answer; overrides)

Target layout trained
  <SYS> ... </SYS>
  <DEV> ... </DEV>
  <USER> ... </USER>
  <ASSISTANT>
  <THOUGHTS>
  ...
  </THOUGHTS>
  <ANSWER>
  ...
  </ANSWER>
  </ASSISTANT>

Usage
  # LoRA (recommended)
  python tools/train_freeform_mode.py --mode lora \
    --model /path/to/base-or-hf-id \
    --train data/freeform_mode.sample.jsonl \
    --out runs/freeform-lora --bf16

  # Merge LoRA into base weights (HF)
  python tools/train_freeform_mode.py --mode sft --merge-only \
    --model /path/to/base-or-hf-id \
    --lora  runs/freeform-lora \
    --out   models/base-freeform

  # Direct small SFT on base (no LoRA)
  python tools/train_freeform_mode.py --mode sft \
    --model /path/to/base-or-hf-id \
    --train data/freeform_mode.sample.jsonl \
    --out   runs/freeform-sft --bf16

Recommended dataset size
  - LoRA:   500–2,000 examples (balanced across domains);
  - SFT:  1,000–5,000 examples.
Include explicit examples where thoughts are present and refusal style is
clean (no placeholder punctuation). Keep disallowed details out of targets.
"""

import argparse
import json
import os
from dataclasses import dataclass
from typing import List, Dict, Any

import torch
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

try:
    from peft import LoraConfig, get_peft_model, PeftModel
    PEFT_AVAILABLE = True
except Exception:
    PEFT_AVAILABLE = False


def read_jsonl(path: str) -> List[Dict[str, Any]]:
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except Exception:
                pass
    return out


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


def build_target(sample: Dict[str, Any], thoughts_required: bool) -> str:
    if isinstance(sample.get('assistant_combined'), str) and sample['assistant_combined']:
        return sample['assistant_combined']
    th = (sample.get('assistant_thoughts') or '').strip()
    ans = (sample.get('assistant_answer') or '').strip()
    parts = []
    if thoughts_required or th:
        parts.append("<THOUGHTS>\n")
        parts.append(th if th else 'Reasoning omitted.')
        parts.append("\n</THOUGHTS>\n")
    parts.append("<ANSWER>\n")
    parts.append(ans)
    parts.append("\n</ANSWER>")
    return ''.join(parts)


@dataclass
class Rec:
    input_ids: List[int]
    attention_mask: List[int]
    labels: List[int]


class FreeformDataset(Dataset):
    def __init__(self, tok: AutoTokenizer, data: List[Dict[str, Any]], cutoff_len: int, thoughts_required: bool):
        self.recs: List[Rec] = []
        for s in data:
            if not isinstance(s.get('user'), str) or not isinstance(s.get('assistant_answer'), str):
                continue
            prompt = build_prompt(s)
            target = build_target(s, thoughts_required)
            full = prompt + target + "\n</ASSISTANT>"
            prompt_ids = tok(prompt, add_special_tokens=False)['input_ids']
            enc = tok(full, add_special_tokens=False, truncation=True, max_length=cutoff_len)
            inp = enc['input_ids']; att = enc['attention_mask']
            labels = [-100] * len(inp)
            p = min(len(prompt_ids), len(inp))
            for i in range(p, len(inp)):
                labels[i] = inp[i]
            self.recs.append(Rec(inp, att, labels))

    def __len__(self):
        return len(self.recs)

    def __getitem__(self, idx):
        r = self.recs[idx]
        return {
            'input_ids': torch.tensor(r.input_ids, dtype=torch.long),
            'attention_mask': torch.tensor(r.attention_mask, dtype=torch.long),
            'labels': torch.tensor(r.labels, dtype=torch.long),
        }


def load_model_tok(path: str, bf16: bool):
    tok = AutoTokenizer.from_pretrained(path, use_fast=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    dtype = torch.bfloat16 if (bf16 and torch.cuda.is_available() and torch.cuda.is_bf16_supported()) else torch.float16
    model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=dtype, device_map='auto')
    return model, tok


def train_lora(args):
    if not PEFT_AVAILABLE:
        raise SystemExit('peft is required for --mode lora (pip install peft)')
    if not args.train:
        raise SystemExit('--train required for lora mode')
    os.makedirs(args.out, exist_ok=True)
    model, tok = load_model_tok(args.model, args.bf16)

    lcfg = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=args.lora_dropout,
        bias='none', task_type='CAUSAL_LM',
        target_modules=args.lora_targets.split(',') if args.lora_targets else None,
    )
    model = get_peft_model(model, lcfg)

    data = read_jsonl(args.train)
    ds = FreeformDataset(tok, data, args.cutoff_len, args.require_thoughts)

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
    print(f'[OK] LoRA saved to: {args.out}')


def train_sft(args):
    if args.merge_only:
        if not PEFT_AVAILABLE:
            raise SystemExit('peft is required for --merge-only')
        if not args.lora:
            raise SystemExit('--merge-only requires --lora path')
        os.makedirs(args.out, exist_ok=True)
        base, tok = load_model_tok(args.model, args.bf16)
        merged = PeftModel.from_pretrained(base, args.lora)
        merged = merged.merge_and_unload()
        merged.save_pretrained(args.out)
        tok.save_pretrained(args.out)
        print(f'[OK] Merged model saved to: {args.out}')
        return

    if not args.train:
        raise SystemExit('--train required for sft mode (unless --merge-only)')
    os.makedirs(args.out, exist_ok=True)
    model, tok = load_model_tok(args.model, args.bf16)
    data = read_jsonl(args.train)
    ds = FreeformDataset(tok, data, args.cutoff_len, args.require_thoughts)

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
    print(f'[OK] SFT model saved to: {args.out}')


def main():
    ap = argparse.ArgumentParser(description='Train freeform thoughts mode (LoRA or SFT).')
    ap.add_argument('--mode', choices=['lora', 'sft'], required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--train')
    ap.add_argument('--out', required=True)
    ap.add_argument('--lora')
    ap.add_argument('--merge-only', action='store_true')

    # Style
    ap.add_argument('--require-thoughts', action='store_true', help='Require <THOUGHTS> section even if dataset omits it')
    ap.add_argument('--cutoff-len', type=int, default=2048)

    # HParams
    ap.add_argument('--batch-size', type=int, default=8)
    ap.add_argument('--grad-accum', type=int, default=2)
    ap.add_argument('--epochs', type=float, default=1.0)
    ap.add_argument('--lr', type=float, default=5e-6)
    ap.add_argument('--logging-steps', type=int, default=10)
    ap.add_argument('--bf16', action='store_true')

    # LoRA
    ap.add_argument('--lora-r', type=int, default=16)
    ap.add_argument('--lora-alpha', type=int, default=16)
    ap.add_argument('--lora-dropout', type=float, default=0.05)
    ap.add_argument('--lora-targets', help='Comma-separated target modules (e.g., q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj)')

    args = ap.parse_args()
    if args.mode == 'lora':
        train_lora(args)
    else:
        train_sft(args)


if __name__ == '__main__':
    main()

