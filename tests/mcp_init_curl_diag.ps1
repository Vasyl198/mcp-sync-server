$ErrorActionPreference='Stop'
$req='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"0.0.0"}}}'
$tmp=Join-Path $env:TEMP ('mcp_init_'+[guid]::NewGuid().ToString('N')+'.json')
$req | Out-File -Encoding utf8 -NoNewline $tmp
Write-Host 'json:'
Get-Content $tmp
Write-Host '--- curl -i ---'
curl.exe -i -X POST https://mcp.pioneer-mcp.online/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data-binary "@$tmp"
