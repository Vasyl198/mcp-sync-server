$ErrorActionPreference = "Stop"

$parent = Split-Path -Parent $PSScriptRoot
$root = if (Test-Path (Join-Path $parent ".env.offline")) {
  $parent
} else {
  Join-Path $parent "core\mcp-sync-server"
}
$offline = Join-Path $root ".env.offline"
$local = Join-Path $root ".env.local"

if (-not (Test-Path $offline)) {
  throw "Missing $offline"
}

Copy-Item $offline $local -Force
Write-Host "Applied offline config -> .env.local"

Set-Location $root
npm run dev
