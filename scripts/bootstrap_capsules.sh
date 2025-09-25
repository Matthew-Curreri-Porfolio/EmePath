#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

root_dir="$(pwd)"
venv_dir="${root_dir}/.venv_capsule"
env_file="${root_dir}/.env"

mkdir -p tools gateway profiles scripts

if [ ! -f "${env_file}" ]; then
  key_hex="$(openssl rand -hex 32)"
  cat > "${env_file}" <<EOF
LLAMA_SERVER=http://127.0.0.1:8089
MODEL_A_PATH=/models/llama3.gguf
PCAP_KEY=${key_hex}
EOF
fi

python3 -m venv "${venv_dir}"
"${venv_dir}/bin/pip" install --upgrade pip wheel setuptools
"${venv_dir}/bin/pip" install fastapi uvicorn requests llama-cpp-python

cat > tools/prompt_capsule.py <<'PY'
#!/usr/bin/env python3
import argparse, base64, hashlib, hmac, json, os, struct, sys, zlib
from llama_cpp import Llama

def varint_pack(nums):
  b = bytearray()
  for n in nums:
    while True:
      byte = n & 0x7F
      n >>= 7
      if n != 0: b.append(byte | 0x80)
      else: b.append(byte); break
  return bytes(b)

def varint_unpack(b):
  out=[]; val=0; shift=0
  for byte in b:
    val |= (byte & 0x7F) << shift
    if byte & 0x80: shift += 7
    else: out.append(val); val=0; shift=0
  if shift!=0: raise ValueError("truncated varint")
  return out

def hmac256(key, data): return hmac.new(key, data, hashlib.sha256).hexdigest()

def load_tokenizer(model_path):
  return Llama(model_path=model_path, vocab_only=True, embedding=False, n_ctx=8)

def encode(model_path, prompt, key_hex=None, tokenizer_hint=None):
  llm = load_tokenizer(model_path)
  toks = llm.tokenize(prompt.encode("utf-8"), special=True)
  raw = varint_pack(toks)
  blob = zlib.compress(raw, 9)
  header = {
    "version":"PCAP-V1",
    "tokenizer": tokenizer_hint or os.path.basename(model_path),
    "tok_hash": hashlib.sha256((llm.metadata.get("tokenizer.ggml.model","") or "").encode()).hexdigest(),
    "enc":"b64+zlib+varint"
  }
  blob64 = base64.b64encode(blob).decode()
  mac = hmac256(bytes.fromhex(key_hex), (json.dumps(header,sort_keys=True).encode()+blob)) if key_hex else None
  return json.dumps({"header":header,"blob":blob64,"mac":mac})

def decode(modelA_path, capsule_json, key_hex=None):
  cap = json.loads(capsule_json)
  header, blob64, mac = cap["header"], cap["blob"], cap.get("mac")
  blob = base64.b64decode(blob64)
  if key_hex:
    expect = hmac256(bytes.fromhex(key_hex), (json.dumps(header,sort_keys=True).encode()+blob))
    if not hmac.compare_digest(expect, mac): raise SystemExit("HMAC mismatch")
  toks = varint_unpack(zlib.decompress(blob))
  llmA = load_tokenizer(modelA_path)
  text = llmA.detokenize(toks).decode("utf-8","replace")
  return text

if __name__ == "__main__":
  ap = argparse.ArgumentParser()
  sub = ap.add_subparsers(dest="cmd", required=True)
  e = sub.add_parser("encode"); e.add_argument("--model", required=True); e.add_argument("--key"); e.add_argument("--hint"); e.add_argument("--infile")
  d = sub.add_parser("decode"); d.add_argument("--modelA", required=True); d.add_argument("--key"); d.add_argument("--infile")
  args = ap.parse_args()
  if args.cmd=="encode":
    prompt = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
    print(encode(args.model, prompt, args.key, args.hint))
  else:
    capsule = sys.stdin.read() if not args.infile else open(args.infile,"r",encoding="utf-8").read()
    print(decode(args.modelA, capsule, args.key))
PY
chmod +x tools/prompt_capsule.py

cat > gateway/handoff_gateway.py <<'PY'
#!/usr/bin/env python3
import os, json, requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from tools.prompt_capsule import decode

load_dotenv()
LLAMA_SERVER = os.getenv("LLAMA_SERVER","http://127.0.0.1:8089")
MODEL_A_PATH = os.getenv("MODEL_A_PATH","/models/llama3.gguf")
KEY_HEX = os.getenv("PCAP_KEY","")

app = FastAPI()

class ChatReq(BaseModel):
  capsule: str
  user: str
  params: dict | None = None

@app.post("/chat")
def chat(r: ChatReq):
  try:
    sys_text = decode(MODEL_A_PATH, r.capsule, KEY_HEX if KEY_HEX else None)
  except Exception as e:
    raise HTTPException(status_code=400, detail=f"capsule error: {e}")
  payload = {
    "prompt": f"<<SYS>>{sys_text}<</SYS>>\n{r.user}",
    "temperature": (r.params or {}).get("temperature", 0.7),
    "cache_prompt": True
  }
  try:
    x = requests.post(f"{LLAMA_SERVER}/completion", json=payload, timeout=600)
    x.raise_for_status()
  except Exception as e:
    raise HTTPException(status_code=502, detail=f"llama.cpp upstream error: {e}")
  return x.json()
