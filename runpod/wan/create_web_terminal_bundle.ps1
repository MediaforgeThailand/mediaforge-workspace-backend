param(
  [string]$OutputPath = "$PSScriptRoot\dist\mediaforge_wan_vace_web_terminal_bundle.sh"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$OutputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$OutputDir = Split-Path -Parent $OutputFullPath

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$files = @(
  @{ Local = (Join-Path $ScriptDir "wan_vace_worker.py"); Remote = "/workspace/wan_vace_worker.py"; Mode = "0644" },
  @{ Local = (Join-Path $RepoRoot "runpod\qwen\qwen_worker.py"); Remote = "/workspace/qwen_worker.py"; Mode = "0644" },
  @{ Local = (Join-Path $ScriptDir "install_comfy_wan_vace.sh"); Remote = "/workspace/install_comfy_wan_vace.sh"; Mode = "0755" },
  @{ Local = (Join-Path $ScriptDir "install_wan_vace_light.sh"); Remote = "/workspace/install_wan_vace_light.sh"; Mode = "0755" },
  @{ Local = (Join-Path $ScriptDir "start_wan_vace_services.sh"); Remote = "/workspace/start_wan_vace_services.sh"; Mode = "0755" }
)

$builder = [System.Text.StringBuilder]::new()
[void]$builder.AppendLine("#!/usr/bin/env bash")
[void]$builder.AppendLine("set -euo pipefail")
[void]$builder.AppendLine("")
[void]$builder.AppendLine("# MediaForge Wan VACE Web Terminal bundle.")
[void]$builder.AppendLine("# Paste or upload this script inside the RunPod Web Terminal, then run:")
[void]$builder.AppendLine("#   bash mediaforge_wan_vace_web_terminal_bundle.sh")
[void]$builder.AppendLine("#")
[void]$builder.AppendLine("# Optional modes:")
[void]$builder.AppendLine("#   MEDIAFORGE_INSTALL_MODE=full  bash mediaforge_wan_vace_web_terminal_bundle.sh")
[void]$builder.AppendLine("#   MEDIAFORGE_INSTALL_MODE=light bash mediaforge_wan_vace_web_terminal_bundle.sh")
[void]$builder.AppendLine("#   MEDIAFORGE_INSTALL_MODE=none  bash mediaforge_wan_vace_web_terminal_bundle.sh")
[void]$builder.AppendLine("")
[void]$builder.AppendLine('decode_b64_file() {')
[void]$builder.AppendLine('  local target="$1"')
[void]$builder.AppendLine('  mkdir -p "$(dirname "$target")"')
[void]$builder.AppendLine('  if command -v base64 >/dev/null 2>&1; then')
[void]$builder.AppendLine('    base64 -d > "$target"')
[void]$builder.AppendLine('  else')
[void]$builder.AppendLine('    python3 -c ''import base64, sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))'' > "$target"')
[void]$builder.AppendLine('  fi')
[void]$builder.AppendLine('}')
[void]$builder.AppendLine("")

foreach ($file in $files) {
  $resolved = Resolve-Path $file.Local
  $bytes = [System.IO.File]::ReadAllBytes($resolved.Path)
  $encoded = [Convert]::ToBase64String($bytes)
  [void]$builder.AppendLine("echo 'Writing $($file.Remote)'")
  [void]$builder.AppendLine("decode_b64_file '$($file.Remote)' <<'MEDIAFORGE_B64'")
  for ($i = 0; $i -lt $encoded.Length; $i += 76) {
    $length = [Math]::Min(76, $encoded.Length - $i)
    [void]$builder.AppendLine($encoded.Substring($i, $length))
  }
  [void]$builder.AppendLine("MEDIAFORGE_B64")
  [void]$builder.AppendLine("chmod $($file.Mode) '$($file.Remote)'")
  [void]$builder.AppendLine("")
}

[void]$builder.AppendLine('COMFY_DIR="${COMFY_DIR:-/workspace/ComfyUI}"')
[void]$builder.AppendLine('INSTALL_MODE="${MEDIAFORGE_INSTALL_MODE:-auto}"')
[void]$builder.AppendLine('if [ "$INSTALL_MODE" = "auto" ]; then')
[void]$builder.AppendLine('  if [ -d "$COMFY_DIR/venv" ]; then')
[void]$builder.AppendLine("    INSTALL_MODE=light")
[void]$builder.AppendLine("  else")
[void]$builder.AppendLine("    INSTALL_MODE=full")
[void]$builder.AppendLine("  fi")
[void]$builder.AppendLine("fi")
[void]$builder.AppendLine("")
[void]$builder.AppendLine('case "$INSTALL_MODE" in')
[void]$builder.AppendLine("  full)")
[void]$builder.AppendLine("    echo 'Running full ComfyUI + Qwen + Wan VACE install...'")
[void]$builder.AppendLine("    /workspace/install_comfy_wan_vace.sh")
[void]$builder.AppendLine("    ;;")
[void]$builder.AppendLine("  light)")
[void]$builder.AppendLine("    echo 'Running light Wan VACE dependency/model install...'")
[void]$builder.AppendLine("    /workspace/install_wan_vace_light.sh")
[void]$builder.AppendLine("    ;;")
[void]$builder.AppendLine("  none)")
[void]$builder.AppendLine("    echo 'Skipping install; using existing ComfyUI and models.'")
[void]$builder.AppendLine("    ;;")
[void]$builder.AppendLine("  *)")
[void]$builder.AppendLine('    echo "Unknown MEDIAFORGE_INSTALL_MODE: $INSTALL_MODE" >&2')
[void]$builder.AppendLine("    exit 1")
[void]$builder.AppendLine("    ;;")
[void]$builder.AppendLine("esac")
[void]$builder.AppendLine("")
[void]$builder.AppendLine("/workspace/start_wan_vace_services.sh")
[void]$builder.AppendLine("echo")
[void]$builder.AppendLine("echo 'External checks should pass when RunPod exposes port 8888:'")
[void]$builder.AppendLine("echo '  /health'")
[void]$builder.AppendLine("echo '  /diagnostics'")
[void]$builder.AppendLine("echo '  /preflight'")
[void]$builder.AppendLine("echo '  /qwen/preflight'")

$bundle = $builder.ToString().Replace("`r`n", "`n")
[System.IO.File]::WriteAllText($OutputFullPath, $bundle, [System.Text.Encoding]::UTF8)
Write-Host "Wrote $OutputFullPath"
