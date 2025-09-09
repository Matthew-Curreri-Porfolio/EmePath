#!/usr/bin/env bash
set -euo pipefail
SESSION="${CODEX_SESSION:-codex}"
ROOT="/oss-codex"

command -v tmux >/dev/null || { echo "tmux not found. sudo apt install tmux"; exit 1; }
mkdir -p "$ROOT/gateway/logs"

case "${1:-start}" in
  kill) tmux kill-session -t "$SESSION" 2>/dev/null || true; exit 0 ;;
  attach) tmux attach -t "$SESSION"; exit 0 ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi

tmux new-session -d -s "$SESSION" -n run -c "$ROOT" 'npm --prefix gateway run start'
tmux split-window -h -t "$SESSION:run" -c "$ROOT" 'npm --prefix extension run watch'
tmux select-pane -t "$SESSION:run".0

tmux new-window -t "$SESSION":2 -n devhost -c "$ROOT" 'npm run extension:devhost; read -r -p "Dev Host launched. Press Enter to close pane..." _'
tmux new-window -t "$SESSION":3 -n logs -c "$ROOT" 'npm run logs:gateway'

tmux select-window -t "$SESSION:run"
tmux attach -t "$SESSION"