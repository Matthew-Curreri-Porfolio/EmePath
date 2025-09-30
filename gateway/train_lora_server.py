"""
Script to fine‑tune a base language model with a LoRA adapter.

This module trains a LoRA adapter on top of a pretrained base model using
the Hugging Face ``transformers`` and ``peft`` libraries.  The adapter can
later be merged into the base model or loaded independently to modify
the model’s outputs without altering its original weights.  The training
is performed with a standard causal language modeling objective, so your
dataset should consist of raw text entries.

Usage example::

    python train_lora.py \
        --base_model   gpt2 \
        --dataset_name wikitext \
        --dataset_split train \
        --output_dir   ./lora_gpt2_adapter \
        --lora_r       8 \
        --lora_alpha   16 \
        --lora_dropout 0.05 \
        --num_epochs   3 \
        --batch_size   2 \
        --learning_rate 2e-4

After running, the directory specified by ``--output_dir`` will contain
the LoRA adapter weights (in ``adapter_model.bin``) and associated
configuration files.  You can load the adapter into the base model at
inference time via ``PeftModel.from_pretrained`` or ``model.load_adapter``.

Note
----
Depending on the size of your base model and dataset, training can
consume significant GPU memory and time.  Adjust the hyperparameters and
batch size to suit your hardware.  For more control over training
behaviour, consult the ``transformers.TrainingArguments`` documentation.
"""

import argparse
from dataclasses import dataclass, field
from typing import Optional, List

from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)
from datasets import load_dataset
from peft import LoraConfig, get_peft_model


@dataclass
class ScriptArguments:
    """Command‑line arguments for LoRA fine‑tuning."""

    base_model: str = field(
        metadata={"help": "Pretrained model identifier or path (e.g. 'gpt2')"}
    )
    dataset_name: str = field(
        metadata={"help": "Name or path of the dataset (HF hub ID or local)"}
    )
    dataset_split: str = field(
        default="train",
        metadata={"help": "Dataset split to use for training (e.g. 'train')"},
    )
    text_column: str = field(
        default="text",
        metadata={"help": "Column in the dataset that contains the training text"},
    )
    output_dir: str = field(
        metadata={"help": "Directory to save the trained LoRA adapter"}
    )
    lora_r: int = field(default=8, metadata={"help": "LoRA rank (r)"})
    lora_alpha: int = field(default=16, metadata={"help": "LoRA scaling (alpha)"})
    lora_dropout: float = field(default=0.05, metadata={"help": "LoRA dropout rate"})
    target_modules: Optional[List[str]] = field(
        default_factory=lambda: [
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
        ],
        metadata={"help": "List of module names to apply LoRA to"},
    )
    num_epochs: int = field(default=3, metadata={"help": "Number of training epochs"})
    batch_size: int = field(default=2, metadata={"help": "Training batch size per device"})
    learning_rate: float = field(default=2e-4, metadata={"help": "Learning rate"})
    max_seq_length: int = field(
        default=512,
        metadata={"help": "Maximum sequence length for tokenization"},
    )
    fp16: bool = field(default=False, metadata={"help": "Use 16‑bit floating point training"})


def parse_args() -> ScriptArguments:
    parser = argparse.ArgumentParser(description="Train a LoRA adapter on a base model")
    for field_name, field_def in ScriptArguments.__dataclass_fields__.items():
        arg_name = field_name.replace("_", "-")
        kwargs = field_def.metadata or {}
        if field_def.type is bool:
            # booleans use action store_true/store_false
            parser.add_argument(
                f"--{arg_name}",
                action="store_true" if not field_def.default else "store_false",
                help=kwargs.get("help", None),
            )
        else:
            parser.add_argument(
                f"--{arg_name}",
                type=field_def.type,
                default=field_def.default,
                help=kwargs.get("help", None),
                nargs="+" if field_def.type == List[str] else None,
            )
    args = parser.parse_args()
    return ScriptArguments(**vars(args))


def main(args: ScriptArguments):
    # Load dataset.  ``load_dataset`` supports both HF Hub datasets and local files.
    try:
        dataset = load_dataset(args.dataset_name, split=args.dataset_split)
    except Exception as e:
        raise RuntimeError(f"Failed to load dataset {args.dataset_name}: {e}")

    # Initialize tokenizer and model.
    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    model = AutoModelForCausalLM.from_pretrained(args.base_model)

    # Prepare LoRA configuration.  The target_modules may need adjustment
    # depending on the architecture of your base model; common module names
    # include "q_proj", "k_proj", "v_proj", and "o_proj" for GPT‑like models.
    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=args.target_modules,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
    )

    # Wrap the base model with the LoRA adapter.  Only the adapter parameters
    # will be trainable; the original base model weights remain frozen.
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # Tokenization function.  Remove unused columns to prevent Trainer from
    # complaining about unexpected fields.
    def tokenize_function(batch):
        text_list = batch[args.text_column]
        return tokenizer(
            text_list,
            max_length=args.max_seq_length,
            padding="max_length",
            truncation=True,
        )

    tokenized_dataset = dataset.map(
        tokenize_function,
        batched=True,
        remove_columns=[args.text_column],
    )

    data_collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,
    )

    training_args = TrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.batch_size,
        num_train_epochs=args.num_epochs,
        learning_rate=args.learning_rate,
        fp16=args.fp16,
        logging_steps=50,
        save_strategy="epoch",
        save_total_limit=1,
        gradient_checkpointing=False,
        remove_unused_columns=True,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized_dataset,
        data_collator=data_collator,
    )

    # Train the LoRA adapter.
    trainer.train()

    # Save only the adapter and its config.  The tokenizer is saved for
    # convenience, though it remains identical to the base model's tokenizer.
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    print(f"LoRA adapter saved to {args.output_dir}")


if __name__ == "__main__":
    args = parse_args()
    main(args)