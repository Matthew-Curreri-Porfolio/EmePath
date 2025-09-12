#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------------------
# Config (override via env)
# ------------------------------------------------------------------------------
LHOST="${LHOST:-127.0.0.1}"
LPORT="${LPORT:-11434}"
GATEWAY_PORT="${GATEWAY_PORT:-3030}"
BASE="${BASE:-http://127.0.0.1:${GATEWAY_PORT}}"

LLAMA_BIN="${LLAMA_BIN:-./llama.cpp/build/bin/llama-server}"
LLAMA_CLI="${LLAMA_CLI:-./llama.cpp/build/bin/llama-cli}"   # optional (deep probing)
MODEL_ARG="${MODEL_ARG:-}"                                   # Ollama ID OR /abs/path/to/model.gguf
DEEP="${DEEP:-0}"                                            # 1 = probe max -ngl with llama-cli
WRITE_PROFILE="${WRITE_PROFILE:-1}"                          # 1 = write JSON (optional)
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"                      # 1 = restart gateway binding to LLAMACPP_SERVER

LOG_DIR="gateway/logs"
LLAMA_LOG="$LOG_DIR/llama-server.log"
GATEWAY_LOG="$LOG_DIR/gateway.out"
PROFILE_JSON="gateway/db/hw-profiles.json"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERR: missing $1"; exit 1; }; }
os_name() { uname -s | tr '[:upper:]' '[:lower:]'; }

kill_on_port() {
  local port="$1"
  local pids
  pids="$(lsof -t -i :"$port" || true)"
  if [[ -n "$pids" ]]; then
    echo "[*] Killing listeners on :$port -> $pids"
    kill $pids || true
    sleep 1
    pids="$(lsof -t -i :"$port" || true)"
    [[ -n "$pids" ]] && { echo "[*] SIGKILL stubborn :$port -> $pids"; kill -9 $pids || true; }
  fi
}

wait_http_ok() { # url method body timeout
  local url="$1" method="${2:-GET}" body="${3:-}" timeout="${4:-30}"
  local t=0
  while (( t < timeout )); do
    if [[ "$method" = "POST" ]]; then
      if curl -fsS -m 3 -X POST "$url" -H 'content-type: application/json' -d "${body:-{}}" >/dev/null 2>&1; then return 0; fi
    else
      if curl -fsS -m 3 "$url" >/dev/null 2>&1; then return 0; fi
    fi
    sleep 1; t=$((t+1))
  done
  return 1
}

# ------------------------------------------------------------------------------
# Hardware detection (Linux + macOS)
# ------------------------------------------------------------------------------
detect_cpu_threads() {
  if command -v nproc >/dev/null 2>&1; then nproc
  elif command -v getconf >/dev/null 2>&1; then getconf _NPROCESSORS_ONLN
  elif [[ "$(os_name)" == "darwin" ]]; then sysctl -n hw.ncpu
  else echo 8; fi
}

detect_total_mem_gib() {
  if [[ -r /proc/meminfo ]]; then
    awk '/MemTotal:/ {printf "%.0f\n", $2/1024/1024}' /proc/meminfo
  elif [[ "$(os_name)" == "darwin" ]]; then
    sysctl -n hw.memsize | awk '{printf "%.0f\n", $1/1024/1024/1024}'
  else
    echo 16
  fi
}

