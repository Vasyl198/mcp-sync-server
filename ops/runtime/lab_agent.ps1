param(
  [string]$BaseUrl = "http://169.254.242.207:1234/v1",
  [string]$Model = "qwen2.5-3b-instruct",
  [Parameter(Mandatory=$true)][string]$User,
  [string]$SystemPrefix = "You are a helpful assistant.",
  [double]$Temperature = 0.2,
  [int]$MaxTokens = 512,
  [int]$MaxSteps = 3,
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Stop'

function Invoke-Chat($messages) {
  $body = @{
    model = $Model
    temperature = $Temperature
    max_tokens = $MaxTokens
    messages = $messages
  }
  $json = $body | ConvertTo-Json -Depth 20
  return Invoke-RestMethod -Method Post -Uri "$BaseUrl/chat/completions" -ContentType 'application/json' -Body $json -TimeoutSec $TimeoutSec
}

# --- "Capabilities injection" ---
$now = Get-Date
$system = @()
$system += $SystemPrefix
$system += "\n\n[Runtime facts]"
$system += "Today is: $($now.ToString('yyyy-MM-dd'))"
$system += "Current time is: $($now.ToString('HH:mm:ss'))"
$system += "Timezone: $([System.TimeZoneInfo]::Local.Id)"
$system += "\n[Tool access] You can ask the LAB to run tools by responding with a JSON object of the form:"
$system += "{\"tool\":\"time.now\"} or {\"tool\":\"fs.read\",\"path\":\"C:/...\"}."
$system += "If you do not need tools, answer normally."
$systemText = ($system -join "\n")

$messages = @(
  @{ role = 'system'; content = $systemText },
  @{ role = 'user'; content = $User }
)

for($step=1; $step -le $MaxSteps; $step++) {
  $resp = Invoke-Chat $messages
  $msg = $resp.choices[0].message.content

  # Try parse as JSON tool request
  $toolReq = $null
  try { $toolReq = $msg | ConvertFrom-Json -ErrorAction Stop } catch { $toolReq = $null }

  if($toolReq -and $toolReq.tool) {
    if($toolReq.tool -eq 'time.now') {
      $toolOut = @{ tool='time.now'; result=@{ date=$now.ToString('yyyy-MM-dd'); time=$now.ToString('HH:mm:ss'); tz=[System.TimeZoneInfo]::Local.Id } } | ConvertTo-Json -Depth 10
      $messages += @{ role='assistant'; content=$msg }
      $messages += @{ role='user'; content="TOOL_RESULT $toolOut" }
      continue
    }

    if($toolReq.tool -eq 'fs.read' -and $toolReq.path) {
      $p = $toolReq.path
      # Minimal safety check (extend as needed)
      $allowed1 = 'C:\\Users\\anani\\Projects'
      $allowed2 = 'C:\\Users\\anani\\.codeium\\windsurf'
      if(($p -notlike "$allowed1*") -and ($p -notlike "$allowed2*")) {
        $toolOut = @{ tool='fs.read'; error='PATH_NOT_ALLOWED'; path=$p } | ConvertTo-Json -Depth 10
      } else {
        try {
          $content = Get-Content -LiteralPath $p -Raw -ErrorAction Stop
          if($content.Length -gt 12000) { $content = $content.Substring(0,12000) + "\n...[truncated]" }
          $toolOut = @{ tool='fs.read'; path=$p; result=$content } | ConvertTo-Json -Depth 10
        } catch {
          $toolOut = @{ tool='fs.read'; path=$p; error=($_ | Out-String) } | ConvertTo-Json -Depth 10
        }
      }
      $messages += @{ role='assistant'; content=$msg }
      $messages += @{ role='user'; content="TOOL_RESULT $toolOut" }
      continue
    }

    # Unknown tool
    $messages += @{ role='assistant'; content=$msg }
    $messages += @{ role='user'; content=("TOOL_RESULT {\"error\":\"UNKNOWN_TOOL\",\"tool\":\"" + $toolReq.tool + "\"}") }
    continue
  }

  # Normal answer
  Write-Output ($resp | ConvertTo-Json -Depth 20)
  exit 0
}

Write-Output (@{error='MAX_STEPS_REACHED'} | ConvertTo-Json)
exit 2
