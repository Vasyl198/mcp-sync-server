param(
  [string]$ProjectRoot = "C:\Users\anani\Projects\mcp-sync-server",
  [int]$ExecPort = 3000,
  [int]$ReasonerPort = 3001,
  [string]$BackendUrl = "local://swe",
  [string]$BackendModel = "swe-local",
  [switch]$OpenDialog
)

$ErrorActionPreference = "Stop"

Write-Host "Starting lab stack..."
Write-Host ("ProjectRoot : {0}" -f $ProjectRoot)
Write-Host ("LLM backend : {0}" -f $BackendUrl)
Write-Host ("Exec MCP    : http://127.0.0.1:{0}/mcp" -f $ExecPort)
Write-Host ("Reasoner MCP: http://127.0.0.1:{0}/mcp" -f $ReasonerPort)
Write-Host ""

$execScript = Join-Path $ProjectRoot "ops\swe_dual\start_swe_exec_server.ps1"
$reasonerScript = Join-Path $ProjectRoot "ops\swe_dual\start_swe_reasoner_server.ps1"
$dialogScript = Join-Path $ProjectRoot "ops\windsurf_hooks\dialog_bridge_swe.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File $execScript `
  -ProjectRoot $ProjectRoot `
  -Port $ExecPort `
  -OpenAIBaseUrl $BackendUrl `
  -OpenAIModel $BackendModel `
  -OpenAIApiKey "local-anything"

powershell -NoProfile -ExecutionPolicy Bypass -File $reasonerScript `
  -ProjectRoot $ProjectRoot `
  -Port $ReasonerPort `
  -OpenAIBaseUrl $BackendUrl `
  -OpenAIModel $BackendModel `
  -OpenAIApiKey "local-anything"

Write-Host ""
Write-Host "Lab stack started."
Write-Host ("Set bridge env in current shell:")
Write-Host ('$env:WINDSURF_SWE_MCP_URL="http://127.0.0.1:' + $ExecPort + '/mcp"')
Write-Host ('$env:WINDSURF_SWE_REASONER_MCP_URL="http://127.0.0.1:' + $ReasonerPort + '/mcp"')
Write-Host ('$env:WINDSURF_SWE_MODE="auto_exec"   # or llm_loop')

if ($OpenDialog) {
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", $dialogScript,
    "-SessionId", "default"
  )
  Write-Host "Bridge dialog window opened."
}
