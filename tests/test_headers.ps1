# Test with proper headers
$headers = @{
    "Content-Type" = "application/json"
}

$json = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'

Write-Host "Testing with headers..."
try {
  $response = Invoke-RestMethod -Uri "http://localhost:3000/mcp" -Method Post -Headers $headers -Body $json
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
