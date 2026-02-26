# MCP protocol diagnostics v2 (file-based JSON payloads to avoid PowerShell quoting issues)
# Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\mcp_protocol_tests_v2.ps1

$ErrorActionPreference = 'Stop'

$remote = "https://mcp.pioneer-mcp.online"
$endpoint = "$remote/mcp"

function Get-HeaderValue([string]$headersText, [string]$name) {
  $rx = "(?im)^" + [regex]::Escape($name) + ":\s*(.+?)\s*$"
  $m = [regex]::Match($headersText, $rx)
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

function Curl-JsonFile([string]$method, [string]$url, [string]$jsonPath, [hashtable]$headers, [int]$maxTimeSec = 0) {
  $args = @('-s','-D','-','-X',$method,$url)
  foreach ($k in $headers.Keys) {
    $args += @('-H', ('{0}: {1}' -f $k, $headers[$k]))
  }
  if ($maxTimeSec -gt 0) {
    $args = @('--max-time', "$maxTimeSec") + $args
  }
  if ($jsonPath) {
    $args += @('--data-binary', "@$jsonPath")
  }
  # IMPORTANT: external command output comes back as string[]; keep it as lines here.
  return & curl.exe @args
}

function Split-CurlHeadersBody([object]$curlOutput) {
  # Normalize curl output to a single string for reliable parsing.
  $text = if ($curlOutput -is [array]) { ($curlOutput -join "`n") } else { [string]$curlOutput }
  $parts = [regex]::Split($text, "\r?\n\r?\n", 2)
  $hdr = if ($parts.Length -gt 0) { $parts[0] } else { '' }
  $body = if ($parts.Length -gt 1) { $parts[1] } else { '' }
  return @($hdr, $body)
}

Write-Host "`n=== 1) Initialize session ===" -ForegroundColor Cyan

$tmpDir = Join-Path $env:TEMP ("mcp_test_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null

$initObj = @{ 
  jsonrpc = '2.0'
  id = 0
  method = 'initialize'
  params = @{
    protocolVersion = '2024-11-05'
    capabilities = @{}
    clientInfo = @{ name = 'mcp-protocol-test-v2'; version = '0.0.2' }
  }
}

$initJsonPath = Join-Path $tmpDir 'init.json'
($initObj | ConvertTo-Json -Depth 10 -Compress) | Out-File -FilePath $initJsonPath -Encoding utf8 -NoNewline

$headers = @{ 
  'Content-Type' = 'application/json'
  'Accept' = 'application/json, text/event-stream'
}

$raw = Curl-JsonFile 'POST' $endpoint $initJsonPath $headers
$pair = Split-CurlHeadersBody $raw
$hdrText = $pair[0]
$bodyText = $pair[1]

$sessionId = Get-HeaderValue $hdrText 'mcp-session-id'

if (-not $sessionId) {
  Write-Host "Initialize response headers:" -ForegroundColor Yellow
  Write-Host $hdrText
  Write-Host "Initialize response body:" -ForegroundColor Yellow
  Write-Host $bodyText
  throw "No mcp-session-id returned. Check server logs."
}

Write-Host "sessionId = $sessionId" -ForegroundColor Green

function Mcp-Post([int]$id, [string]$method, [object]$params, [int]$maxTimeSec = 0) {
  $obj = @{ jsonrpc='2.0'; id=$id; method=$method; params=$params }
  $p = Join-Path $tmpDir ("req_" + $id + ".json")
  ($obj | ConvertTo-Json -Depth 20 -Compress) | Out-File -FilePath $p -Encoding utf8 -NoNewline

  $h = @{ 
    'Content-Type' = 'application/json'
    'Accept' = 'application/json, text/event-stream'
    'mcp-session-id' = $sessionId
  }
  $raw2 = Curl-JsonFile 'POST' $endpoint $p $h $maxTimeSec
  $pair2 = Split-CurlHeadersBody $raw2
  return ($pair2[0] + "`n`n" + $pair2[1])
}

Write-Host "`n=== 2) tools/list ===" -ForegroundColor Cyan
Write-Host (Mcp-Post 1 'tools/list' @{})

Write-Host "`n=== 3) tools/call debug_sleep_sync 1s ===" -ForegroundColor Cyan
Write-Host (Mcp-Post 2 'tools/call' @{ name='debug_sleep_sync'; arguments=@{ ms=1000 } })

Write-Host "`n=== 4) tools/call debug_sleep_async_start 120s (should return immediately) ===" -ForegroundColor Cyan
Write-Host (Mcp-Post 3 'tools/call' @{ name='debug_sleep_async_start'; arguments=@{ ms=120000 } })

Write-Host "`n=== 5) (optional) simulate client timeout: debug_sleep_sync 120s with curl --max-time 85 ===" -ForegroundColor Cyan
Write-Host "This should create ABORT in server logs around ~85000ms." -ForegroundColor Yellow
try {
  Write-Host (Mcp-Post 4 'tools/call' @{ name='debug_sleep_sync'; arguments=@{ ms=120000 } } 85)
} catch {
  Write-Host "curl aborted as expected (timeout). Check server logs for ABORT." -ForegroundColor Green
}

Write-Host "`n=== 6) Close session (DELETE /mcp) ===" -ForegroundColor Cyan
& curl.exe -s -o NUL -w "HTTP %{http_code}`n" -X DELETE $endpoint -H ("mcp-session-id: $sessionId")

Write-Host "`nDone." -ForegroundColor Green