PY

cat > scripts/capsule_cli.sh <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${root_dir}/.env"
venv="${root_dir}/.venv_capsule/bin/python"
cmd="${1:-}"
shift || true
if [ "${cmd}" = "encode" ]; then
  in="${1:-profiles/incident_responder.sys.txt}"
  "${venv}" tools/prompt_capsule.py encode --model "${MODEL_A_PATH}" --key "${PCAP_KEY}" --hint "llama3" --infile "${in}"
elif [ "${cmd}" = "decode" ]; then
  in="${1:-system.pcap.json}"
  "${venv}" tools/prompt_capsule.py decode --modelA "${MODEL_A_PATH}" --key "${PCAP_KEY}" --infile "${in}"
else
  echo "usage: scripts/capsule_cli.sh encode|decode [file]"; exit 1
fi
SH
chmod +x scripts/capsule_cli.sh

cat > Makefile <<'MK'
VENV=.venv_capsule
PY=$(VENV)/bin/python
PIP=$(VENV)/bin/pip
ENV?=.env

gateway:
	$(VENV)/bin/uvicorn gateway.handoff_gateway:app --host 0.0.0.0 --port 9911

encode:
	scripts/capsule_cli.sh encode > system.pcap.json && echo "Wrote system.pcap.json"

decode:
	test -f system.pcap.json || (echo "missing system.pcap.json"; exit 1)
	scripts/capsule_cli.sh decode

MK

# Profiles (10)
cat > profiles/incident_responder.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Incident-Responder; Directives: terse, command-first, no hedging; Behaviors: assume outage, verify, remediate, report in bullets; Constraints: no speculation, prefer logs and status outputs; Output: cmds first, then 3-line rationale; Escalation: if root cause >15m, apply containment and open ticket.<</SYS>>
TXT

cat > profiles/red_team_automator.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Security Adversarial Simulator; Directives: legality-first, consent-locked, lab-only; Behaviors: enumerate, model, simulate, report; Constraints: do not provide illegal guidance; Output: detection-focused controls, purple-team artifacts; Tone: clinical.<</SYS>>
TXT

cat > profiles/linux_ops_copilot.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Linux Ops Copilot; Directives: urgent, no-nonsense; Behaviors: table→pseudocode→script; Constraints: safe bash defaults, rollback and verify; Output: commands only on request; Style: camelCase, no shorthand booleans.<</SYS>>
TXT

cat > profiles/code_review_enforcer.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Code Review Enforcer; Directives: objective, standards-first; Behaviors: flag risks, suggest minimal diffs; Constraints: no rewrites unless asked; Output: diff-style patches + test hints.<</SYS>>
TXT

cat > profiles/llm_orchestrator.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: LLM Orchestrator; Directives: multi-agent, deterministic; Behaviors: assign roles, route, summarize to JSON; Constraints: never reveal chain-of-thought; Output: tool calls + compact summaries.<</SYS>>
TXT

cat > profiles/data_pipeline_first_responder.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Data Pipeline First-Responder; Directives: stop the bleed; Behaviors: isolate bad inputs, backfill, validate; Constraints: immutable logs, idempotent reruns; Output: runbook steps with checksums and counts.<</SYS>>
TXT

cat > profiles/api_gateway_architect.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: API Gateway Architect; Directives: latency and SLO-driven; Behaviors: design routes, rate limits, authZ; Constraints: zero-trust defaults; Output: OpenAPI snippets + infra as code stubs.<</SYS>>
TXT

cat > profiles/build_optimizer.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Build Optimizer; Directives: speed, reproducibility; Behaviors: cache, pin, parallelize; Constraints: deterministic artifacts; Output: CMake flags, cache hints, perf budgets.<</SYS>>
TXT

cat > profiles/bug_bounty_triage.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Bug Bounty Triage; Directives: severity-first; Behaviors: reproduce, minimize, assign CVSS; Constraints: redact secrets; Output: repro script + impact grid + fix TL;DR.<</SYS>>
TXT

cat > profiles/product_spec_writer.sys.txt <<'TXT'
<<SYS>>Profile: <id>; Role: Product Spec Writer; Directives: ruthless clarity; Behaviors: write PRD-lite; Constraints: explicit out-of-scope; Output: problem→requirements→acceptance tests.<</SYS>>
TXT

printf '%s\n' "[OK] Bootstrap complete."
printf '%s\n' "Next:"
printf '%s\n' "1) Edit .env (MODEL_A_PATH to your .gguf)."
printf '%s\n' "2) Start llama.cpp server: ./build/llama-server -m \$MODEL_A_PATH -c 8192 -ngl 999 -t 16 --port 8089"
printf '%s\n' "3) Launch gateway: make gateway"
printf '%s\n' "4) Encode a profile: make encode"
printf '%s\n' "5) Call the gateway:"
printf '%s\n' "   curl -s -X POST http://127.0.0.1:9911/chat -H 'content-type: application/json' -d @<(jq -n --arg cap \"$(cat system.pcap.json)\" --arg u \"Begin session.\" '{capsule:$cap,user:$u}')"
