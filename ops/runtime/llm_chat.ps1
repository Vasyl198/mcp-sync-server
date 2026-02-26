param(
  [string]$BaseUrl = "http://169.254.242.207:1234/v1",
  [string]$Model = "qwen2.5-3b-instruct",
  [string]$System = "You are a helpful assistant.",
  [Parameter(Mandatory=$true)][string]$User,
  [double]$Temperature = 0.2,
  [int]$MaxTokens = 512,
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'

$body = @{
  model = $Model
  temperature = $Temperature
  max_tokens = $MaxTokens
  messages = @(
    @{ role = 'system'; content = $System },
    @{ role = 'user'; content = $User }
  )
}

$json = $body | ConvertTo-Json -Depth 10

try {
  $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat/completions" -ContentType 'application/json' -Body $json -TimeoutSec $TimeoutSec
  $resp | ConvertTo-Json -Depth 20
} catch {
  Write-Error $_
  exit 1
}
