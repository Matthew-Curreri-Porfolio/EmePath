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
