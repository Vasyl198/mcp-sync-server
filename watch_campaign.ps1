param(
  [string]$CampaignId = "",
  [int]$IntervalSec = 2,
  [int]$StallThresholdSec = 120
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$campaignsDir = Join-Path $root "_sync\campaigns"
$queueDir = Join-Path $root "_sync\queue"
$jobsPath = Join-Path $queueDir "jobs.jsonl"
$claimsPath = Join-Path $queueDir "claims.jsonl"
$acksPath = Join-Path $queueDir "acks.jsonl"

$script:QueueCache = @{
  Signature = ""
  Snapshot = $null
}

function Get-OrDefault {
  param($Value, $Default)
  if ($null -eq $Value) { return $Default }
  return $Value
}

function Try-ParseDate {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  try { return [datetime]::Parse($Value) } catch { return $null }
}

function Resolve-CampaignFile {
  param(
    [string]$Dir,
    [string]$RequestedCampaignId
  )

  if (-not (Test-Path $Dir)) {
    throw "Campaign directory not found: $Dir"
  }

  if (-not [string]::IsNullOrWhiteSpace($RequestedCampaignId)) {
    $direct = Join-Path $Dir ("{0}.json" -f $RequestedCampaignId)
    if (Test-Path $direct) {
      return [pscustomobject]@{
        CampaignId = $RequestedCampaignId
        Path = $direct
      }
    }
    throw "Campaign file not found: $direct"
  }

  $files = Get-ChildItem -Path $Dir -Filter "*.json" -File -ErrorAction Stop
  if (-not $files -or $files.Count -eq 0) {
    throw "No campaign files in $Dir"
  }

  $items = foreach ($f in $files) {
    try {
      $obj = (Get-Content -Raw -Encoding UTF8 $f.FullName | ConvertFrom-Json)
      [pscustomobject]@{
        File = $f
        Obj = $obj
        Status = [string](Get-OrDefault $obj.status "unknown")
        UpdatedAt = Try-ParseDate([string](Get-OrDefault $obj.updated_at ""))
      }
    } catch {
      continue
    }
  }

  $running = $items | Where-Object { $_.Status -eq "running" } | Sort-Object UpdatedAt -Descending
  $picked = if ($running -and $running.Count -gt 0) {
    $running[0]
  } else {
    ($items | Sort-Object UpdatedAt -Descending)[0]
  }

  return [pscustomobject]@{
    CampaignId = [string](Get-OrDefault $picked.Obj.campaign_id $picked.File.BaseName)
    Path = $picked.File.FullName
  }
}

function Get-LastTick {
  param($CampaignObj)
  if ($null -eq $CampaignObj.history) { return $null }
  $ticks = @($CampaignObj.history | Where-Object { $_.type -eq "campaign.tick" })
  if ($ticks.Count -eq 0) { return $null }
  return $ticks[$ticks.Count - 1]
}

function Get-QueueSnapshot {
  param(
    [string]$JobsFile,
    [string]$ClaimsFile,
    [string]$AcksFile
  )

  if (-not (Test-Path $JobsFile) -or -not (Test-Path $ClaimsFile) -or -not (Test-Path $AcksFile)) {
    return $null
  }

  $jobsInfo = Get-Item $JobsFile
  $claimsInfo = Get-Item $ClaimsFile
  $acksInfo = Get-Item $AcksFile
  $sig = "{0}:{1}|{2}:{3}|{4}:{5}" -f $jobsInfo.Length, $jobsInfo.LastWriteTimeUtc.Ticks, $claimsInfo.Length, $claimsInfo.LastWriteTimeUtc.Ticks, $acksInfo.Length, $acksInfo.LastWriteTimeUtc.Ticks
  if ($script:QueueCache.Signature -eq $sig -and $null -ne $script:QueueCache.Snapshot) {
    return $script:QueueCache.Snapshot
  }

  $jobsById = @{}
  $jobQueueById = @{}
  foreach ($line in (Get-Content -Path $JobsFile -Encoding UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $j = $line | ConvertFrom-Json
      $jobId = [string]$j.job_id
      if ([string]::IsNullOrWhiteSpace($jobId)) { continue }
      $jobsById[$jobId] = $true
      $jobQueueById[$jobId] = [string](Get-OrDefault $j.logical_queue "unknown")
    } catch {
      continue
    }
  }

  $ackedById = @{}
  foreach ($line in (Get-Content -Path $AcksFile -Encoding UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $a = $line | ConvertFrom-Json
      $jobId = [string]$a.job_id
      if ([string]::IsNullOrWhiteSpace($jobId)) { continue }
      $ackedById[$jobId] = $true
    } catch {
      continue
    }
  }

  $latestClaimById = @{}
  foreach ($line in (Get-Content -Path $ClaimsFile -Encoding UTF8)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $c = $line | ConvertFrom-Json
      $jobId = [string]$c.job_id
      if ([string]::IsNullOrWhiteSpace($jobId)) { continue }
      $latestClaimById[$jobId] = $c
    } catch {
      continue
    }
  }

  $snapshot = @{
    total_pending = 0
    total_running = 0
    by_queue = @{
      campaign = @{ pending = 0; running = 0 }
      exec = @{ pending = 0; running = 0 }
      research = @{ pending = 0; running = 0 }
      meta = @{ pending = 0; running = 0 }
      other = @{ pending = 0; running = 0 }
    }
  }

  $now = Get-Date
  foreach ($jobId in $jobsById.Keys) {
    if ($ackedById.ContainsKey($jobId)) { continue }
    $queue = [string](Get-OrDefault $jobQueueById[$jobId] "other")
    if (-not $snapshot.by_queue.ContainsKey($queue)) {
      $queue = "other"
    }

    $running = $false
    if ($latestClaimById.ContainsKey($jobId)) {
      $leaseText = [string](Get-OrDefault $latestClaimById[$jobId].lease_until "")
      $lease = Try-ParseDate $leaseText
      if ($null -ne $lease) {
        $running = ($lease -gt $now)
      }
    }

    if ($running) {
      $snapshot.total_running++
      $snapshot.by_queue[$queue].running++
    } else {
      $snapshot.total_pending++
      $snapshot.by_queue[$queue].pending++
    }
  }

  $script:QueueCache.Signature = $sig
  $script:QueueCache.Snapshot = $snapshot
  return $snapshot
}

