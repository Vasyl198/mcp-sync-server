param(
  [string]$BaseUrl = "http://127.0.0.1:11435/v1",
  [string]$Model = "qwen2.5-3b-instruct",
  [string]$System = "You are a helpful assistant. Always answer in Russian language.",
  [double]$Temperature = 0.2,
  [int]$MaxTokens = 512,
  [int]$TimeoutSec = 120,
  [int]$MaxHistoryTurns = 6
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

Write-Host "RAW LLM dialog started (not Bridge SWE). Type 'exit' to quit."
Write-Host "Model: $Model"
Write-Host "Base : $BaseUrl"
Write-Host ""

$messages = @(
  @{ role = "system"; content = $System }
)

function Invoke-ChatUtf8 {
  param(
    [string]$Url,
    [hashtable]$Payload,
    [int]$TimeoutSecValue = 120
  )

  $json = $Payload | ConvertTo-Json -Depth 20 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method Post -Uri "$Url/chat/completions" -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec $TimeoutSecValue
}

while ($true) {
  [Console]::Write("You: ")
  $user = [Console]::ReadLine()
  if ([string]::IsNullOrWhiteSpace($user)) { continue }
  if ($user.Trim().ToLowerInvariant() -eq "exit") { break }

  $messages += @{ role = "user"; content = $user }

  $tailCount = [Math]::Max(0, $MaxHistoryTurns * 2)
  $tail = @()
  if ($messages.Count -gt 1) {
    $tail = $messages | Select-Object -Skip 1 | Select-Object -Last $tailCount
  }
  $requestMessages = @($messages[0]) + @($tail)

  $body = @{
    model = $Model
    temperature = $Temperature
    max_tokens = $MaxTokens
    messages = $requestMessages
  }

  try {
    $resp = Invoke-ChatUtf8 -Url $BaseUrl -Payload $body -TimeoutSecValue $TimeoutSec
    $answer = [string]$resp.choices[0].message.content
    if ([string]::IsNullOrWhiteSpace($answer)) { $answer = "[empty response]" }

    Write-Host ""
    Write-Host "LLM: $answer"
    Write-Host ""

    $messages += @{ role = "assistant"; content = $answer }
  } catch {
    try {
      $retryBody = @{
        model = $Model
        temperature = $Temperature
        max_tokens = $MaxTokens
        messages = @(
          $messages[0],
          @{ role = "user"; content = $user }
        )
      }
      $resp = Invoke-ChatUtf8 -Url $BaseUrl -Payload $retryBody -TimeoutSecValue $TimeoutSec
      $answer = [string]$resp.choices[0].message.content
      if ([string]::IsNullOrWhiteSpace($answer)) { $answer = "[empty response]" }

      Write-Host ""
      Write-Host "LLM: $answer"
      Write-Host ""

      $messages = @(
        @{ role = "system"; content = $System },
        @{ role = "user"; content = $user },
        @{ role = "assistant"; content = $answer }
      )
    } catch {
      Write-Host ""
      Write-Host "Request failed: $($_.Exception.Message)"
      Write-Host ""
    }
  }
}

Write-Host "Dialog closed."
