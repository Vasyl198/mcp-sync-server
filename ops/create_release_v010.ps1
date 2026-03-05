param(
  [string]$Repo = "Vasyl198/mcp-sync-server",
  [string]$Tag = "v0.1.0",
  [string]$Target = "main",
  [string]$NotesPath = "RELEASE_NOTES_v0.1.0.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (!(Test-Path $NotesPath)) {
  throw "Release notes file not found: $NotesPath"
}

$notes = Get-Content $NotesPath -Raw

# Ensure tag exists remotely (create lightweight tag on target if missing)
$tagExists = gh release view $Tag --repo $Repo --json tagName 2>$null
if ($LASTEXITCODE -eq 0 -and $tagExists) {
  Write-Host "Release already exists: $Tag"
  exit 0
}

gh release create $Tag `
  --repo $Repo `
  --target $Target `
  --title "v0.1.0" `
  --notes "$notes" | Out-Null

Write-Host "Created release: $Tag"
