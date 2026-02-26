param(
  [string]$BaseUrl = "http://127.0.0.1:11435/v1",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 11435,
  [int]$Ctx = 4096,
  [int]$Threads = 8,
  [int]$WaitSec = 60
)

$ErrorActionPreference = "Stop"

function Resolve-MistralModelPath {
  $roots = @(
    "C:\Users\anani\.lmstudio\models",
    "$env:USERPROFILE\.lmstudio\models"
  ) | Select-Object -Unique

  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $hit = Get-ChildItem -Path $root -Recurse -Filter *.gguf -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '(?i)mistral.*7b.*instruct.*\.gguf' } |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Test-LlamaReady {
  param([string]$Url)
  try {
    $null = Invoke-RestMethod -Method Get -Uri "$Url/models" -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

$modelPath = Resolve-MistralModelPath
if (-not $modelPath) {
  Write-Host "Mistral-7B-Instruct GGUF not found in .lmstudio\models" -ForegroundColor Yellow
  Write-Host "Expected filename pattern: mistral*7b*instruct*.gguf" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Download model first, then rerun this script." -ForegroundColor Yellow
  Write-Host "Temporary stronger fallback already available on your PC:" -ForegroundColor Cyan
  Write-Host "  .\ops\llama\run_qwen_dialog.ps1 -ModelPath `"C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf`"" -ForegroundColor Cyan
  exit 2
}

Write-Host "Using model:"
Write-Host "  $modelPath"

if (-not (Test-LlamaReady -Url $BaseUrl)) {
  Write-Host "Server is not ready. Starting llama-server..."
  & "$PSScriptRoot\start_llama_server.ps1" `
    -ModelPath $modelPath `
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

Write-Host "Server is ready. Opening Mistral dialog window..."
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", "$PSScriptRoot\dialog_llama_server.ps1",
  "-BaseUrl", $BaseUrl,
  "-Model", "mistral-7b-instruct-v0.3",
  "-System", "You are a pragmatic SWE assistant. Always answer in Russian language."
)

Write-Host "Done."
