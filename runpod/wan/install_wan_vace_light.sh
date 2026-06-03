#!/usr/bin/env bash
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"

cd "$COMFY_DIR"
source venv/bin/activate

python -m pip install --upgrade \
  huggingface_hub \
  safetensors \
  imageio \
  imageio-ffmpeg \
  opencv-python-headless \
  accelerate

mkdir -p custom_nodes
cd custom_nodes

clone_or_pull() {
  local repo="$1"
  local dir="$2"
  if [ ! -d "$dir/.git" ]; then
    git clone --depth 1 "$repo" "$dir"
  else
    git -C "$dir" pull --ff-only || true
  fi
}

clone_or_pull https://github.com/kijai/ComfyUI-WanVideoWrapper.git ComfyUI-WanVideoWrapper
clone_or_pull https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git ComfyUI-VideoHelperSuite
clone_or_pull https://github.com/kijai/ComfyUI-KJNodes.git ComfyUI-KJNodes

for req in \
  ComfyUI-WanVideoWrapper/requirements.txt \
  ComfyUI-VideoHelperSuite/requirements.txt \
  ComfyUI-KJNodes/requirements.txt; do
  if [ -f "$req" ]; then
    python -m pip install -r "$req"
  fi
done

cd "$COMFY_DIR"
mkdir -p models/diffusion_models/WanVideo models/text_encoders models/vae/wanvideo input output temp

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

hf_download Kijai/WanVideo_comfy Wan2_1-T2V-1_3B_bf16.safetensors models/diffusion_models/WanVideo
hf_download Kijai/WanVideo_comfy Wan2_1-VACE_module_1_3B_bf16.safetensors models/diffusion_models/WanVideo
hf_download Kijai/WanVideo_comfy umt5-xxl-enc-bf16.safetensors models/text_encoders
hf_download Kijai/WanVideo_comfy Wan2_1_VAE_bf16.safetensors models/vae/wanvideo

echo "LIGHT_SETUP_DONE"
