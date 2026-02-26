param(
  [string]$ProjectRoot = "C:\Users\anani\Projects\mcp-sync-server",
  [string]$SyncDir = "C:\Users\anani\Projects\mcp-sync-server\_sync",
  [int]$Port = 3000,
  [string]$OpenAIBaseUrl = "",
  [string]$OpenAIModel = "swe",
  [string]$OpenAIApiKey = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$entry = Join-Path $ProjectRoot "dist\index.js"

$resolvedBaseUrl = $OpenAIBaseUrl
if ([string]::IsNullOrWhiteSpace($resolvedBaseUrl)) {
  $resolvedBaseUrl = [string]$env:OPENAI_BASE_URL
}
if ([string]::IsNullOrWhiteSpace($resolvedBaseUrl)) {
  $resolvedBaseUrl = "local://swe"
}

$resolvedApiKey = $OpenAIApiKey
if ([string]::IsNullOrWhiteSpace($resolvedApiKey)) {
  $resolvedApiKey = [string]$env:OPENAI_API_KEY
}
if ([string]::IsNullOrWhiteSpace($resolvedApiKey)) {
  $resolvedApiKey = "local-anything"
}

$cmd = @"
`$env:PORT='$Port'
`$env:SYNC_DIR='$SyncDir'
`$env:OPENAI_MODEL='$OpenAIModel'
`$env:OPENAI_BASE_URL='$resolvedBaseUrl'
`$env:OPENAI_API_KEY='$resolvedApiKey'
`$env:OPENAI_TIMEOUT_MS='0'
node '$entry'
"@

if ($DryRun) {
  Write-Host "DRY RUN: exec server command:"
  Write-Host $cmd
  exit 0
}

Start-Process powershell -WorkingDirectory $PSScriptRoot -ArgumentList @(
  "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $cmd
)

Write-Host "Started SWE EXEC server on http://127.0.0.1:$Port"
