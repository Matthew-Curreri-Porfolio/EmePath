#!/usr/bin/env bash
set -Eeuo pipefail

# ───────────────────────────── CONFIG / DEFAULTS ─────────────────────────────
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$PROJECT_ROOT"

: "${GATEWAY_PORT:=3123}"
: "${LLAMACPP_PORT:=8080}"
: "${OLLAMA_PORT:=11434}"
: "${LHOST:=127.0.0.1}"

: "${LLAMA_BIN:=$PROJECT_ROOT/llama.cpp/build/bin/llama-server}"
: "${LLAMA_CLI:=$PROJECT_ROOT/llama.cpp/build/bin/llama-cli}"
[[ -n "${LLAMACPP_SERVER_BIN:-}" ]] && LLAMA_BIN="$LLAMACPP_SERVER_BIN"

# Accept: "namespace/name:tag", absolute .gguf path, or sha256:<digest>
: "${MODEL_REF:=SimonPu/gpt-oss:20b_Q4_K_M}"

# toggles
: "${DEEP:=0}"           # probe max -ngl with llama-cli
: "${OLLAMA_PROXY:=1}"   # start the proxy
: "${WRITE_PROFILE:=1}"

BASE="http://127.0.0.1:${GATEWAY_PORT}"

LOG_DIR="$PROJECT_ROOT/gateway/logs"
PROFILE_JSON="$PROJECT_ROOT/gateway/db/hw-profiles.json"
mkdir -p "$LOG_DIR" "$(dirname "$PROFILE_JSON")"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERR: missing $1" >&2; exit 1; }; }
need pm2; need curl; need jq; need python3

wait_http_ok() { local url="$1" timeout="${2:-30}" t=0; while (( t < timeout )); do curl -fsS -m 3 "$url" >/dev/null 2>&1 && return 0; sleep 1; t=$((t+1)); done; return 1; }

detect_cpu_threads() {
  if command -v nproc >/dev/null 2>&1; then nproc
  elif command -v getconf >/dev/null 2>&1; then getconf _NPROCESSORS_ONLN
  else echo 8; fi
}
detect_gpu() {
  GPU_VENDOR="cpu"; GPU_NAME=""; GPU_MEM_GIB=0; GPU_CC=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    local ln; ln="$(nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader 2>/dev/null | head -n1 || true)"
    if [[ -n "$ln" ]]; then
      GPU_VENDOR="nvidia"
      GPU_NAME="$(awk -F, '{print $1}' <<<"$ln" | sed 's/^ *//;s/ *$//')"
      GPU_MEM_GIB="$(awk -F, '{print $2}' <<<"$ln" | sed 's/[^0-9.]//g' | awk '{printf "%.0f", $1/1024}')"
      GPU_CC="$(awk -F, '{print $3}' <<<"$ln" | sed 's/^ *//;s/ *$//')"
    fi
  fi
}

calc_ngl_quick() { # memGiB fileMB layers
  local mem="$1" fileMB="$2" layers="$3" usableMiB ngl=0
  (( mem <= 2 )) && { echo 0; return; }
  usableMiB=$(( (mem-2) * 1024 ))
  (( fileMB > 0 && layers > 0 )) && ngl=$(( usableMiB * layers / fileMB ))
  (( ngl < 0 )) && ngl=0
  (( ngl > layers )) && ngl="$layers"
  echo "$ngl"
}
probe_max_ngl() {
  local model="$1"
  [[ -x "$LLAMA_CLI" ]] || { echo 0; return; }
  local hi=1 lastOK=0
  while (( hi <= 160 )); do
    if "$LLAMA_CLI" -m "$model" --prompt ping --n-predict 8 -ngl "$hi" --no-perf >/dev/null 2>&1; then lastOK=$hi; hi=$((hi*2)); else break; fi
  done
  local L="$lastOK" R="$((hi-1))"; (( R < L )) && { echo "$L"; return; }
  while (( L < R )); do
    local mid=$(( (L+R+1)/2 ))
    if "$LLAMA_CLI" -m "$model" --prompt ping --n-predict 8 -ngl "$mid" --no-perf >/dev/null 2>&1; then L="$mid"; else R=$((mid-1)); fi
  done
  echo "$L"
}

