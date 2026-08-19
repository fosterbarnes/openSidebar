#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\scriptHelper.ps1"
Set-Location -LiteralPath $repoRoot
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $package = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
    $lockVersions = & node -p 'const lock = require("./package-lock.json"); lock.version + "|" + lock.packages[""].version'
    if ($LASTEXITCODE -ne 0) { throw "Could not read package-lock.json through Node." }
    $lockVersion, $lockRootVersion = $lockVersions.Trim() -split "\|", 2
    if ($package.version -ne $lockVersion -or $package.version -ne $lockRootVersion) {
        throw "package.json and package-lock.json versions are out of sync."
    }
    if (-not (Test-Path -LiteralPath "dist/sidebar.js")) {
        throw "dist/sidebar.js is missing. Run .scripts/build.ps1 first."
    }

    $shell = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $shell) { $shell = Get-Command powershell -ErrorAction SilentlyContinue }
    if (-not $shell) { throw "PowerShell 7 or Windows PowerShell is required." }
    & $shell.Source -NoProfile -File (Join-Path $PSScriptRoot "build.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Build gate failed with exit code $LASTEXITCODE." }
    Write-Host "Pre-push checks passed for version $($package.version)."
}
finally {
    Pop-Location
}
closeOut 3

