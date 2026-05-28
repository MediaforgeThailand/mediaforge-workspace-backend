#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"
WORKER_DIR="${WORKER_DIR:-/workspace}"
COMFY_LOG="${COMFY_LOG:-/workspace/comfy_qwen.log}"
WORKER_LOG="${WORKER_LOG:-/workspace/qwen_worker.log}"

if [ ! -d "$COMFY_DIR/venv" ]; then
  echo "ComfyUI venv not found. Run /workspace/install_comfy_qwen.sh first." >&2
  exit 1
fi

mkdir -p "$WORKER_DIR"

if ! pgrep -af "python main.py --listen 0.0.0.0 --port 8188" >/dev/null 2>&1; then
  (
    cd "$COMFY_DIR"
    source venv/bin/activate
    nohup python main.py --listen 0.0.0.0 --port 8188 > "$COMFY_LOG" 2>&1 &
  )
fi

echo "Waiting for ComfyUI..."
for i in $(seq 1 180); do
  if curl -fsS http://127.0.0.1:8188/object_info >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [ "$i" -eq 180 ]; then
    echo "ComfyUI did not become ready. Tail $COMFY_LOG for details." >&2
    exit 1
  fi
done

if pgrep -af "qwen_worker.py" >/dev/null 2>&1; then
  pkill -f "qwen_worker.py" || true
  sleep 1
fi

(
  cd "$WORKER_DIR"
  source "$COMFY_DIR/venv/bin/activate"
  nohup python qwen_worker.py > "$WORKER_LOG" 2>&1 &
)

echo "Qwen services started."
echo "ComfyUI: http://127.0.0.1:8188"
echo "Worker:  http://127.0.0.1:${QWEN_WORKER_PORT:-8000}"
