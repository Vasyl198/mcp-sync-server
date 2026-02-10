$uri = "http://localhost:3000/mcp"

$headers = @{
  "Content-Type" = "application/json"
}

$bodyObj = @{
  jsonrpc = "2.0"
  id      = 1
  method  = "tools/call"
  params  = @{
    name      = "whoami"
    arguments = @{}
  }
}

$body = $bodyObj | ConvertTo-Json -Depth 10
Write-Host "Sending JSON:"
Write-Host $body

try {
  $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body
  Write-Host "SUCCESS:"
  Write-Host ($response | ConvertTo-Json -Depth 10)
} catch {
  Write-Host "ERROR:"
  Write-Host $_.Exception.Message
  if ($_.Exception.Response) {
    Write-Host "STATUS:" $_.Exception.Response.StatusCode.value__
    Write-Host "CONTENT:" $_.Exception.Response.Content
  }
}
