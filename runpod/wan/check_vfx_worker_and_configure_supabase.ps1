param(
  [string]$PodId = "ospyvnt7kg7m9x",
  [string]$ProjectRef = "fymncypboeubdikpbmqc",
  [string]$BaseUrl = "",
  [int]$TimeoutSec = 20,
  [switch]$ConfigureSecrets
)

$ErrorActionPreference = "Stop"

if (-not $BaseUrl) {
  if (-not $PodId) {
    throw "Pass -PodId or -BaseUrl."
  }
  $BaseUrl = "https://$PodId-8888.proxy.runpod.net"
}
$BaseUrl = $BaseUrl.TrimEnd("/")

function Invoke-WorkerJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  $url = "$BaseUrl$Path"
  try {
    $response = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec $TimeoutSec
    [pscustomobject]@{
      Path = $Path
      Url = $url
      Ok = $true
      Status = if ($response.status) { [string]$response.status } else { "ok" }
      Response = $response
      Error = $null
    }
  } catch {
    [pscustomobject]@{
      Path = $Path
      Url = $url
      Ok = $false
      Status = "error"
      Response = $null
      Error = $_.Exception.Message
    }
  }
}

$checks = @(
  Invoke-WorkerJson -Path "/health"
  Invoke-WorkerJson -Path "/diagnostics"
  Invoke-WorkerJson -Path "/preflight"
  Invoke-WorkerJson -Path "/qwen/preflight"
)

foreach ($check in $checks) {
  if ($check.Ok) {
    Write-Host "[OK] $($check.Path) -> $($check.Status)"
  } else {
    Write-Host "[FAIL] $($check.Path) -> $($check.Error)" -ForegroundColor Red
  }
}

$failed = $checks | Where-Object { -not $_.Ok }
if ($failed.Count -gt 0) {
  Write-Host ""
  Write-Host "Worker is not ready. Do not configure Supabase secrets yet." -ForegroundColor Yellow
  Write-Host "Expected worker URL: $BaseUrl"
  exit 1
}

Write-Host ""
Write-Host "Worker preflight passed for $BaseUrl" -ForegroundColor Green

if (-not $ConfigureSecrets) {
  Write-Host "Supabase secrets were not changed. Re-run with -ConfigureSecrets to set:"
  Write-Host "  RUNPOD_WAN_WORKER_URL=$BaseUrl"
  Write-Host "  RUNPOD_QWEN_ENDPOINT_URL=$BaseUrl/qwen"
  exit 0
}

$supabase = Get-Command supabase -ErrorAction SilentlyContinue
if (-not $supabase) {
  throw "Supabase CLI not found. Install/login with the global supabase CLI first."
}

& supabase secrets set `
  "RUNPOD_WAN_WORKER_URL=$BaseUrl" `
  "RUNPOD_QWEN_ENDPOINT_URL=$BaseUrl/qwen" `
  --project-ref $ProjectRef

if ($LASTEXITCODE -ne 0) {
  throw "supabase secrets set failed."
}

Write-Host "Supabase worker secrets configured for project $ProjectRef." -ForegroundColor Green
