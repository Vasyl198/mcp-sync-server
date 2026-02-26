param(
  [string]$BaseUrl = "http://127.0.0.1:11435/v1",
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
