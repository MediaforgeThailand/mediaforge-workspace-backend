#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"
WORKER_DIR="${WORKER_DIR:-/workspace}"
COMFY_LOG="${COMFY_LOG:-/workspace/comfy_wan_vace.log}"
WORKER_LOG="${WORKER_LOG:-/workspace/wan_vace_worker.log}"
WAN_WORKER_PORT="${WAN_WORKER_PORT:-8888}"
export WAN_WORKER_PORT

if [ ! -d "$COMFY_DIR/venv" ]; then
  echo "ComfyUI venv not found. Run /workspace/install_comfy_wan_vace.sh first." >&2
  exit 1
fi

mkdir -p "$WORKER_DIR"

if [ ! -f "$WORKER_DIR/wan_vace_worker.py" ]; then
  echo "wan_vace_worker.py not found in $WORKER_DIR. Copy the worker files to /workspace first." >&2
  exit 1
fi

if [ ! -f "$WORKER_DIR/qwen_worker.py" ]; then
  echo "qwen_worker.py not found in $WORKER_DIR. Copy qwen_worker.py to /workspace so /qwen routes can generate the reference image." >&2
  exit 1
fi

COMFY_EXTRA_ARGS="${COMFY_EXTRA_ARGS:-}"
HAS_CUDA=0
TOTAL_VRAM_MB=0
if command -v nvidia-smi >/dev/null 2>&1; then
  HAS_CUDA=1
  TOTAL_VRAM_MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ' || echo 0)"
elif "$COMFY_DIR/venv/bin/python" -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" >/dev/null 2>&1; then
  HAS_CUDA=1
fi

if [ "$HAS_CUDA" != "1" ] && [ -z "$COMFY_EXTRA_ARGS" ]; then
  COMFY_EXTRA_ARGS="--cpu"
  echo "No CUDA runtime detected; starting ComfyUI in CPU compatibility mode."
elif [ "$HAS_CUDA" = "1" ] && [ -z "$COMFY_EXTRA_ARGS" ] && [ "${TOTAL_VRAM_MB:-0}" -gt 0 ] && [ "$TOTAL_VRAM_MB" -le 24576 ]; then
  COMFY_EXTRA_ARGS="--lowvram"
  echo "Detected ${TOTAL_VRAM_MB}MB VRAM; starting ComfyUI with --lowvram for Wan/Qwen stability."
fi

if ! pgrep -af "python main.py --listen 0.0.0.0 --port 8188" >/dev/null 2>&1; then
  (
    cd "$COMFY_DIR"
    source venv/bin/activate
    nohup python main.py --listen 0.0.0.0 --port 8188 $COMFY_EXTRA_ARGS > "$COMFY_LOG" 2>&1 &
  )
fi

echo "Waiting for ComfyUI..."
for i in $(seq 1 240); do
  if curl -fsS http://127.0.0.1:8188/object_info >/dev/null 2>&1; then
    break
  fi
  sleep 2
  if [ "$i" -eq 240 ]; then
    echo "ComfyUI did not become ready. Tail $COMFY_LOG for details." >&2
    exit 1
  fi
done

if pgrep -af "wan_vace_worker.py" >/dev/null 2>&1; then
  pkill -f "wan_vace_worker.py" || true
  sleep 1
fi

(
  cd "$WORKER_DIR"
  source "$COMFY_DIR/venv/bin/activate"
  nohup python wan_vace_worker.py > "$WORKER_LOG" 2>&1 &
)

echo "Waiting for Wan VACE worker..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WAN_WORKER_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "Wan VACE worker did not become ready. Tail $WORKER_LOG for details." >&2
    exit 1
  fi
done

echo "Running Wan VACE preflight..."
if ! curl -fsS "http://127.0.0.1:${WAN_WORKER_PORT}/preflight"; then
  echo "" >&2
  echo "Wan VACE preflight failed. Tail $WORKER_LOG and $COMFY_LOG for details." >&2
  exit 1
fi

echo "Running Qwen preflight..."
if ! curl -fsS "http://127.0.0.1:${WAN_WORKER_PORT}/qwen/preflight"; then
  echo "" >&2
  echo "Qwen preflight failed. Tail $WORKER_LOG and $COMFY_LOG for details." >&2
  exit 1
fi

echo "Wan VACE services started."
echo "ComfyUI: http://127.0.0.1:8188"
echo "Worker:  http://127.0.0.1:${WAN_WORKER_PORT}"
echo "Qwen:    http://127.0.0.1:${WAN_WORKER_PORT}/qwen"
