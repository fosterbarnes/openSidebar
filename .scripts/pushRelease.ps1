#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\scriptHelper.ps1"
Set-Location -LiteralPath $repoRoot
$version = $versionContents
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid package version: '$version'." }

$tagName = getReleaseTag
$releaseTitle = "openSidebar v$version"
$notesBody = ''
if (Test-Path -LiteralPath $buildNotes) {
    $noteLines = @([IO.File]::ReadAllLines($buildNotes))
    if ($noteLines.Count -gt 0 -and $noteLines[0].Trim()) {
        $releaseTitle = $noteLines[0].Trim()
        if ($noteLines.Count -gt 1) {
            $notesBody = ($noteLines[1..($noteLines.Count - 1)] -join "`n").Trim()
        }
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "openSidebar-release-$version"
$artifact = $null
try {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    runNativeCommand npm @('pack', '--pack-destination', $tempRoot) 'npm pack'
    $artifact = Get-ChildItem -LiteralPath $tempRoot -Filter '*.tgz' -File | Select-Object -First 1
    if (-not $artifact) { throw "npm pack produced no tarball in '$tempRoot'." }

    runNativeCommand git @('tag', '-f', $tagName) 'git tag'
    runNativeCommand git @('push', 'origin', "refs/tags/$tagName", '--force') 'git push tag'

    $releaseArgs = @('release', 'create', $tagName, '--title', $releaseTitle, '--repo', $ghRepo, '--latest')
    if ($notesBody) { $releaseArgs += @('--notes', $notesBody) } else { $releaseArgs += '--generate-notes' }
    runNativeCommand gh ($releaseArgs + $artifact.FullName) 'gh release create'
}
finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
closeOut 3