discover_ollama_roots() {
  local roots=("$HOME/.ollama/models" "/var/snap/ollama/common/models" "/var/lib/ollama/models" "/usr/local/var/ollama/models" "/opt/homebrew/var/ollama/models" "/usr/share/ollama/.ollama/models")
  for r in "${roots[@]}"; do [[ -d "$r" ]] && echo "$r"; done
}
guess_id_from_digest() {
  local digest="${1#sha256:}"; digest="${digest#sha256-}"
  [[ "${#digest}" -eq 64 ]] || { echo ""; return 0; }
  local r m f rel
  for r in $(discover_ollama_roots); do
    m="$r/manifests"; [[ -d "$m" ]] || continue
    f="$(grep -RIl --binary-files=without-match -e "$digest" -e "sha256-$digest" "$m" 2>/dev/null | head -n1 || true)"
    [[ -n "$f" ]] || continue
    rel="${f#"$m"/}"
    IFS='/' read -r -a parts <<<"$rel"
    if [[ "${#parts[@]}" -eq 4 && "${parts[2]}" == "tags" ]]; then
      echo "${parts[0]}/${parts[1]}:${parts[3]}"; return 0
    fi
    if [[ "${#parts[@]}" -eq 4 ]]; then
      echo "${parts[1]}/${parts[2]}:${parts[3]}"; return 0
    fi
  done
  echo ""
}

pm2_del() { pm2 delete "$1" >/dev/null 2>&1 || true; }

start_gateway() {
  echo "[*] Starting gateway on :$GATEWAY_PORT (pm2: gateway)…"
  pm2_del gateway
  pm2 start --name gateway --cwd "$PROJECT_ROOT/gateway" --env "PORT=$GATEWAY_PORT" server.js
  wait_http_ok "$BASE/health" 30 || { echo "ERR: gateway /health not ready"; pm2 logs gateway --lines 160; exit 5; }
}

resolve_model_info() {
  local arg="$1"
  if [[ "$arg" =~ ^(sha256:)?[0-9a-fA-F]{64}$ ]]; then
    local id; id="$(guess_id_from_digest "$arg")"
    [[ -n "$id" ]] && { echo "[*] Mapped digest to Ollama id: $id" >&2; arg="$id"; }
  fi
  local enc url json
  enc="$(jq -nr --arg s "$arg" '$s|@uri')"
  url="$BASE/model/resolve?arg=$enc"
  json="$(curl -fsS "$url")" || { echo "ERR: resolve failed @$url" >&2; exit 6; }
  local p; p="$(jq -r '.resolvedPath // ""' <<<"$json")"
  [[ -n "$p" && -f "$p" ]] || { echo "ERR: bad resolvedPath"; echo "$json"; exit 6; }
  echo "$json"
}

# Pull PARAMETERs out of Modelfile chain → JSON object of lowercase keys
extract_params_from_chain() { # stdin: MODEL_JSON
  python3 - <<'PY'
import json, re, sys, pathlib
doc=json.load(sys.stdin)
files=[]
chain = (doc.get("modelfile",{}) or {}).get("chain") or []
for c in chain:
    p=c.get("modelfile")
    if p: files.append(p)
# fallback to just the last modelfile path if present
last = (doc.get("modelfile",{}) or {}).get("modelfile")
if last and last not in files:
    files.append(last)

def parse_file(p):
    out={}
    try:
        txt=pathlib.Path(p).read_text(encoding='utf-8', errors='ignore').splitlines()
    except Exception:
        return out
    rx=re.compile(r'^\s*(?:PARAMETER|PARAM)\s+([A-Za-z0-9_\-]+)\s+(.*?)\s*$',
                  re.IGNORECASE)
    for ln in txt:
        m=rx.match(ln)
        if not m: continue
        k=m.group(1).lower().replace('-','_')
        v=m.group(2)
        # strip trailing comments
        v=re.sub(r'\s+#.*$','',v).strip()
        # unquote once if needed
        if len(v)>=2 and (v[0]==v[-1]) and v[0] in "\"'":
            v=v[1:-1]
        out[k]=v
    return out

merged={}
for f in files:
    for k,v in parse_file(f).items():
        merged[k]=v  # later files override earlier
print(json.dumps(merged))
PY
}

