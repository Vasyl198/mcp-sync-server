param(
  [string]$ModelPath = "C:\\Users\\anani\\.lmstudio\\models\\Qwen\\Qwen2.5-3B-Instruct-GGUF\\qwen2.5-3b-instruct-q4_k_m.gguf",
  [string]$LlamaBaseUrl = "http://127.0.0.1:11435/v1",
  [string]$McpUrl = "http://127.0.0.1:3000/mcp",
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

function Test-McpHealth {
  try {
    $resp = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:3000/health" -TimeoutSec 3
    return ($resp -eq "ok")
  } catch {
    return $false
  }
}

Write-Host "Checking Qwen (llama.cpp) ..."
if (-not (Test-LlamaReady -Url $LlamaBaseUrl)) {
  Write-Host "Qwen server is not ready. Starting llama-server..."
  & "$PSScriptRoot\start_llama_server.ps1" `
    -ModelPath $ModelPath `
    -BindHost $BindHost `
    -Port $Port `
    -Ctx $Ctx `
    -Threads $Threads | Out-Host

  $ready = $false
  for ($i = 0; $i -lt $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    if (Test-LlamaReady -Url $LlamaBaseUrl) { $ready = $true; break }
  }
  if (-not $ready) { throw "llama-server did not become ready within $WaitSec seconds." }
}

if (-not (Test-McpHealth)) {
  throw "MCP server is not reachable at http://127.0.0.1:3000/health. Start mcp-sync-server first."
}

Write-Host "Opening lab-agent dialog window..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", "$PSScriptRoot\dialog_lab_agent.ps1",
  "-McpUrl", $McpUrl,
  "-Model", "qwen2.5-3b-instruct",
  "-AllowedToolsCsv", "sync_status,search_web,fs_projects",
  "-ShowTrace"
)

Write-Host "Done."
