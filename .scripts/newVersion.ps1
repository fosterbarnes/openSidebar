#requires -Version 7.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Show-NewVersionHelp {
    Write-Host @"
  .\newVersion.ps1 -+       Major bump: 1.0.0 -> 2.0.0
  .\newVersion.ps1 -++      Minor bump: 0.1.0 -> 0.2.0
  .\newVersion.ps1 -+++     Patch bump: 0.0.1 -> 0.0.2
  .\newVersion.ps1 +        Major bump
  .\newVersion.ps1 ++       Minor bump
  .\newVersion.ps1 +++      Patch bump
"@
}

$flags = @($args | ForEach-Object { "$($_)".Trim() } | Where-Object { $_.Length -gt 0 })
if ($flags.Count -ne 1) {
    Show-NewVersionHelp
    if ($flags.Count -gt 1) { throw "Specify exactly one version bump." }
    exit 0
}

$bump = switch -Regex ($flags[0]) {
    '^(\-\+|\+)$' { "major"; break }
    '^(\-\+\+|\+\+)$' { "minor"; break }
    '^(\-\+\+\+|\+\+\+)$' { "patch"; break }
    default { throw "Unknown version bump: $($flags[0])" }
}

$package = Get-Content -LiteralPath "$root\package.json" -Raw | ConvertFrom-Json
$current = [version]$package.version
$next = switch ($bump) {
    "major" { [version]::new($current.Major + 1, 0, 0) }
    "minor" { [version]::new($current.Major, $current.Minor + 1, 0) }
    "patch" { [version]::new($current.Major, $current.Minor, $current.Build + 1) }
}

& npm version $next --no-git-tag-version --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "npm version failed with exit code $LASTEXITCODE." }
Write-Host "Version updated: $current -> $next"
