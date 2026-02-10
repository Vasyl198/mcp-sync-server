# Test current working directory
Write-Host "Current working directory:"
Write-Host (Get-Location).Path

# Test server basic response
try {
  $response = Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing
  Write-Host "Server response:"
  Write-Host $response.StatusCode
} catch {
  Write-Host "Server error:"
  Write-Host $_.Exception.Message
}
