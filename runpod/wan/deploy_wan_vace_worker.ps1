param(
  [Parameter(Mandatory = $true)]
  [string]$SshUserHost,

  [string]$IdentityFile = "$HOME\.ssh\id_runpod_mediaforge",

  [int]$Port = 0,

  [int]$WorkerPort = 8888,

  [switch]$Install,

  [switch]$LightInstall,

  [switch]$StartServices
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$IdentityPath = Resolve-Path $IdentityFile

function Get-SshArgs {
  param([string]$RemoteCommand)

  $args = @(
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-i", $IdentityPath.Path
  )
  if ($Port -gt 0) {
    $args += @("-p", [string]$Port)
  }
  $args += @($SshUserHost, $RemoteCommand)
  return $args
}

function Invoke-Remote {
  param([string]$RemoteCommand)

  $args = Get-SshArgs $RemoteCommand
  & ssh @args
  if ($LASTEXITCODE -ne 0) {
    throw "Remote command failed with exit code $LASTEXITCODE`: $RemoteCommand"
  }
}

function Send-RemoteFile {
  param(
    [string]$LocalPath,
    [string]$RemotePath
  )

  $resolved = Resolve-Path $LocalPath
  $normalizedRemotePath = $RemotePath.Replace("\", "/")
  $remoteDir = $normalizedRemotePath.Substring(0, $normalizedRemotePath.LastIndexOf("/"))
  Invoke-Remote "mkdir -p '$remoteDir'"

  $args = @(
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-i", $IdentityPath.Path
  )
  if ($Port -gt 0) {
    $args += @("-P", [string]$Port)
  }
  $args += @($resolved.Path, "${SshUserHost}:$normalizedRemotePath")

  & scp @args
  if ($LASTEXITCODE -ne 0) {
    throw "Upload failed: $normalizedRemotePath"
  }
}

$files = @(
  @{ Local = (Join-Path $ScriptDir "wan_vace_worker.py"); Remote = "/workspace/wan_vace_worker.py" },
  @{ Local = (Join-Path $RepoRoot "runpod\qwen\qwen_worker.py"); Remote = "/workspace/qwen_worker.py" },
  @{ Local = (Join-Path $ScriptDir "install_comfy_wan_vace.sh"); Remote = "/workspace/install_comfy_wan_vace.sh" },
  @{ Local = (Join-Path $ScriptDir "install_wan_vace_light.sh"); Remote = "/workspace/install_wan_vace_light.sh" },
  @{ Local = (Join-Path $ScriptDir "start_wan_vace_services.sh"); Remote = "/workspace/start_wan_vace_services.sh" }
)

Write-Host "Uploading MediaForge Wan VACE worker files to $SshUserHost..."
foreach ($file in $files) {
  Write-Host " -> $($file.Remote)"
  Send-RemoteFile -LocalPath $file.Local -RemotePath $file.Remote
}

Invoke-Remote "chmod +x /workspace/install_comfy_wan_vace.sh /workspace/install_wan_vace_light.sh /workspace/start_wan_vace_services.sh"

if ($Install -and $LightInstall) {
  throw "Use only one of -Install or -LightInstall."
}

if ($Install) {
  Write-Host "Running full ComfyUI + Qwen + Wan VACE install on pod..."
  Invoke-Remote "/workspace/install_comfy_wan_vace.sh"
}

if ($LightInstall) {
  Write-Host "Running light Wan VACE dependency/model install on existing ComfyUI..."
  Invoke-Remote "/workspace/install_wan_vace_light.sh"
}

if ($StartServices) {
  Write-Host "Starting ComfyUI and MediaForge Wan VACE worker..."
  Invoke-Remote "WAN_WORKER_PORT=$WorkerPort /workspace/start_wan_vace_services.sh"
}

Write-Host "Checking worker endpoints if service is already running..."
Invoke-Remote "curl -fsS http://127.0.0.1:$WorkerPort/health || true"
Invoke-Remote "curl -fsS http://127.0.0.1:$WorkerPort/diagnostics || true"

Write-Host "Done. If diagnostics is not ok, inspect /workspace/wan_vace_worker.log and /workspace/comfy_wan_vace.log on the pod."