$resolved = Resolve-CampaignFile -Dir $campaignsDir -RequestedCampaignId $CampaignId
$campaignPath = $resolved.Path
$CampaignId = $resolved.CampaignId

while ($true) {
  try {
    $raw = Get-Content -Path $campaignPath -Raw -Encoding UTF8
    $c = $raw | ConvertFrom-Json

    $tickCount = [int](Get-OrDefault $c.tick_count 0)
    $maxTicks = [int](Get-OrDefault $c.stop_conditions.max_ticks 0)
    $experimentsRun = [int](Get-OrDefault $c.experiments_run 0)
    $maxExperiments = [int](Get-OrDefault $c.max_experiments 0)
    $status = [string](Get-OrDefault $c.status "unknown")
    $updatedAtText = [string](Get-OrDefault $c.updated_at "")
    $updatedAt = Try-ParseDate $updatedAtText
    $stopReason = [string](Get-OrDefault $c.stop_reason "")
    $now = Get-Date
    $ageSec = if ($null -ne $updatedAt) { [int](($now - $updatedAt).TotalSeconds) } else { -1 }

    $liveState = "UNKNOWN"
    $liveColor = "Yellow"
    if ($status -eq "running") {
      if ($ageSec -ge 0 -and $ageSec -gt $StallThresholdSec) {
        $liveState = "STALLED?"
        $liveColor = "Yellow"
      } else {
        $liveState = "RUNNING"
        $liveColor = "Green"
      }
    } elseif ($status -eq "completed" -or $status -eq "stopped") {
      $liveState = "FINISHED"
      $liveColor = "Cyan"
    }

    $lastTick = Get-LastTick $c
    $lastTickIndex = ""
    $lastTickRuns = ""
    $lastTickGihi = ""
    $lastTickTs = ""
    if ($null -ne $lastTick) {
      $lastTickIndex = [string](Get-OrDefault $lastTick.data.tick_index "")
      $lastTickRuns = [string](Get-OrDefault $lastTick.data.created_runs "")
      $lastTickGihi = [string](Get-OrDefault $lastTick.data.gihi "")
      $lastTickTs = [string](Get-OrDefault $lastTick.ts "")
    }

    $q = Get-QueueSnapshot -JobsFile $jobsPath -ClaimsFile $claimsPath -AcksFile $acksPath

    Clear-Host
    Write-Host "Campaign Monitor (real-time)" -ForegroundColor Cyan
    Write-Host ("Now:        {0}" -f $now.ToString("yyyy-MM-dd HH:mm:ss"))
    Write-Host ("Campaign:   {0}" -f $CampaignId)
    Write-Host ("File:       {0}" -f $campaignPath)
    Write-Host ("Live:       {0}" -f $liveState) -ForegroundColor $liveColor
    Write-Host ("Status:     {0}" -f $status)
    Write-Host ("Ticks:      {0}/{1}" -f $tickCount, $maxTicks)
    Write-Host ("Runs:       {0}/{1}" -f $experimentsRun, $maxExperiments)
    Write-Host ("Updated:    {0}" -f $updatedAtText)
    if ($ageSec -ge 0) {
      Write-Host ("Age:        {0}s since last update" -f $ageSec)
    }
    if (-not [string]::IsNullOrWhiteSpace($stopReason)) {
    Write-Host ("Stop:       {0}" -f $stopReason)
    }

    Write-Host ""
    Write-Host "Last tick:"
    Write-Host ("  tick_index: {0}" -f $lastTickIndex)
    Write-Host ("  created_runs: {0}" -f $lastTickRuns)
    Write-Host ("  gihi: {0}" -f $lastTickGihi)
    Write-Host ("  ts: {0}" -f $lastTickTs)

    if ($null -ne $q) {
      Write-Host ""
      Write-Host "Queue (live):"
      Write-Host ("  campaign: pending={0} running={1}" -f $q.by_queue.campaign.pending, $q.by_queue.campaign.running)
      Write-Host ("  exec:     pending={0} running={1}" -f $q.by_queue.exec.pending, $q.by_queue.exec.running)
      Write-Host ("  research: pending={0} running={1}" -f $q.by_queue.research.pending, $q.by_queue.research.running)
      Write-Host ("  meta:     pending={0} running={1}" -f $q.by_queue.meta.pending, $q.by_queue.meta.running)
      Write-Host ("  total:    pending={0} running={1}" -f $q.total_pending, $q.total_running)
    }

    Write-Host ""
    Write-Host ("Refresh each {0}s (Ctrl+C to stop)" -f $IntervalSec) -ForegroundColor DarkGray

    if ($status -eq "completed" -or $status -eq "stopped") {
      Write-Host ""
      Write-Host "Campaign finished. Monitor stopped." -ForegroundColor Green
      break
    }
  } catch {
    Clear-Host
    Write-Host ("Monitor read error: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    Write-Host "Retrying..." -ForegroundColor DarkGray
  }

  Start-Sleep -Seconds $IntervalSec
}
