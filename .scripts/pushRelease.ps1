#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\scriptHelper.ps1"
Set-Location -LiteralPath $repoRoot
$version = $versionContents
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid package version: '$version'." }

$tagName = getReleaseTag
$releaseTitle = "openSidebar v$version"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "openSidebar-release-$version"
$artifact = $null

try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

    & npm pack --pack-destination $tempRoot
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed (exit $LASTEXITCODE)." }
    $artifact = Get-ChildItem -LiteralPath $tempRoot -Filter '*.tgz' -File | Select-Object -First 1
    if (-not $artifact) { throw "npm pack produced no tarball in '$tempRoot'." }

    $notes = if (Test-Path -LiteralPath $buildNotes) { [IO.File]::ReadAllText($buildNotes).Trim() } else { '' }

    runNativeCommand git @('tag', '-f', $tagName) 'git tag'
    runNativeCommand git @('push', 'origin', "refs/tags/$tagName", '--force') 'git push tag'

    $releaseArgs = @('release', 'create', $tagName, '--title', $releaseTitle, '--latest')
    if ($notes) { $releaseArgs += @('--notes', $notes) } else { $releaseArgs += '--generate-notes' }
    runNativeCommand gh ($releaseArgs + $artifact.FullName) 'gh release create'
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
closeOut 3