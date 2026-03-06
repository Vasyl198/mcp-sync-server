param(
  [string]$Task = "",
  [string]$TaskFile = "",
  [string]$JsonOut = "",
  [string]$OpenAIBaseUrl = "http://127.0.0.1:11435/v1",
  [string]$OpenAIModel = "",
  [string]$OpenAIApiKey = "local-anything",
  [string]$ModelPath = "",
  [int]$LlamaGpuLayers = -1,
  [int]$LlamaThreads = 6,
  [int]$LlamaCtx = 4096,
  [int]$WaitSec = 45,
  [switch]$Plain
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "utf8_io.ps1")
Set-Utf8Console

if ([string]::IsNullOrWhiteSpace($Task) -and [string]::IsNullOrWhiteSpace($TaskFile)) {
  throw "Provide either -Task or -TaskFile."
}
if (-not [string]::IsNullOrWhiteSpace($TaskFile) -and -not (Test-Path $TaskFile)) {
  throw "Task file not found: $TaskFile"
}

function Test-ModelEndpointReady {
  param([string]$BaseUrl)
  try {
    $null = Invoke-RestMethod -Method Get -Uri "$BaseUrl/models" -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

function Get-EndpointModelId {
  param([string]$BaseUrl)
  try {
    $resp = Invoke-RestMethod -Method Get -Uri "$BaseUrl/models" -TimeoutSec 5
    if ($null -ne $resp) {
      if ($resp.data -and $resp.data.Count -gt 0 -and $resp.data[0].id) {
        return [string]$resp.data[0].id
      }
      if ($resp.models -and $resp.models.Count -gt 0 -and $resp.models[0].id) {
        return [string]$resp.models[0].id
      }
    }
  } catch {
  }
  return ""
}

function Resolve-ModelPath {
  param([string]$PreferredPath)
  if (-not [string]::IsNullOrWhiteSpace($PreferredPath) -and (Test-Path $PreferredPath)) {
    return $PreferredPath
  }

  # Priority 1: pick newest trained GGUF from dedicated folder.
  $trainedRoot = "D:\hf_models\gguf_trained"
  if (Test-Path $trainedRoot) {
    $trained = Get-ChildItem -Path $trainedRoot -Recurse -File -Filter "*.gguf" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "(?i)qwen2\.5.*coder.*7b.*(autogen|merged|trained|q3_k_m|q4_0|q4_k_m).*\.gguf" } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($trained) { return $trained.FullName }
  }

  $candidates = @(
    "C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\Qwen2.5-Coder-7B-Instruct-Q3_K_M.gguf",
    "C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\qwen2.5-coder-7b-instruct-q3_k_m.gguf",
    "C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\Qwen2.5-Coder-7B-Instruct-Q4_0.gguf",
    "C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\qwen2.5-coder-7b-instruct-q4_0.gguf",
    "C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
    "C:\Users\anani\.lmstudio\models\lmstudio-community\Qwen2.5-Coder-7B-Instruct-GGUF\qwen2.5-coder-7b-instruct-q4_k_m.gguf"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }

  $root = "C:\Users\anani\.lmstudio\models"
  if (Test-Path $root) {
    $found = Get-ChildItem -Path $root -Recurse -File -Filter "*.gguf" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "(?i)qwen2\.5-coder-7b-instruct-(q3_k_m|q4_0|q4_k_m)\.gguf" } |
      Sort-Object Name |
      Select-Object -First 1
    if ($found) { return $found.FullName }
  }

  return ""
}

