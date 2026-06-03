#!/usr/bin/env bash
set -euo pipefail

REF="${MEDIAFORGE_BACKEND_REF:-main}"
RAW_BASE="${MEDIAFORGE_BACKEND_RAW_BASE:-https://raw.githubusercontent.com/MediaforgeThailand/mediaforge-workspace-backend/${REF}}"
BUNDLE_URL="${RAW_BASE}/runpod/wan/dist/mediaforge_wan_vace_web_terminal_bundle.sh"
BUNDLE_PATH="${MEDIAFORGE_BUNDLE_PATH:-/workspace/mediaforge_wan_vace_web_terminal_bundle.sh}"

mkdir -p "$(dirname "$BUNDLE_PATH")"

echo "Downloading MediaForge Wan VACE bundle from:"
echo "  $BUNDLE_URL"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 8 --retry-delay 5 "$BUNDLE_URL" -o "$BUNDLE_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$BUNDLE_PATH" "$BUNDLE_URL"
else
  echo "curl or wget is required to download the MediaForge bundle." >&2
  exit 1
fi

chmod +x "$BUNDLE_PATH"
exec bash "$BUNDLE_PATH"