# Map Modelfile params to llama-server flags
build_llama_args() { # MODEL_JSON -> emits bash array assign LLAMA_ARGS=()
  local MODEL_JSON="$1"
  local MODEL_PATH; MODEL_PATH="$(jq -r '.resolvedPath' <<<"$MODEL_JSON")"
  local FILE_MB; FILE_MB="$(stat -c%s "$MODEL_PATH" 2>/dev/null || stat -f%z "$MODEL_PATH")"
  FILE_MB="$(awk -v b="$FILE_MB" 'BEGIN{printf "%.0f", b/1024/1024}')"
  local LAYERS; LAYERS="$(jq -r '.hparams.block_count // .meta.block_count // empty' <<<"$MODEL_JSON")"
  [[ -z "$LAYERS" || "$LAYERS" = "null" ]] && LAYERS=40

  local PARAMS; PARAMS="$(jq -c . <<<"$(extract_params_from_chain <<<"$MODEL_JSON")")"

  # helpers
  getp(){ jq -r --arg k "$1" '(.[$k] // empty)' <<<"$PARAMS"; }
  norm_bool(){ case "${1,,}" in 1|true|yes|on) echo on;; 0|false|no|off) echo off;; auto) echo auto;; *) echo "";; esac; }

  # threads / ctx / batch / ubatch
  local THREADS CTX BATCH UBATCH
  THREADS="$(getp num_threads)"; [[ -z "$THREADS" || "$THREADS" = "null" ]] && THREADS="$(detect_cpu_threads)"
  CTX="$(getp num_ctx)"; [[ -z "$CTX" || "$CTX" = "null" ]] && CTX=4096
  BATCH="$(getp num_batch)"; [[ -z "$BATCH" || "$BATCH" = "null" ]] && BATCH=512
  UBATCH="$(getp num_ubatch)"; [[ -z "$UBATCH" || "$UBATCH" = "null" ]] && UBATCH=$(( BATCH / 2 ))

  # gpu layers
  local NGL
  NGL="$(getp gpu_layers)"; [[ -z "$NGL" || "$NGL" = "null" ]] && NGL="$(getp num_gpu)"
  if [[ -z "$NGL" || "$NGL" = "null" ]]; then
    detect_gpu
    NGL="$(calc_ngl_quick "${GPU_MEM_GIB:-0}" "$FILE_MB" "$LAYERS")"
  fi
  if [[ "${DEEP:-0}" = "1" ]]; then
    local probed; probed="$(probe_max_ngl "$MODEL_PATH" 2>/dev/null || echo 0)"
    [[ "$probed" =~ ^[0-9]+$ ]] && NGL="$probed"
  fi

  # flash attention
  local FA RAW_FA
  RAW_FA="$(getp flash_attention)"; [[ -z "$RAW_FA" || "$RAW_FA" = "null" ]] && RAW_FA="$(getp flash_attn)"
  FA="$(norm_bool "$RAW_FA")"
  if [[ -z "$FA" ]]; then
    detect_gpu
    FA=$([[ "${GPU_VENDOR:-cpu}" = "nvidia" ]] && echo auto || echo off)
  fi

  # assemble
  LLAMA_ARGS=(
    -m "$MODEL_PATH"
    --host "$LHOST" --port "$LLAMACPP_PORT"
    --ctx-size "$CTX" --batch-size "$BATCH" --ubatch-size "$UBATCH"
    -ngl "$NGL" --threads "$THREADS"
    -fa "$FA"
  )
}

