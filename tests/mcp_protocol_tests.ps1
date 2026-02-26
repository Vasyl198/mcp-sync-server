# MCP protocol diagnostics (initialize + tools/list + tool calls)
# Run from PowerShell in repo root:
#   .\tests\mcp_protocol_tests.ps1
#
# Requires: curl.exe

$ErrorActionPreference = 'Stop'

$remote = "https://mcp.pioneer-mcp.online"
$endpoint = "$remote/mcp"

function Get-HeaderValue([string]$headersText, [string]$name) {
  $rx = "(?im)^" + [regex]::Escape($name) + ":\s*(.+?)\s*$"
  $m = [regex]::Match($headersText, $rx)
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

Write-Host "`n=== 1) Initialize session ===" -ForegroundColor Cyan

$init = @{
  jsonrpc = "2.0"
  id = 0
  method = "initialize"
  params = @{
    protocolVersion = "2024-11-05"
    capabilities = @{}
    clientInfo = @{ name = "mcp-protocol-test"; version = "0.0.1" }
  }
} | ConvertTo-Json -Depth 10 -Compress

$hdrFile = New-TemporaryFile
$bodyFile = New-TemporaryFile

curl.exe -s -D $hdrFile -o $bodyFile -X POST $endpoint `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  --data $init

$hdrText = Get-Content $hdrFile -Raw
$bodyText = Get-Content $bodyFile -Raw

$sessionId = Get-HeaderValue $hdrText "mcp-session-id"
if (-not $sessionId) {
  Write-Host "Initialize response headers:" -ForegroundColor Yellow
  Write-Host $hdrText
  Write-Host "Initialize response body:" -ForegroundColor Yellow
  Write-Host $bodyText
  throw "No mcp-session-id returned. Check protocolVersion or server logs."
}

Write-Host "sessionId = $sessionId" -ForegroundColor Green

function Mcp-Post([int]$id, [string]$method, [object]$params, [int]$maxTimeSec = 0) {
  $req = @{ jsonrpc="2.0"; id=$id; method=$method; params=$params } | ConvertTo-Json -Depth 20 -Compress
  $args = @("-s","-D","-","-X","POST",$endpoint,
            "-H","Content-Type: application/json",
            "-H","Accept: application/json, text/event-stream",
            "-H","mcp-session-id: $sessionId",
            "--data",$req)
  if ($maxTimeSec -gt 0) {
    $args = @("--max-time","$maxTimeSec") + $args
  }
  $out = & curl.exe @args
  return $out
}

Write-Host "`n=== 2) tools/list ===" -ForegroundColor Cyan
$toolsList = Mcp-Post 1 "tools/list" @{}
Write-Host $toolsList

Write-Host "`n=== 3) debug_sleep_sync 1s ===" -ForegroundColor Cyan
$call1 = Mcp-Post 2 "tools/call" @{ name="debug_sleep_sync"; arguments=@{ ms=1000 } }
Write-Host $call1

Write-Host "`n=== 4) debug_sleep_async_start 120s (should return immediately) ===" -ForegroundColor Cyan
$startJob = Mcp-Post 3 "tools/call" @{ name="debug_sleep_async_start"; arguments=@{ ms=120000 } }
Write-Host $startJob

Write-Host "`n=== 5) (optional) simulate client timeout: debug_sleep_sync 120s with curl --max-time 85 ===" -ForegroundColor Cyan
Write-Host "This should create ABORT in server logs around ~85000ms." -ForegroundColor Yellow
try {
  $timeoutCall = Mcp-Post 4 "tools/call" @{ name="debug_sleep_sync"; arguments=@{ ms=120000 } } 85
  Write-Host $timeoutCall
} catch {
  Write-Host "curl aborted as expected (timeout). Check server logs for ABORT." -ForegroundColor Green
}

Write-Host "`n=== 6) Close session (DELETE /mcp) ===" -ForegroundColor Cyan
curl.exe -s -o NUL -w "HTTP %{http_code}`n" -X DELETE $endpoint -H "mcp-session-id: $sessionId"

Write-Host "`nDone." -ForegroundColor Green
