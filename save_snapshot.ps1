# Simple tools snapshot based on current whoami response
$toolsSnapshot = @{
  timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
  auth = "disabled"
  roots = @("C:\Users\anani\Projects")
  sync_dir = "C:\Users\anani\Projects\_sync"
  tools_count = 20
  tools = @(
    "whoami",
    "router_execute_command", 
    "fs_lock_acquire",
    "fs_lock_release", 
    "queue_push",
    "queue_pop",
    "queue_ack",
    "job_history_list",
    "router_execute_from_queue",
    "fs_list",
    "fs_read", 
    "fs_write",
    "fs_mkdir",
    "fs_exists",
    "search_in_files",
    "fs_read_content",
    "fs_write_content",
    "exec",
    "event_publish",
    "event_list"
  )
}

# Write snapshot to file
$snapshotPath = "C:\Users\anani\Projects\_sync\tools_snapshot.json"
$snapshotJson = $toolsSnapshot | ConvertTo-Json -Depth 10
$snapshotJson | Out-File -FilePath $snapshotPath -Encoding UTF8

Write-Host "Tools snapshot saved to: $snapshotPath"
Write-Host "Total tools: $($toolsSnapshot.tools_count)"
Write-Host "Tools list:"
$toolsSnapshot.tools | ForEach-Object { Write-Host "  - $_" }
