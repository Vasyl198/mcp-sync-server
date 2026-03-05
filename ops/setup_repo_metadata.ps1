param(
  [string]$Repo = "Vasyl198/mcp-sync-server",
  [string]$MilestoneTitle = "v0.1.x"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Ensure-Label([string]$Name, [string]$Color, [string]$Description) {
  $exists = gh label list --repo $Repo --limit 200 --json name `
    | ConvertFrom-Json `
    | Where-Object { $_.name -eq $Name }
  if ($exists) {
    gh label edit $Name --repo $Repo --color $Color --description $Description | Out-Null
    Write-Host "Updated label: $Name"
  } else {
    gh label create $Name --repo $Repo --color $Color --description $Description | Out-Null
    Write-Host "Created label: $Name"
  }
}

$labels = @(
  @{ n = "pilot"; c = "0e8a16"; d = "Pilot intake and delivery tasks" },
  @{ n = "intake"; c = "1d76db"; d = "New incoming requests or triage" },
  @{ n = "security"; c = "b60205"; d = "Security-related work" },
  @{ n = "roadmap"; c = "5319e7"; d = "Roadmap and planning items" },
  @{ n = "docs"; c = "0075ca"; d = "Documentation updates" }
)

foreach ($l in $labels) {
  Ensure-Label -Name $l.n -Color $l.c -Description $l.d
}

$ms = gh api "repos/$Repo/milestones?state=all" | ConvertFrom-Json
$existing = $ms | Where-Object { $_.title -eq $MilestoneTitle }
if ($existing) {
  Write-Host "Milestone exists: $MilestoneTitle (#$($existing.number))"
} else {
  gh api "repos/$Repo/milestones" --method POST -f title="$MilestoneTitle" -f state="open" | Out-Null
  Write-Host "Created milestone: $MilestoneTitle"
}

Write-Host "Done. Repo metadata configured."