start_llama() {
  local MODEL_JSON="$1"

  [[ -n "${LLAMACPP_SERVER:-}" ]] && { echo "[*] External LLAMACPP_SERVER=$LLAMACPP_SERVER — skipping local llama-server."; return 0; }

  local MODEL_PATH; MODEL_PATH="$(jq -r '.resolvedPath' <<<"$MODEL_JSON")"
  echo "[*] Base model: $MODEL_PATH"

  # Collect LoRA/adapters from Modelfile chain
  local TOP_MF_DIR; TOP_MF_DIR="$(jq -r '.modelfile.chain[-1].modelfile? // .modelfile.modelfile? // empty' <<<"$MODEL_JSON" | xargs -r dirname || true)"
  mapfile -t ADAPTERS_RAW < <(jq -r '.modelfile.adapters[]? | select(.!=null and .!="")' <<<"$MODEL_JSON")

  local LORA_ARGS=()
  if (( ${#ADAPTERS_RAW[@]} )); then
    echo "[*] Adapters:"
    for a in "${ADAPTERS_RAW[@]}"; do
      local p="$a"
      if [[ "$a" != /* && -n "$TOP_MF_DIR" && -f "$TOP_MF_DIR/$a" ]]; then p="$TOP_MF_DIR/$a"; fi
      echo "    --lora $p"
      LORA_ARGS+=( --lora "$p" )
    done
  fi

  [[ -x "$LLAMA_BIN" ]] || { echo "ERR: $LLAMA_BIN not executable"; exit 1; }

  build_llama_args "$MODEL_JSON"

  echo "[*] Starting llama-server on :$LLAMACPP_PORT (pm2: llama)…"
  pm2_del llama
  pm2 start --name llama "$LLAMA_BIN" -- \
    "${LLAMA_ARGS[@]}" \
    "${LORA_ARGS[@]}"

  wait_http_ok "http://$LHOST:$LLAMACPP_PORT/v1/models" 60 || { echo "ERR: llama-server not ready"; pm2 logs llama --lines 200; exit 8; }
}

start_proxy() {
  [[ "${OLLAMA_PROXY}" = "1" ]] || { echo "[*] OLLAMA_PROXY=0 — skipping proxy."; return 0; }
  [[ -z "${LLAMACPP_SERVER:-}" ]] && export LLAMACPP_SERVER="http://$LHOST:$LLAMACPP_PORT"
  echo "[*] Starting ollama-proxy on :$OLLAMA_PORT (pm2: ollama-proxy)…"
  pm2_del ollama-proxy
  pm2 start --name ollama-proxy --interpreter python3 \
    --env "LLAMACPP_SERVER=$LLAMACPP_SERVER" \
    "$PROJECT_ROOT/gateway/scripts/llamacpp_ollama_proxy.py"
  wait_http_ok "http://127.0.0.1:${OLLAMA_PORT}/api/tags" 45 || { echo "ERR: ollama-proxy not ready"; pm2 logs ollama-proxy --lines 200; exit 9; }
}

finalize_gateway_env() {
  [[ -z "${LLAMACPP_SERVER:-}" ]] && export LLAMACPP_SERVER="http://$LHOST:$LLAMACPP_PORT"
  if [[ "${OLLAMA_PROXY}" = "1" && -z "${OLLAMA_URL:-}" ]]; then export OLLAMA_URL="http://127.0.0.1:${OLLAMA_PORT}"; fi
  echo "[*] Restarting gateway with LLAMACPP_SERVER=$LLAMACPP_SERVER OLLAMA_URL=${OLLAMA_URL:-unset}"
  pm2 restart gateway --update-env
  wait_http_ok "$BASE/health" 30 || { echo "ERR: gateway /health not ready after restart"; pm2 logs gateway --lines 200; exit 10; }
}

write_profile() {
  [[ "$WRITE_PROFILE" = "1" ]] || return 0
  local MODEL_JSON="$1" MODEL_PATH; MODEL_PATH="$(jq -r '.resolvedPath' <<<"$MODEL_JSON")"
  local SIZEB; SIZEB="$(stat -c%s "$MODEL_PATH" 2>/dev/null || stat -f%z "$MODEL_PATH")"
  local FILE_MB; FILE_MB="$(awk -v b="$SIZEB" 'BEGIN{printf "%.0f", b/1024/1024}')"
  local TS; TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  detect_gpu; local CPU_THREADS; CPU_THREADS="$(detect_cpu_threads)"
  cat > "$PROFILE_JSON" <<JSON
{
  "machine": {
    "id": "machine",
    "scope": "machine",
    "createdAt": "$TS",
    "updatedAt": "$TS",
    "hardware": {
      "type": "${GPU_VENDOR:-cpu}",
      "gpus": [{
        "vendor": "${GPU_VENDOR:-cpu}",
        "name": "${GPU_NAME//\"/\'}",
        "memGiB": ${GPU_MEM_GIB:-0},
        "compute": "${GPU_CC:-}"
      }]
    },
    "model": "$MODEL_PATH",
    "fileMB": $FILE_MB,
    "threads": $CPU_THREADS
  },
  "users": {}
}
JSON
  echo "[*] Wrote $PROFILE_JSON"
}

usage() {
  cat <<USAGE
Usage: $(basename "$0") {start|restart|up|stop|down|status|logs|save|check} [--model <ref>]
Env:
  MODEL_REF="namespace/name:tag" | "sha256:<digest>" | "/abs/model.gguf"
  GATEWAY_PORT=${GATEWAY_PORT}  LLAMACPP_PORT=${LLAMACPP_PORT}  OLLAMA_PORT=${OLLAMA_PORT}
  LHOST=${LHOST}  OLLAMA_PROXY=${OLLAMA_PROXY}  DEEP=${DEEP}  WRITE_PROFILE=${WRITE_PROFILE}
USAGE
}

ACTION="${1:-start}"; shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL_REF="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done 2>/dev/null || true

case "$ACTION" in
  start|restart|up)
    start_gateway
    MODEL_JSON="$(resolve_model_info "$MODEL_REF")"
    start_llama "$MODEL_JSON"
    start_proxy
    finalize_gateway_env
    write_profile "$MODEL_JSON"
    echo
    echo "[*] Up. Quick checks:"
    echo "    curl -s http://127.0.0.1:$GATEWAY_PORT/health | jq ."
    echo "    curl -s http://127.0.0.1:$LLAMACPP_PORT/v1/models | jq ."
    [[ "$OLLAMA_PROXY" = "1" ]] && echo "    curl -s http://127.0.0.1:$OLLAMA_PORT/api/tags | jq ."
    echo
    pm2 ls
    ;;
  stop|down)
    pm2_del ollama-proxy; pm2_del llama; pm2_del gateway
    echo "[*] Stopped."
    ;;
  status) pm2 ls ;;
  logs) pm2 logs --lines 160 ;;
  save) pm2 save; echo "[*] pm2 list saved." ;;
  check)
    echo "[*] Resolver:"
    curl -s "http://127.0.0.1:$GATEWAY_PORT/model/resolve?arg=$(jq -nr --arg s "$MODEL_REF" '$s|@uri')" | jq .
    echo "[*] Llama:"
    curl -s "http://127.0.0.1:$LLAMACPP_PORT/v1/models" | jq .
    ;;
  *) usage; exit 2 ;;
esac
