param(
  [string]$BaseUrl = "http://169.254.242.207:1234/v1",
  [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'

try {
  Write-Host "Probing $BaseUrl/models ..."
  $models = Invoke-RestMethod -Uri "$BaseUrl/models" -TimeoutSec $TimeoutSec
  $models | ConvertTo-Json -Depth 10
} catch {
  Write-Error $_
  exit 1
}