function Get-SafeGpuLayers {
  param([int]$ManualValue)
  if ($ManualValue -ge 0) { return $ManualValue }
  $nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $nvsmi) { return 0 }
  try {
    $line = & nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    $mem = 0
    if (-not [int]::TryParse(($line -as [string]).Trim(), [ref]$mem)) { return 0 }
    $layers = 0
    if ($mem -ge 12000) { $layers = 999 }
    elseif ($mem -ge 8000) { $layers = 60 }
    elseif ($mem -ge 6000) { $layers = 40 }
    elseif ($mem -ge 4000) { $layers = 16 }
    else { $layers = 0 }
    $lmStudioRunning = @(
      Get-Process | Where-Object { $_.ProcessName -eq "LM Studio" } | Select-Object -First 1
    ).Count -gt 0
    if ($layers -gt 0 -and $lmStudioRunning) { $layers = [Math]::Max(8, $layers - 6) }
    return $layers
  } catch {
    return 0
  }
}

$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  throw "Venv is missing. Run bootstrap first: .\ops\autogen_engine\bootstrap_autogen_local.ps1"
}

$ResolvedModelPath = Resolve-ModelPath -PreferredPath $ModelPath
if ([string]::IsNullOrWhiteSpace($ResolvedModelPath)) {
  throw "No suitable 7B GGUF found. Download one of: Q3_K_M, Q4_0, Q4_K_M for Qwen2.5-Coder-7B-Instruct."
}
if ([string]::IsNullOrWhiteSpace($OpenAIModel)) {
  $detected = Get-EndpointModelId -BaseUrl $OpenAIBaseUrl
  if (-not [string]::IsNullOrWhiteSpace($detected)) {
    $OpenAIModel = $detected
  } else {
    $OpenAIModel = Split-Path -Leaf $ResolvedModelPath
  }
}

$llamaStarter = Join-Path (Join-Path $PSScriptRoot "..\llama") "start_llama_server.ps1"
if (-not (Test-ModelEndpointReady -BaseUrl $OpenAIBaseUrl)) {
  if (-not (Test-Path $llamaStarter)) {
    throw "LLM endpoint is down and starter script is missing: $llamaStarter"
  }

  Write-Host "LLM endpoint is not ready. Starting local model server..."
  $resolvedGpuLayers = Get-SafeGpuLayers -ManualValue $LlamaGpuLayers
  powershell -NoProfile -ExecutionPolicy Bypass -File $llamaStarter `
    -ModelPath $ResolvedModelPath `
    -GpuLayers $resolvedGpuLayers `
    -Threads $LlamaThreads `
    -Ctx $LlamaCtx | Out-Host

  $ready = $false
  for ($i = 0; $i -lt $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    if (Test-ModelEndpointReady -BaseUrl $OpenAIBaseUrl) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    throw "LLM endpoint did not become ready: $OpenAIBaseUrl"
  }
  if ([string]::IsNullOrWhiteSpace($OpenAIModel)) {
    $detectedAfterStart = Get-EndpointModelId -BaseUrl $OpenAIBaseUrl
    if (-not [string]::IsNullOrWhiteSpace($detectedAfterStart)) {
      $OpenAIModel = $detectedAfterStart
    }
  }
}

$env:OPENAI_BASE_URL = $OpenAIBaseUrl
$env:OPENAI_MODEL = $OpenAIModel
$env:OPENAI_API_KEY = $OpenAIApiKey
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
if (-not $env:LAB_MCP_URL) { $env:LAB_MCP_URL = "http://127.0.0.1:3000/mcp" }
if (-not $env:LAB_MCP_TOOL_ALLOWLIST) {
  # Wildcard mode: allow all tools discovered by whoami during boot sequence.
  $env:LAB_MCP_TOOL_ALLOWLIST = "*"
}

$argsList = @((Join-Path $PSScriptRoot "lab_brain.py"))
if (-not [string]::IsNullOrWhiteSpace($TaskFile)) {
  $argsList += @("--task-file", $TaskFile)
} else {
  $argsList += @("--task", $Task)
}
if (-not [string]::IsNullOrWhiteSpace($JsonOut)) {
  $argsList += @("--json-out", $JsonOut)
}
if ($Plain) {
  $argsList += "--plain"
}

& $venvPy @argsList
