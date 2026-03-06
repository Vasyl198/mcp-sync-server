param(
  [string]$Task = "",
  [string]$TaskFile = "",
  [string]$JsonOut = "",
  [string]$OpenAIBaseUrl = "",
  [string]$OpenAIApiKey = "",
  [string]$OpenAIModel = "",
  [string]$ModelPath = "",
  [int]$LlamaGpuLayers = -1,
  [int]$LlamaThreads = -1,
  [int]$LlamaCtx = -1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-TaskText {
  param([string]$InlineTask, [string]$Path)
  if ($InlineTask -and $InlineTask.Trim()) { return $InlineTask.Trim() }
  if ($Path -and (Test-Path $Path)) { return (Get-Content -Raw -Encoding UTF8 $Path).Trim() }
  throw "Task text is empty. Provide -Task or -TaskFile."
}

function Resolve-BaseUrl([string]$ArgBase) {
  if ($ArgBase -and $ArgBase.Trim()) { return $ArgBase.TrimEnd('/') }
  if ($env:OPENAI_BASE_URL -and $env:OPENAI_BASE_URL.Trim()) { return $env:OPENAI_BASE_URL.TrimEnd('/') }
  return "http://127.0.0.1:11435/v1"
}

function Resolve-ApiKey([string]$ArgKey) {
  if ($ArgKey -and $ArgKey.Trim()) { return $ArgKey }
  if ($env:OPENAI_API_KEY -and $env:OPENAI_API_KEY.Trim()) { return $env:OPENAI_API_KEY }
  return "local-anything"
}

function Resolve-RepoRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\.."))
}

function Resolve-ModelPath([string]$ArgModelPath) {
  if ($ArgModelPath -and (Test-Path $ArgModelPath)) { return $ArgModelPath }
  if ($env:OPENAI_MODEL_PATH -and (Test-Path $env:OPENAI_MODEL_PATH)) { return $env:OPENAI_MODEL_PATH }

  $preferred = @(
    "D:\hf_models\gguf_trained\qwen2.5-coder-7b-autogen-trained-v2-q4_k_m.gguf",
    "D:\hf_models\gguf_trained\promoted\20260302_075742\qwen2.5-coder-7b-autogen-trained-v2-q4_k_m.gguf"
  )
  foreach ($p in $preferred) {
    if (Test-Path $p) { return $p }
  }

  $first = Get-ChildItem "D:\hf_models" -Recurse -Filter *.gguf -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($first) { return $first.FullName }
  return ""
}

function Get-EndpointPort([string]$BaseUrl) {
  $u = [Uri]$BaseUrl
  if ($u.IsDefaultPort) {
    if ($u.Scheme -eq "https") { return 443 }
    return 80
  }
  return $u.Port
}

function Test-EndpointReady([string]$BaseUrl) {
  try {
    $null = Invoke-RestMethod -Method GET -Uri "$BaseUrl/models" -TimeoutSec 5
    return $true
  } catch {
    return $false
  }
}

function Wait-EndpointReady([string]$BaseUrl, [int]$Attempts = 30, [int]$SleepMs = 1000) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    if (Test-EndpointReady -BaseUrl $BaseUrl) { return $true }
    Start-Sleep -Milliseconds $SleepMs
  }
  return $false
}

function Start-LocalLlamaServer {
  param(
    [string]$BaseUrl,
    [string]$ResolvedModelPath,
    [int]$GpuLayers,
    [int]$Threads,
    [int]$Ctx
  )

  if (-not $ResolvedModelPath) { throw "No GGUF model found. Set -ModelPath or OPENAI_MODEL_PATH." }

  $repoRoot = Resolve-RepoRoot
  $llamaExe = Join-Path $repoRoot "ops\llama\bin\llama-server.exe"
  if (-not (Test-Path $llamaExe)) {
    throw "llama-server.exe not found: $llamaExe"
  }

  $u = [Uri]$BaseUrl
  $port = Get-EndpointPort -BaseUrl $BaseUrl
  $host = if ($u.Host) { $u.Host } else { "127.0.0.1" }
  $workDir = Split-Path -Parent $llamaExe
  $logDir = Join-Path $repoRoot "_sync\autogen_learning"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $outLog = Join-Path $logDir "llama-server.out.log"
  $errLog = Join-Path $logDir "llama-server.err.log"

  $args = @(
    "--host", $host,
    "--port", [string]$port,
    "--model", $ResolvedModelPath
  )
  if ($Ctx -gt 0) { $args += @("--ctx-size", [string]$Ctx) }
  if ($Threads -gt 0) { $args += @("--threads", [string]$Threads) }
  if ($GpuLayers -ge 0) { $args += @("--n-gpu-layers", [string]$GpuLayers) }

  Start-Process -FilePath $llamaExe -ArgumentList $args -WorkingDirectory $workDir -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden | Out-Null
}

