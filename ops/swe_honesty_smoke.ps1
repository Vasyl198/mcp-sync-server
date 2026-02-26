param(
  [ValidateSet("baseline", "verify")]
  [string]$Mode = "verify",
  [string]$Role = "dev",
  [string]$BaselinePath = "",
  [string]$SyncDir = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-SyncDir {
  param([string]$Value)
  if ($Value -and $Value.Trim()) {
    if ([System.IO.Path]::IsPathRooted($Value)) { return $Value }
    return (Resolve-Path $Value).Path
  }
  return (Join-Path (Get-Location) "_sync")
}

function Get-Json {
  param([string]$Path)
  if (-not (Test-Path $Path)) { throw "File not found: $Path" }
  return (Get-Content -Raw -Encoding UTF8 $Path | ConvertFrom-Json)
}

function Get-FileSha256 {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Get-FileFingerprintFast {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  $item = Get-Item $Path
  return ("{0}:{1}" -f [string]$item.Length, [string]$item.LastWriteTimeUtc.Ticks)
}

function New-Snapshot {
  param(
    [string]$Role,
    [string]$SyncDir,
    [string]$RepoRoot
  )

  $registryPath = Join-Path $SyncDir "agents\registry.json"
  $historyPath = Join-Path $SyncDir "agents\evolution_history.jsonl"
  $metricsPath = Join-Path $SyncDir "agents\metrics.json"

  $sourceFiles = @(
    "src/index.ts",
    "src/agent/store.ts",
    "src/agent/telemetry.ts",
    "src/sync/llm_actions.ts",
    "src/queue.ts"
  )

  $sourceHashes = [ordered]@{}
  foreach ($rel in $sourceFiles) {
    $full = Join-Path $RepoRoot $rel
    $sourceHashes[$rel] = Get-FileSha256 -Path $full
  }

  return [ordered]@{
    ts = (Get-Date).ToString("o")
    role = $Role
    sync_dir = $SyncDir
    repo_root = $RepoRoot
    sync_hashes = [ordered]@{
      registry_json = Get-FileFingerprintFast -Path $registryPath
      metrics_json = Get-FileFingerprintFast -Path $metricsPath
      evolution_history_jsonl = Get-FileFingerprintFast -Path $historyPath
    }
    source_hashes = $sourceHashes
  }
}

function Compare-Snapshots {
  param(
    [object]$Before,
    [object]$After
  )

  $changes = New-Object System.Collections.Generic.List[object]

  foreach ($k in $Before.sync_hashes.PSObject.Properties.Name) {
    $b = [string]$Before.sync_hashes.$k
    $a = [string]$After.sync_hashes.$k
    if ($b -ne $a) {
      $changes.Add([ordered]@{
        area = "sync_file"
        file = $k
        before = $b
        after = $a
      })
    }
  }

  foreach ($k in $Before.source_hashes.PSObject.Properties.Name) {
    $b = [string]$Before.source_hashes.$k
    $a = [string]$After.source_hashes.$k
    if ($b -ne $a) {
      $changes.Add([ordered]@{
        area = "source_file"
        file = $k
        before = $b
        after = $a
      })
    }
  }

  return $changes
}

$repoRoot = (Get-Location).Path
$syncResolved = Resolve-SyncDir -Value $SyncDir
$baselineFile = if ($BaselinePath -and $BaselinePath.Trim()) {
  if ([System.IO.Path]::IsPathRooted($BaselinePath)) { $BaselinePath } else { Join-Path $repoRoot $BaselinePath }
} else {
  Join-Path $syncResolved "swe_honesty_baseline_$Role.json"
}

if ($Mode -eq "baseline") {
  $snap = New-Snapshot -Role $Role -SyncDir $syncResolved -RepoRoot $repoRoot
  $dir = Split-Path -Parent $baselineFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $snap | ConvertTo-Json -Depth 60 | Set-Content -Encoding UTF8 $baselineFile
  Write-Host "Baseline saved: $baselineFile"
  Write-Host "Role: $Role"
  Write-Host "Registry hash: $($snap.sync_hashes.registry_json)"
  exit 0
}

if (-not (Test-Path $baselineFile)) {
  Write-Host "Baseline not found: $baselineFile"
  Write-Host "Run baseline first:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\\ops\\swe_honesty_smoke.ps1 -Mode baseline -Role $Role"
  exit 2
}

$before = Get-Json -Path $baselineFile
$after = New-Snapshot -Role $Role -SyncDir $syncResolved -RepoRoot $repoRoot
$changes = Compare-Snapshots -Before $before -After $after
$changesArray = @($changes)

$result = [ordered]@{
  role = $Role
  baseline = $baselineFile
  before_ts = $before.ts
  after_ts = $after.ts
  changed = ($changesArray.Count -gt 0)
  changes_count = $changesArray.Count
  changes = $changesArray
}

$outPath = Join-Path $syncResolved "swe_honesty_verify_$Role.json"
$result | ConvertTo-Json -Depth 60 | Set-Content -Encoding UTF8 $outPath

if ($changesArray.Count -eq 0) {
  Write-Host "NO REAL LOGIC CHANGES detected."
  Write-Host "If SWE claims changes, this is likely a false report."
  Write-Host "Report: $outPath"
  exit 3
}

Write-Host "REAL CHANGES detected: $($changesArray.Count)"
Write-Host "Report: $outPath"
foreach ($c in $changesArray) {
  if ($c.area -eq "source_file") {
    Write-Host ("- source_file: {0}" -f $c.file)
  } else {
    Write-Host ("- {0}" -f $c.area)
  }
}
exit 0
