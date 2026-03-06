param(
  [Parameter(Mandatory = $true)][string]$ModelPath,
  [int]$GpuLayers = -1,
  [int]$Threads = 6,
  [int]$Ctx = 4096,
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 11435
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$llamaExe = Join-Path $PSScriptRoot "bin\llama-server.exe"
if (-not (Test-Path $llamaExe)) {
  throw "llama-server.exe not found: $llamaExe"
}
if (-not (Test-Path $ModelPath)) {
  throw "Model path not found: $ModelPath"
}

$args = @(
  "--host", $BindHost,
  "--port", [string]$Port,
  "--model", $ModelPath
)
if ($Ctx -gt 0) { $args += @("--ctx-size", [string]$Ctx) }
if ($Threads -gt 0) { $args += @("--threads", [string]$Threads) }
if ($GpuLayers -ge 0) { $args += @("--n-gpu-layers", [string]$GpuLayers) }

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$logDir = Join-Path $repoRoot "_sync\autogen_learning"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$outLog = Join-Path $logDir "llama-server.out.log"
$errLog = Join-Path $logDir "llama-server.err.log"

Start-Process -FilePath $llamaExe -ArgumentList $args -WorkingDirectory (Split-Path $llamaExe -Parent) -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden | Out-Null

Write-Host "Starting llama-server..."
Write-Host "  exe:   $llamaExe"
Write-Host "  model: $ModelPath"
Write-Host "  url:   http://$BindHost`:$Port"
Write-Host "OK. Probe with probe_llama_server.ps1"
