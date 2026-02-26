param(
  [string]$ProjectRoot = "C:\Users\anani\Projects\mcp-sync-server",
  [string]$SyncDir = "C:\Users\anani\Projects\mcp-sync-server\_sync",
  [int]$ExecPort = 3000,
  [int]$ReasonerPort = 3001,
  [string]$ReasonerBaseUrl = "local://swe",
  [string]$ReasonerModel = "swe-local",
  [string]$ReasonerApiKey = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

Write-Host "Starting dual SWE servers..."

$execArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\start_swe_exec_server.ps1",
  "-ProjectRoot", $ProjectRoot,
  "-SyncDir", $SyncDir,
  "-Port", $ExecPort
)
if ($DryRun) { $execArgs += "-DryRun" }
powershell @execArgs

$reasonerArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\start_swe_reasoner_server.ps1",
  "-ProjectRoot", $ProjectRoot,
  "-SyncDir", $SyncDir,
  "-Port", $ReasonerPort,
  "-OpenAIBaseUrl", $ReasonerBaseUrl,
  "-OpenAIModel", $ReasonerModel
)
if (-not [string]::IsNullOrWhiteSpace($ReasonerApiKey)) {
  $reasonerArgs += @("-OpenAIApiKey", $ReasonerApiKey)
}
if ($DryRun) { $reasonerArgs += "-DryRun" }
powershell @reasonerArgs

Write-Host ""
Write-Host "Done."
Write-Host "Exec     : http://127.0.0.1:$ExecPort/mcp"
Write-Host "Reasoner : http://127.0.0.1:$ReasonerPort/mcp"
Write-Host ""
Write-Host "For bridge SWE consumer:"
Write-Host "  WINDSURF_SWE_MCP_URL=http://127.0.0.1:$ExecPort/mcp"
Write-Host "  WINDSURF_SWE_REASONER_MCP_URL=http://127.0.0.1:$ReasonerPort/mcp"
