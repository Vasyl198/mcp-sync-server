param(
  [string]$OutDir = "docs/marketing/reports"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$template = "docs/marketing/WEEKLY_PROGRESS_REPORT_TEMPLATE.md"
if (!(Test-Path $template)) {
  throw "Template not found: $template"
}

if (!(Test-Path $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$name = "WEEKLY_REPORT_{0}.md" -f (Get-Date -Format "yyyy-MM-dd")
$dst = Join-Path $OutDir $name
Copy-Item $template $dst -Force

Write-Host "Created weekly report file: $dst"
