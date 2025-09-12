#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   tools/train-personal.sh -m <OLLAMA_MODEL> -u <USER_ID> [-n new_name] [--rank 16] [--alpha 16] [--epochs 2]
# Example:
#   tools/train-personal.sh -m qwen2.5-coder:7b-instruct -u user_123 -n qwen2.5-coder:7b-matt ---epochs 1

# Hard deps we use:
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1"; exit 1; }; }
need ollama
need awk
need sed
need node
need jq || { echo "jq is optional but recommended"; }

# Defaults
RANK="${RANK:-16}"
ALPHA="${ALPHA:-16}"
EPOCHS="${EPOCHS:-2}"
LR="${LR:-1e-4}"
SEQ_LEN="${SEQ_LEN:-2048}"

NEW_NAME=""
MODEL=""
USER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model) MODEL="$2"; shift 2;;
    -u|--user) USER="$2"; shift 2;;
    -n|--name) NEW_NAME="$2"; shift 2;;
    --rank) RANK="$2"; shift 2;;
    --alpha) ALPHA="$2"; shift 2;;
    --epochs) EPOCHS="$2"; shift 2;;
    --lr) LR="$2"; shift 2;;
    --seq-len) SEQ_LEN="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 2;;
  esac
done

[[ -n "$MODEL" && -n "$USER" ]] || { echo "Usage: -m <ollama_model> -u <user_id> [-n new_name] [--rank N] [--alpha N] [--epochs N]"; exit 2; }

# Resolve base GGUF path from Ollama Modelfile (FROM …)
echo "[*] Resolving base GGUF for model: $MODEL"
MODFILE="$(ollama show --modelfile "$MODEL")"
FROM_LINE="$(printf "%s\n" "$MODFILE" | awk '/^FROM[[:space:]]/{print; exit}')"
BASE_PATH="$(printf "%s\n" "$FROM_LINE" | awk '{print $2}')"
if [[ ! -f "$BASE_PATH" ]]; then
  echo "ERR: Could not resolve local GGUF path from 'FROM' line: $FROM_LINE"
  echo "Tip: ensure the model is pulled locally: ollama pull $MODEL"
  exit 3
fi
echo "    base GGUF: $BASE_PATH"

# Models root (…/models)
MODELS_ROOT="$(dirname "$(dirname "$BASE_PATH")")"
echo "    models root: $MODELS_ROOT"

# Paths
TRAIN_DIR="$MODELS_ROOT/datasets/$USER"
ADAPT_DIR="$MODELS_ROOT/adapters/$USER"
MODEL_DIR="$MODELS_ROOT/modelfiles/$USER"
mkdir -p "$TRAIN_DIR" "$ADAPT_DIR" "$MODEL_DIR"

# Export dataset JSONL
TRAINID="$(date -u +%Y%m%dT%H%M%SZ)_$USER"
DATA_JSONL="$TRAIN_DIR/${TRAINID}.jsonl"
echo "[*] Exporting training JSONL for user=$USER → $DATA_JSONL"
node "$PWD/gateway/scripts/export-training-jsonl.js" --user "$USER" --out "$DATA_JSONL" --trainid "$TRAINID"

LINES=$(wc -l < "$DATA_JSONL" || echo 0)
[[ "$LINES" -gt 0 ]] || { echo "ERR: dataset is empty"; exit 4; }

# Train LoRA adapter via llama.cpp if available
ADAPTER_GGUF="$ADAPT_DIR/${TRAINID}.gguf"
if command -v llama-finetune >/dev/null 2>&1; then
  echo "[*] llama-finetune found. Starting LoRA training (epochs=$EPOCHS, r=$RANK, alpha=$ALPHA)…"
  # NOTE: CLI flags can vary by build; this is the common pattern in recent builds.
  # If your build differs, run: `llama-finetune --help` and adjust FINETUNE_ARGS below.
  FINETUNE_ARGS=(
    -m "$BASE_PATH"
    --train-data "$DATA_JSONL"
    --lora-out "$ADAPTER_GGUF"
    --lora-r "$RANK"
    --lora-alpha "$ALPHA"
    --epochs "$EPOCHS"
    --seq-len "$SEQ_LEN"
    --lr "$LR"
  )
  echo "    cmd: llama-finetune ${FINETUNE_ARGS[*]}"
  llama-finetune "${FINETUNE_ARGS[@]}"
else
  echo "[!] llama-finetune not found. Skipping auto-train."
  echo "    To build llama.cpp and train:"
  echo "      git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp"
  echo "      cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release"
  echo "      ./build/bin/llama-finetune -m \"$BASE_PATH\" --train-data \"$DATA_JSONL\" --lora-out \"$ADAPTER_GGUF\" --lora-r $RANK --lora-alpha $ALPHA --epochs $EPOCHS --seq-len $SEQ_LEN --lr $LR"
  echo "    Or train with Unsloth/HF, then convert LoRA to GGUF and place it at:"
  echo "      $ADAPTER_GGUF"
fi

# Ensure adapter exists
if [[ ! -f "$ADAPTER_GGUF" ]]; then
  echo "[!] Adapter not found at $ADAPTER_GGUF. Create it as shown above, then re-run this script to register."
  exit 5
fi

# Compose Modelfile (reuse upstream Modelfile template + add ADAPTER)
NEW_NAME="${NEW_NAME:-${MODEL%%:*}}-${USER}-lora"
MODEFILE="$MODEL_DIR/${NEW_NAME}.Modelfile"
echo "[*] Writing Modelfile → $MODEFILE"
{
  # reuse the FROM line with absolute path, drop other FROMs
  echo "FROM $BASE_PATH"
  # carry over TEMPLATE / PARAMETERS if present in upstream modelfile
  printf "%s\n" "$MODFILE" | awk 'p==1{print} /^TEMPLATE|^PARAMETER|^SYSTEM/ {p=1}' || true
  echo "ADAPTER $ADAPTER_GGUF"
} > "$MODEFILE"

# Register new model in Ollama
echo "[*] Creating model in Ollama: $NEW_NAME"
ollama create "$NEW_NAME" -f "$MODEFILE"

echo "[*] Smoke test (one prompt):"
echo "    ollama run $NEW_NAME -p 'Say: adapter online.'"
echo "[OK] Done. New model: $NEW_NAME"
