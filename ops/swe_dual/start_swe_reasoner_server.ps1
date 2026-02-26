param(
  [string]$ProjectRoot = "C:\Users\anani\Projects\mcp-sync-server",
  [string]$SyncDir = "C:\Users\anani\Projects\mcp-sync-server\_sync",
  [int]$Port = 3001,
  [string]$OpenAIBaseUrl = "local://swe",
  [string]$OpenAIModel = "swe-local",
  [string]$OpenAIApiKey = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$entry = Join-Path $ProjectRoot "dist\index.js"

if ([string]::IsNullOrWhiteSpace($OpenAIApiKey)) {
  $OpenAIApiKey = [string]$env:OPENAI_API_KEY
}

$isLocalBaseUrl = (
  $OpenAIBaseUrl -match "^https?://(127\.0\.0\.1|localhost)(:\d+)?(/|$)" -or
  $OpenAIBaseUrl -match "^(local|internal|lab|inproc)://"
)
if ([string]::IsNullOrWhiteSpace($OpenAIApiKey) -and $isLocalBaseUrl) {
  $OpenAIApiKey = "local-anything"
}

if ([string]::IsNullOrWhiteSpace($OpenAIApiKey) -and -not $isLocalBaseUrl) {
  Write-Host "WARNING: OPENAI_API_KEY is empty. Reasoner LLM loop may fail."
}

$cmd = @"
`$env:PORT='$Port'
`$env:SYNC_DIR='$SyncDir'
`$env:OPENAI_MODEL='$OpenAIModel'
`$env:OPENAI_BASE_URL='$OpenAIBaseUrl'
`$env:OPENAI_API_KEY='$OpenAIApiKey'
`$env:OPENAI_TIMEOUT_MS='180000'
node '$entry'
"@

if ($DryRun) {
  Write-Host "DRY RUN: reasoner server command:"
  Write-Host $cmd
  exit 0
}

Start-Process powershell -WorkingDirectory $PSScriptRoot -ArgumentList @(
  "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $cmd
)

Write-Host "Started SWE REASONER server on http://127.0.0.1:$Port"
Write-Host "Model: $OpenAIModel"
Write-Host "Base : $OpenAIBaseUrl"
