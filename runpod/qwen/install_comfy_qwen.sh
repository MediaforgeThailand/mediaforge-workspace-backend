#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

mkdir -p /workspace
cd /workspace

if [ ! -d "$COMFY_DIR/.git" ]; then
  git clone https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
fi

cd "$COMFY_DIR"
git pull --ff-only || true

if [ ! -d venv ]; then
  "$PYTHON_BIN" -m venv venv
fi

source venv/bin/activate
python -m pip install --upgrade pip wheel setuptools
python -m pip install -r requirements.txt
# ComfyUI's latest requirements can pull CUDA 13 PyTorch wheels, while
# many Runpod CUDA 12.x pods still expose a CUDA 12 driver. Keep the MVP
# runtime on a CUDA 12.4 wheel set that is known to boot on the target pod.
python -m pip install --force-reinstall --no-cache-dir \
  torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 \
  --index-url "${PYTORCH_CUDA_INDEX_URL:-https://download.pytorch.org/whl/cu124}"

mkdir -p custom_nodes
cd custom_nodes

if [ ! -d ComfyUI-Manager ]; then
  git clone https://github.com/ltdrdata/ComfyUI-Manager.git
fi

if [ ! -d ComfyUI-GGUF ]; then
  git clone https://github.com/city96/ComfyUI-GGUF.git
fi

if [ -f ComfyUI-GGUF/requirements.txt ]; then
  python -m pip install -r ComfyUI-GGUF/requirements.txt
fi

cd "$COMFY_DIR"
mkdir -p models/diffusion_models models/text_encoders models/vae models/loras models/unet/gguf

download_if_missing() {
  local url="$1"
  local path="$2"
  if [ -s "$path" ]; then
    echo "exists: $path"
    return 0
  fi
  echo "downloading: $path"
  curl -L --fail --retry 5 --retry-delay 5 "$url" -o "$path"
}

download_if_missing \
  "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors" \
  "models/diffusion_models/qwen_image_fp8_e4m3fn.safetensors"

download_if_missing \
  "https://huggingface.co/unsloth/Qwen-Image-GGUF/resolve/main/qwen-image-Q4_K_M.gguf" \
  "models/unet/gguf/qwen-image-Q4_K_M.gguf"

download_if_missing \
  "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors" \
  "models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"

download_if_missing \
  "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors" \
  "models/vae/qwen_image_vae.safetensors"

download_if_missing \
  "https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Lightning-8steps-V1.0.safetensors" \
  "models/loras/Qwen-Image-Lightning-8steps-V1.0.safetensors"

download_if_missing \
  "https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF/resolve/main/qwen-image-edit-2511-Q4_K_M.gguf" \
  "models/unet/gguf/qwen-image-edit-2511-Q4_K_M.gguf"

download_if_missing \
  "https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors" \
  "models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"

cat > /workspace/start-comfy-qwen.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /workspace/ComfyUI
source venv/bin/activate
python main.py --listen 0.0.0.0 --port 8188
EOF
chmod +x /workspace/start-comfy-qwen.sh

echo "ComfyUI and Qwen model setup complete."
echo "Start with: /workspace/start-comfy-qwen.sh"
