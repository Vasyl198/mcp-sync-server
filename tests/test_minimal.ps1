# Test minimal JSON
$uri = "http://localhost:3000/mcp"
$headers = @{
  "Content-Type" = "application/json"
}

# Most minimal possible JSON
$body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'

Write-Host "Minimal JSON test:"
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
    try {
      $content = $_.Exception.Response.Content.ReadAsStringAsync().Result
      Write-Host "CONTENT:" $content
    } catch {
      Write-Host "CONTENT: [cannot read]"
    }
  }
}
