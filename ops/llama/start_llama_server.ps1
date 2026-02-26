param(
  [string]$ModelPath = "C:\\Users\\anani\\.lmstudio\\models\\Qwen\\Qwen2.5-3B-Instruct-GGUF\\qwen2.5-3b-instruct-q4_k_m.gguf",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 11435,
  [int]$Ctx = 4096,
  [int]$Threads = 8
)

$ErrorActionPreference = 'Stop'

# Expect llama-server.exe in ops/llama/bin (you place it there)
$binDir = Join-Path $PSScriptRoot 'bin'
$exe = Join-Path $binDir 'llama-server.exe'

if(!(Test-Path $exe)){
  Write-Host "Missing $exe"
  Write-Host "Download a Windows build of llama.cpp and put llama-server.exe into: $binDir"
  Write-Host "Then re-run this script."
  exit 2
}

if(!(Test-Path $ModelPath)){
  Write-Error "Model file not found: $ModelPath"
  exit 3
}

Write-Host "Starting llama-server..."
Write-Host "  exe:   $exe"
Write-Host "  model: $ModelPath"
Write-Host "  url:   http://$BindHost`:$Port"

# Start in a new window so it keeps running
Start-Process -FilePath $exe -ArgumentList @(
  "--host", $BindHost,
  "--port", "$Port",
  "-m", $ModelPath,
  "-c", "$Ctx",
  "-t", "$Threads"
) -WorkingDirectory $binDir

Write-Host "OK. Probe with probe_llama_server.ps1"
