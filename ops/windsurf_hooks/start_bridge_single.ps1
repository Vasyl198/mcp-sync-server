param(
  [string]$McpUrl = "http://127.0.0.1:3000/mcp",
  [string]$Mode = "llm_loop",
  [string]$SessionId = "default",
  [int]$HealthTimeoutSec = 10,
  [switch]$NoNewWindow
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$dialogScript = "C:\Users\anani\Projects\mcp-sync-server\ops\windsurf_hooks\dialog_bridge_swe.ps1"
if (-not (Test-Path $dialogScript)) {
  throw "Dialog script not found: $dialogScript"
}

if ([string]::IsNullOrWhiteSpace($McpUrl)) {
  throw "McpUrl is empty."
}

$baseUrl = $McpUrl
if ($baseUrl.EndsWith("/mcp")) {
  $baseUrl = $baseUrl.Substring(0, $baseUrl.Length - 4)
}
$healthUrl = "$baseUrl/health"

Write-Host "Checking MCP health: $healthUrl"
$ok = $false
$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(2, $HealthTimeoutSec))
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Get -Uri $healthUrl -TimeoutSec 3
    if ($r.StatusCode -eq 200 -and ([string]$r.Content).Trim() -eq "ok") {
      $ok = $true
      break
    }
  } catch {}
  Start-Sleep -Milliseconds 500
}
if (-not $ok) {
  throw "MCP server is not healthy on $healthUrl"
}
Write-Host "MCP health OK."

# Stable single-server mode: reasoner follows same endpoint as exec.
$env:WINDSURF_SWE_MCP_URL = $McpUrl
$env:WINDSURF_SWE_REASONER_MCP_URL = $McpUrl
$env:WINDSURF_SWE_MODE = $Mode

Write-Host "Bridge environment set:"
Write-Host "  WINDSURF_SWE_MCP_URL=$($env:WINDSURF_SWE_MCP_URL)"
Write-Host "  WINDSURF_SWE_REASONER_MCP_URL=$($env:WINDSURF_SWE_REASONER_MCP_URL)"
Write-Host "  WINDSURF_SWE_MODE=$($env:WINDSURF_SWE_MODE)"

if ($NoNewWindow) {
  powershell -NoProfile -ExecutionPolicy Bypass -File $dialogScript -SessionId $SessionId
  exit $LASTEXITCODE
}

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $dialogScript,
  "-SessionId", $SessionId
)

Write-Host "Bridge dialog window started (session: $SessionId)."
