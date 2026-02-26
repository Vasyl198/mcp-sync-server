$ErrorActionPreference = "Stop"

$parent = Split-Path -Parent $PSScriptRoot
$root = if (Test-Path (Join-Path $parent ".env.online")) {
  $parent
} else {
  Join-Path $parent "core\mcp-sync-server"
}
$online = Join-Path $root ".env.online"
$local = Join-Path $root ".env.local"

if (-not (Test-Path $online)) {
  throw "Missing $online"
}

Copy-Item $online $local -Force
Write-Host "Applied online config -> .env.local"

Set-Location $root
npm run dev