detect_gpu() {
  # Emits: GPU_VENDOR, GPU_NAME, GPU_MEM_GIB, GPU_CC (compute cap if NVIDIA)
  GPU_VENDOR="cpu"; GPU_NAME=""; GPU_MEM_GIB=0; GPU_CC=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    local ln mm
    ln="$(nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader 2>/dev/null | head -n1 || true)"
    if [[ -n "$ln" ]]; then
      GPU_VENDOR="nvidia"
      GPU_NAME="$(echo "$ln" | awk -F, '{print $1}' | sed 's/^ *//;s/ *$//')"
      mm="$(echo "$ln" | awk -F, '{print $2}' | sed 's/[^0-9.]//g')" # MiB number like 24564
      GPU_MEM_GIB="$(awk -v m="$mm" 'BEGIN{printf "%.0f\n", m/1024}')"
      GPU_CC="$(echo "$ln" | awk -F, '{print $3}' | sed 's/^ *//;s/ *$//')"
      return
    fi
  fi
  if command -v rocm-smi >/dev/null 2>&1; then
    GPU_VENDOR="amd"
    GPU_NAME="$(rocm-smi --showproductname 2>/dev/null | awk -F':' '/Card series/{print $2; exit}' | sed 's/^ *//;s/ *$//')"
    GPU_MEM_GIB="$(rocm-smi --showmeminfo vram 2>/dev/null | awk '/Total VRAM/ {printf "%.0f\n", $4/1024/1024; exit}')"
    return
  fi
  if command -v rocminfo >/dev/null 2>&1; then
    GPU_VENDOR="amd"
    GPU_NAME="$(rocminfo 2>/dev/null | awk -F':' '/Name:/ {print $2; exit}' | sed 's/^ *//;s/ *$//')"
    GPU_MEM_GIB=0
    return
  fi
  if [[ "$(os_name)" == "darwin" ]]; then
    GPU_VENDOR="apple"
    GPU_NAME="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F: '/Chipset Model/ {print $2; exit}' | sed 's/^ *//;s/ *$//')"
    GPU_MEM_GIB=0
  fi
}

# ------------------------------------------------------------------------------
# Model resolution (Ollama ID -> GGUF or absolute path passthrough)
# ------------------------------------------------------------------------------
discover_ollama_roots() {
  local roots=()
  [[ -d "$HOME/.ollama/models" ]] && roots+=("$HOME/.ollama/models")
  [[ -d "/root/.ollama/models" ]] && roots+=("/root/.ollama/models")
  [[ -d "/var/snap/ollama/common/models" ]] && roots+=("/var/snap/ollama/common/models")
  [[ -d "/var/lib/ollama/models" ]] && roots+=("/var/lib/ollama/models")
  [[ -d "/usr/local/var/ollama/models" ]] && roots+=("/usr/local/var/ollama/models")
  [[ -d "/opt/homebrew/var/ollama/models" ]] && roots+=("/opt/homebrew/var/ollama/models")
  [[ -d "/usr/share/ollama/.ollama/models" ]] && roots+=("/usr/share/ollama/.ollama/models")
  echo "${roots[*]}"
}

try_blob_paths() {
  local tok="$1" roots; roots="$(discover_ollama_roots)"
  for root in $roots; do
    for nm in "$tok" "sha256-$tok"; do
      for sub in "blobs/$nm" "$nm"; do
        local p="$root/$sub"
        [[ -f "$p" ]] && { echo "$p"; return 0; }
      done
    done
  done
  return 1
}

scan_newest_gguf_blob() {
  local roots; roots="$(discover_ollama_roots)"
  local cands=""
  for r in $roots; do
    [[ -d "$r/blobs" ]] && cands+=$'\n'"$(find "$r/blobs" -maxdepth 1 -type f -size +500M -printf "%T@ %p\n" 2>/dev/null)"
  done
  cands="$(echo "$cands" | sed '/^\s*$/d' | sort -nr | awk '{print $2}')"
  local f
  for f in $cands; do
    if dd if="$f" bs=1 count=4 2>/dev/null | grep -qx "GGUF"; then
      echo "$f"; return 0
    fi
  done
  return 1
}

