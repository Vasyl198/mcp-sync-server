# MCP HTTP connectivity & timeout diagnostics
# Run from PowerShell:  .\tests\mcp_http_tests.ps1
# Requires: curl.exe available in PATH (Windows 10/11 usually has it)

$ErrorActionPreference = 'Stop'

function Run-Step([string]$name, [scriptblock]$fn) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  & $fn
}

$local = "http://127.0.0.1:3000"
$remote = "https://mcp.pioneer-mcp.online"

Run-Step "1) Local health" {
  $r = irm "$local/health"
  Write-Host "local /health => $r"
}

Run-Step "2) Remote health (through tunnel)" {
  $r = irm "$remote/health"
  Write-Host "remote /health => $r"
}

Run-Step "3) Stream 180s (should PASS, keeps connection alive)" {
  curl.exe -v "$remote/debug/stream?ms=180000&interval=15000"
}

Run-Step "4) Sleep 120s (no data for 120s)" {
  curl.exe -v "$remote/debug/sleep?ms=120000"
}

Run-Step "5) Forced client abort at ~85s (should trigger ABORT in server logs)" {
  $p = Start-Process -FilePath "curl.exe" -ArgumentList "-v","$remote/debug/sleep?ms=120000" -NoNewWindow -PassThru
  Start-Sleep -Seconds 85
  if (!$p.HasExited) {
    Write-Host "Stopping curl.exe after 85s to simulate client abort..." -ForegroundColor Yellow
    Stop-Process -Id $p.Id -Force
  }
  Write-Host "Done. Check server console for: ABORT ... /debug/sleep ... (~85000ms)" -ForegroundColor Green
}

Run-Step "6) MCP POST quick sanity" {
  # This simply hits /mcp with an empty JSON object; adjust if your MCP handler requires a valid JSON-RPC envelope.
  # It's here to ensure the route is reachable through the tunnel.
  try {
    $resp = curl.exe -s -o NUL -w "HTTP %{http_code}\n" -X POST "$remote/mcp" -H "Content-Type: application/json" --data "{}"
    Write-Host $resp
  } catch {
    Write-Host "MCP sanity failed (may be expected if /mcp requires JSON-RPC)." -ForegroundColor Yellow
    Write-Host $_
  }
}

Write-Host "`nAll tests executed." -ForegroundColor Cyan
