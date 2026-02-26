$ErrorActionPreference = "Stop"

param(
  [string]$ConfigPath = "$env:USERPROFILE\.cloudflared\config.yml",
  [string]$TunnelName = "mcp-sync",
  [int]$MetricsPort = 20241
)

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  throw "cloudflared.exe is not available in PATH"
}

if (-not (Test-Path $ConfigPath)) {
  throw "Cloudflared config not found: $ConfigPath"
}

$token = (& cloudflared tunnel token $TunnelName) -join ""
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "Failed to get tunnel token for '$TunnelName'. Run: cloudflared tunnel login"
}

Write-Host "Starting cloudflared tunnel '$TunnelName' with config '$ConfigPath'"
& cloudflared tunnel --config $ConfigPath --protocol http2 --edge-ip-version 4 --metrics "127.0.0.1:$MetricsPort" run --token $token
