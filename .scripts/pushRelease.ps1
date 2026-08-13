#requires -Version 7.0

[CmdletBinding()]
param([Alias('h')][switch]$Help)

$ErrorActionPreference = 'Stop'
if ($Help) {
    Write-Host @"
Usage:
  .\pushRelease.ps1

Builds the npm package, replaces the matching Git tag, pushes the tag, and
publishes the GitHub release. Release notes are entered interactively.
"@
    exit 0
}

$root = Split-Path -Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
$packagePath = "$root\package.json"
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid package version: '$version'." }

$tagName = "v$version"
$releaseTitle = "openSidebar v$version"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "openSidebar-release-$version"
$artifact = $null

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }

    & npm pack --pack-destination $tempRoot
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)." }
    $artifact = Get-ChildItem -LiteralPath $tempRoot -Filter '*.tgz' -File | Select-Object -First 1
    if (-not $artifact) { throw "npm pack produced no tarball in '$tempRoot'." }

    Write-Host "Version: $version"
    Write-Host "Enter release notes. Finish with two empty lines."
    $releaseNotesLines = @()
    $emptyLines = 0
    while ($true) {
        $line = Read-Host ">"
        if ($line -eq '') {
            $emptyLines++
            if ($emptyLines -ge 2) { break }
            $releaseNotesLines += ''
            continue
        }
        $emptyLines = 0
        $releaseNotesLines += ($line -replace "`t", '    ')
    }
    if (-not ($releaseNotesLines -join '').Trim()) { throw 'No release notes entered.' }
    $releaseNotes = ($releaseNotesLines -join "`n").Trim()

    if (git tag -l $tagName) {
        & git tag -d $tagName
        if ($LASTEXITCODE -ne 0) { throw "Could not delete local tag '$tagName'." }
    }
    $remoteTags = @(git ls-remote --tags origin "refs/tags/$tagName")
    if ($remoteTags.Count -gt 0) {
        & git push origin --delete $tagName
        if ($LASTEXITCODE -ne 0) { throw "Could not delete remote tag '$tagName'." }
    }

    & git tag $tagName
    if ($LASTEXITCODE -ne 0) { throw "Could not create tag '$tagName'." }
    & git push origin $tagName
    if ($LASTEXITCODE -ne 0) { throw "Could not push tag '$tagName'." }
    & gh release create $tagName $artifact.FullName --title $releaseTitle --notes $releaseNotes --latest
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)." }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