resolve_model_path() {
  local arg="$1"
  if [[ -z "$arg" ]]; then echo "ERR: MODEL_ARG required" >&2; return 1; fi
  if [[ "$arg" = /* && -f "$arg" ]]; then echo "$arg"; return 0; fi
  if ! command -v ollama >/dev/null 2>&1; then
    echo "ERR: 'ollama' not found to resolve model id '$arg'. Provide an absolute .gguf path in MODEL_ARG." >&2
    return 1
  fi

  # Follow FROM chain in the Modelfile (no JSON flags required)
  local cur="$arg" tries=0
  while (( tries < 4 )); do
    local mf tok p
    mf="$(ollama show --modelfile "$cur" 2>/dev/null || true)"
    if ! grep -qE '^FROM[[:space:]]+' <<<"$mf"; then
      ollama pull "$cur" >/dev/null 2>&1 || true
      mf="$(ollama show --modelfile "$cur" 2>/dev/null || true)"
    fi
    tok="$(awk '/^FROM[[:space:]]+/ {print $2; exit}' <<<"$mf")"
    [[ -z "$tok" ]] && break
    p="$(try_blob_paths "$tok" || true)"
    [[ -n "$p" ]] && { echo "$p"; return 0; }
    cur="$tok"; tries=$((tries+1))
  done

  # Fallback: newest GGUF blob across all known stores
  if p="$(scan_newest_gguf_blob)"; then
    echo "$p"; return 0
  fi

  echo "ERR: Could not resolve Ollama id '$arg' to a local GGUF blob." >&2
  return 1
}

# ------------------------------------------------------------------------------
# Parameter heuristics (safe defaults + optional deep probe for -ngl)
# ------------------------------------------------------------------------------
guess_layers() { # from file name
  local s="${1,,}"
  if grep -qE '(7b|8b)' <<<"$s"; then echo 32; return; fi
  if grep -q '13b' <<<"$s"; then echo 40; return; fi
  if grep -q '32b' <<<"$s"; then echo 60; return; fi
  if grep -q '70b' <<<"$s"; then echo 80; return; fi
  echo 40
}

calc_ngl_quick() { # memGiB fileMB layersGuess
  local mem="$1" fileMB="$2" layers="$3"
  if (( mem <= 2 )); then echo 0; return; fi
  local usableMiB=$(( (mem-2) * 1024 ))
  local ngl=0
  if (( fileMB > 0 && layers > 0 )); then
    ngl=$(( usableMiB * layers / fileMB ))
    (( ngl < 0 )) && ngl=0
    (( ngl > layers )) && ngl="$layers"
  fi
  echo "$ngl"
}

probe_max_ngl() { # modelPath
  local model="$1"
  [[ -x "$LLAMA_CLI" ]] || { echo 0; return; }
  local hi=1 lastOK=0
  while (( hi <= 160 )); do
    if "$LLAMA_CLI" -m "$model" --prompt ping --n-predict 8 -ngl "$hi" --no-perf >/dev/null 2>&1; then
      lastOK=$hi; hi=$((hi*2))
    else
      break
    fi
  done
  local L="$lastOK" R="$((hi-1))"
  (( R < L )) && { echo "$L"; return; }
  while (( L < R )); do
    local mid=$(( (L+R+1)/2 ))
    if "$LLAMA_CLI" -m "$model" --prompt ping --n-predict 8 -ngl "$mid" --no-perf >/dev/null 2>&1; then
      L="$mid"
    else
      R=$((mid-1))
    fi
  done
  echo "$L"
}

# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------
main() {
  need lsof; need curl
  [[ -x "$LLAMA_BIN" ]] || { echo "ERR: $LLAMA_BIN not found/executable"; exit 1; }

  mkdir -p "$LOG_DIR" gateway/db

  # Resolve model
  if [[ -z "$MODEL_ARG" ]]; then
    echo "ERR: Set MODEL_ARG to an Ollama id (e.g. qwen2.5-coder:7b-instruct) or /abs/path/model.gguf"
    exit 2
  fi
  echo "[*] Resolving model: $MODEL_ARG"
  MODEL_PATH="$(resolve_model_path "$MODEL_ARG")" || exit 3
  echo "[*] Model path: $MODEL_PATH"
  FILE_MB=$(awk -v b="$(stat -c%s "$MODEL_PATH" 2>/dev/null || stat -f%z "$MODEL_PATH")" 'BEGIN{printf "%.0f", b/1024/1024}')

  # Detect hardware
  detect_gpu
  CPU_THREADS="$(detect_cpu_threads)"
  TOTAL_MEM_GIB="$(detect_total_mem_gib)"
  echo "[*] CPU threads: $CPU_THREADS | System RAM: ${TOTAL_MEM_GIB}GiB"
  echo "[*] GPU: vendor=${GPU_VENDOR} name='${GPU_NAME}' mem=${GPU_MEM_GIB}GiB cc=${GPU_CC:-N/A}"

  # Compute safe params
  LAYERS_GUESS="$(guess_layers "$MODEL_PATH")"
  if [[ "$DEEP" = "1" && -x "$LLAMA_CLI" && "$GPU_VENDOR" != "cpu" ]]; then
    NGL="$(probe_max_ngl "$MODEL_PATH")"
  else
    NGL="$(calc_ngl_quick "${GPU_MEM_GIB:-0}" "$FILE_MB" "$LAYERS_GUESS")"
  fi
  if (( CPU_THREADS >= 8 )); then THREADS=$((CPU_THREADS-1)); else THREADS=$CPU_THREADS; fi
  if [[ "$GPU_VENDOR" == "nvidia" || "$GPU_VENDOR" == "amd" || "$GPU_VENDOR" == "apple" ]]; then
    if (( ${GPU_MEM_GIB:-0} >= 24 )); then BATCH=2048; CTX=8192
    elif (( ${GPU_MEM_GIB:-0} >= 16 )); then BATCH=1536; CTX=6144
    else BATCH=1024; CTX=4096; fi
  else
    BATCH=512; CTX=4096
  fi
  UBATCH=$((BATCH/2))

  echo "[*] Params: -ngl $NGL --threads $THREADS --ctx-size $CTX --batch-size $BATCH --ubatch-size $UBATCH"

  # Start llama-server
  kill_on_port "$LPORT"
  echo "[*] Starting llama-server on $LHOST:$LPORT …"
  nohup "$LLAMA_BIN" \
    -m "$MODEL_PATH" \
    --host "$LHOST" --port "$LPORT" \
    --ctx-size "$CTX" --batch-size "$BATCH" --ubatch-size "$UBATCH" \
    -ngl "$NGL" --threads "$THREADS" --flash-attn auto \
    > "$LLAMA_LOG" 2>&1 & disown
  sleep 1

  # llama.cpp expects GET /v1/models – not POST
  if ! wait_http_ok "http://$LHOST:$LPORT/v1/models" GET "" 45; then
    echo "ERR: llama-server not ready on http://$LHOST:$LPORT"
    tail -n 120 "$LLAMA_LOG" || true
    exit 4
  fi
  echo "[*] llama-server is ready @ http://$LHOST:$LPORT"

  # Optionally restart gateway pointing to this server
  export LLAMACPP_SERVER="http://$LHOST:$LPORT"
  if [[ "$RESTART_GATEWAY" = "1" ]]; then
    echo "[*] Restarting gateway on :$GATEWAY_PORT with LLAMACPP_SERVER=$LLAMACPP_SERVER …"
    kill_on_port "$GATEWAY_PORT"
    nohup env LLAMACPP_SERVER="$LLAMACPP_SERVER" npm --prefix gateway run start > "$GATEWAY_LOG" 2>&1 & disown
    sleep 1
    wait_http_ok "$BASE/health" GET "" 30 || { echo "ERR: gateway /health not ready"; exit 5; }
    wait_http_ok "$BASE/ready"  GET "" 45 || { echo "ERR: gateway /ready not OK"; exit 6; }
  fi

  # Optional profile write (for humans; not required for running)
  if [[ "$WRITE_PROFILE" = "1" ]]; then
    TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mkdir -p "$(dirname "$PROFILE_JSON")"
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
        "name": "${GPU_NAME//\"/'}",
        "memGiB": ${GPU_MEM_GIB:-0},
        "compute": "${GPU_CC:-}"
      }]
    },
    "model": "$MODEL_PATH",
    "fileMB": $FILE_MB,
    "layersGuess": $LAYERS_GUESS,
    "threads": $THREADS,
    "ctx": $CTX,
    "batch": $BATCH,
    "ubatch": $UBATCH,
    "ngl": $NGL,
    "env": {},
    "recommend": {
      "server": {
        "cmd": "$(readlink -f "$LLAMA_BIN" 2>/dev/null || echo "$LLAMA_BIN")",
        "args": ["-m","$MODEL_PATH","--host","$LHOST","--port","$LPORT","--ctx-size","$CTX","--batch-size","$BATCH","--ubatch-size","$UBATCH","-ngl","$NGL","--threads","$THREADS","--flash-attn","auto"],
        "env": {}
      },
      "m2m": {
        "serverHints": { "temperature":0.2,"top_p":0.8,"repeat_penalty":1.05,"ctx_size":$CTX,"batch":$BATCH,"ubatch":$UBATCH },
        "clientDefaults": { "temperature":0.2,"max_tokens":256,"presence_penalty":0.0,"frequency_penalty":0.0 }
      }
    }
  },
  "users": {}
}
JSON
    echo "[*] Wrote $PROFILE_JSON"
  fi

  echo "[*] Ready."
  echo "    - tail -f $LLAMA_LOG"
  echo "    - tail -f $GATEWAY_LOG"
  echo "    - curl -s http://127.0.0.1:$GATEWAY_PORT/health | jq ."
}

main "$@"
