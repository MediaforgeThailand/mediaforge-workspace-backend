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
python -m pip install --force-reinstall --no-cache-dir \
  torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 \
  --index-url "${PYTORCH_CUDA_INDEX_URL:-https://download.pytorch.org/whl/cu124}"

mkdir -p custom_nodes
cd custom_nodes

clone_or_pull() {
  local repo="$1"
  local dir="$2"
  if [ ! -d "$dir/.git" ]; then
    git clone "$repo" "$dir"
  else
    git -C "$dir" pull --ff-only || true
  fi
}

clone_or_pull https://github.com/ltdrdata/ComfyUI-Manager.git ComfyUI-Manager
clone_or_pull https://github.com/city96/ComfyUI-GGUF.git ComfyUI-GGUF
clone_or_pull https://github.com/kijai/ComfyUI-WanVideoWrapper.git ComfyUI-WanVideoWrapper
clone_or_pull https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git ComfyUI-VideoHelperSuite
clone_or_pull https://github.com/kijai/ComfyUI-KJNodes.git ComfyUI-KJNodes

for req in \
  ComfyUI-GGUF/requirements.txt \
  ComfyUI-WanVideoWrapper/requirements.txt \
  ComfyUI-VideoHelperSuite/requirements.txt \
  ComfyUI-KJNodes/requirements.txt; do
  if [ -f "$req" ]; then
    python -m pip install -r "$req"
  fi
done

cd "$COMFY_DIR"
python -m pip install --upgrade huggingface_hub accelerate safetensors imageio imageio-ffmpeg opencv-python-headless

mkdir -p models/diffusion_models/WanVideo models/text_encoders models/vae/wanvideo models/vae models/loras models/unet/gguf input output temp

hf_download() {
  local repo="$1"
  local file="$2"
  local out_dir="$3"
  if [ -s "$out_dir/$file" ]; then
    echo "exists: $out_dir/$file"
    return 0
  fi
  echo "downloading: $repo/$file"
  mkdir -p "$out_dir"
  curl -L --retry 8 --retry-delay 5 --continue-at - \
    "https://huggingface.co/$repo/resolve/main/$file?download=true" \
    -o "$out_dir/$file"
}

hf_download_url() {
  local url="$1"
  local out_path="$2"
  if [ -s "$out_path" ]; then
    echo "exists: $out_path"
    return 0
  fi
  echo "downloading: $out_path"
  mkdir -p "$(dirname "$out_path")"
  curl -L --retry 8 --retry-delay 5 --continue-at - \
    "$url" \
    -o "$out_path"
}

hf_download Kijai/WanVideo_comfy Wan2_1-T2V-1_3B_bf16.safetensors models/diffusion_models/WanVideo
hf_download Kijai/WanVideo_comfy Wan2_1-VACE_module_1_3B_bf16.safetensors models/diffusion_models/WanVideo
hf_download Kijai/WanVideo_comfy umt5-xxl-enc-bf16.safetensors models/text_encoders
hf_download Kijai/WanVideo_comfy Wan2_1_VAE_bf16.safetensors models/vae/wanvideo
hf_download unsloth/Qwen-Image-GGUF qwen-image-Q4_K_M.gguf models/unet/gguf
hf_download unsloth/Qwen-Image-Edit-2511-GGUF qwen-image-edit-2511-Q5_0.gguf models/unet/gguf
hf_download_url https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors?download=true models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors
hf_download_url https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors?download=true models/vae/qwen_image_vae.safetensors
hf_download lightx2v/Qwen-Image-Lightning Qwen-Image-Lightning-8steps-V1.0.safetensors models/loras
hf_download lightx2v/Qwen-Image-Edit-2511-Lightning Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors models/loras

cat > /workspace/start-comfy-wan-vace.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /workspace/ComfyUI
source venv/bin/activate
python main.py --listen 0.0.0.0 --port 8188
EOF
chmod +x /workspace/start-comfy-wan-vace.sh

echo "ComfyUI Qwen + Wan VACE setup complete."
echo "Copy wan_vace_worker.py and qwen_worker.py to /workspace, then run /workspace/start_wan_vace_services.sh"