function Resolve-Model([string]$BaseUrl, [string]$ArgModel, [string]$ResolvedModelPath) {
  if ($ArgModel -and $ArgModel.Trim()) { return $ArgModel }
  if ($env:OPENAI_MODEL -and $env:OPENAI_MODEL.Trim()) { return $env:OPENAI_MODEL }
  try {
    $m = Invoke-RestMethod -Method GET -Uri "$BaseUrl/models" -TimeoutSec 20
    if ($m.data -and $m.data.Count -gt 0 -and $m.data[0].id) { return [string]$m.data[0].id }
  } catch {}
  if ($ResolvedModelPath -and (Test-Path $ResolvedModelPath)) { return [System.IO.Path]::GetFileName($ResolvedModelPath) }
  return "qwen2.5-coder-7b-instruct"
}

function Build-FallbackAnswer([string]$q) {
  $t = $q.Trim().ToLowerInvariant()
  if ($t -match '^\d+\s*[\+\-\*\/]\s*\d+$') {
    try {
      $safe = $t -replace '[^0-9\+\-\*\/\(\)\.\s]',''
      return ([scriptblock]::Create($safe).Invoke() | Out-String).Trim()
    } catch {}
  }
  if ($t -match 'days?\s+in\s+a?\s*week|week.*days?') { return "7" }
  if ($t -match 'minutes?\s+in\s+an?\s*hour|hour.*minutes?') { return "60" }
  if ($t -match 'who\s+are\s+you|what\s+model') { return "I am LabBrain. LLM backend: local OpenAI-compatible endpoint." }
  return "LLM endpoint did not return a response. Check OPENAI_BASE_URL/OPENAI_MODEL and /v1/chat/completions availability."
}

$taskText = Read-TaskText -InlineTask $Task -Path $TaskFile
$baseUrl = Resolve-BaseUrl -ArgBase $OpenAIBaseUrl
$apiKey = Resolve-ApiKey -ArgKey $OpenAIApiKey
$resolvedModelPath = Resolve-ModelPath -ArgModelPath $ModelPath

# Option 1: local endpoint mode. Auto-start llama-server if endpoint is down.
if (-not (Test-EndpointReady -BaseUrl $baseUrl)) {
  try {
    Start-LocalLlamaServer -BaseUrl $baseUrl -ResolvedModelPath $resolvedModelPath -GpuLayers $LlamaGpuLayers -Threads $LlamaThreads -Ctx $LlamaCtx
    $null = Wait-EndpointReady -BaseUrl $baseUrl -Attempts 45 -SleepMs 1000
  } catch {
    # Keep going; fallback response still works.
  }
}

$model = Resolve-Model -BaseUrl $baseUrl -ArgModel $OpenAIModel -ResolvedModelPath $resolvedModelPath

$answer = ""
$errorText = $null

try {
  $headers = @{ "Authorization" = "Bearer $apiKey"; "Content-Type" = "application/json" }
  $payload = @{
    model = $model
    temperature = 0.2
    messages = @(
      @{ role = "system"; content = "You are LabBrain. Reply concisely in the user's language." },
      @{ role = "user"; content = $taskText }
    )
  } | ConvertTo-Json -Depth 6

  $resp = Invoke-RestMethod -Method POST -Uri "$baseUrl/chat/completions" -Headers $headers -Body $payload -TimeoutSec 90
  $content = $resp.choices[0].message.content
  if ($content -and $content.Trim()) { $answer = $content.Trim() }
}
catch {
  $errorText = $_.Exception.Message
}

if (-not $answer) { $answer = Build-FallbackAnswer -q $taskText }

$out = @{
  ts_utc = (Get-Date).ToUniversalTime().ToString("o")
  task = $taskText
  answer = $answer
  model = $model
  model_path = $resolvedModelPath
  base_url = $baseUrl
  policy_version = "labbrain.runtime.ps1.v1"
  error = $errorText
}

$json = $out | ConvertTo-Json -Depth 6

if ($JsonOut -and $JsonOut.Trim()) {
  $dir = Split-Path -Parent $JsonOut
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($JsonOut, $json, [System.Text.UTF8Encoding]::new($false))
}

Write-Output $json
