function Set-Utf8Console {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $script:OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  try { chcp 65001 | Out-Null } catch {}
}

function Read-Utf8JsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try {
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
    return ($text | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-Utf8JsonFile {
  param([string]$Path, $Object, [int]$Depth = 30)
  $json = $Object | ConvertTo-Json -Depth $Depth
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Append-Utf8Jsonl {
  param([string]$Path, $Object, [int]$Depth = 30)
  $line = $Object | ConvertTo-Json -Depth $Depth -Compress
  [System.IO.File]::AppendAllText($Path, ($line + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
}
