param(
  [string]$ModelPath = "C:\\Users\\anani\\.lmstudio\\models\\Qwen\\Qwen2.5-3B-Instruct-GGUF\\qwen2.5-3b-instruct-q4_k_m.gguf",
  [string]$Model = "qwen2.5-3b-instruct",
  [string]$BaseUrl = "http://127.0.0.1:11435/v1",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 11435,
  [int]$Ctx = 4096,
  [int]$Threads = 8,
  [int]$WaitSec = 45
)

$ErrorActionPreference = "Stop"

function Test-LlamaReady {
  param([string]$Url)
  try {
    $null = Invoke-RestMethod -Method Get -Uri "$Url/models" -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

Write-Host "Checking llama.cpp server at $BaseUrl ..."

if (-not (Test-LlamaReady -Url $BaseUrl)) {
  Write-Host "Server is not ready. Starting llama-server..."
  & "$PSScriptRoot\start_llama_server.ps1" `
    -ModelPath $ModelPath `
    -BindHost $BindHost `
    -Port $Port `
    -Ctx $Ctx `
    -Threads $Threads | Out-Host

  $ready = $false
  for ($i = 0; $i -lt $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    if (Test-LlamaReady -Url $BaseUrl) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    throw "llama-server did not become ready within $WaitSec seconds."
  }
}

Write-Host "Server is ready. Opening dialog window..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", "$PSScriptRoot\dialog_llama_server.ps1",
  "-BaseUrl", $BaseUrl,
  "-Model", $Model
)

Write-Host "Done."
