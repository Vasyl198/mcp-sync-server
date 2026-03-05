$json = @{
    jsonrpc = "2.0"
    id = 1
    method = "tools/call"
    params = @{
        name = "job_history_list"
        arguments = @{
            limit = 5
        }
    }
} | ConvertTo-Json -Depth 3

Write-Host "Sending request:"
Write-Host $json

$response = Invoke-RestMethod -Uri "http://localhost:3000/mcp" -Method Post -ContentType "application/json" -Body $json
Write-Host "Response:"
Write-Host ($response | ConvertTo-Json -Depth 3)
