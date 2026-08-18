#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\scriptHelper.ps1"

function Show-Help {
    Write-Host @"
newVersion.ps1              Patch bump
newVersion.ps1 -+           Major bump
newVersion.ps1 -++          Minor bump
newVersion.ps1 -+++         Patch bump
newVersion.ps1 -tag         Set the optional release tag
"@
}

$wantTag = $false
$bump = $null
foreach ($flag in @($args | ForEach-Object { "$_".Trim() } | Where-Object Length)) {
    switch -Regex ($flag) {
        '(?i)^(-h|--help)$' { Show-Help; exit 0 }
        '(?i)^(-tag|--tag)$' { $wantTag = $true }
        '^\-\+$' { if ($bump) { throw 'Use only one bump flag.' }; $bump = 'major' }
        '^\-\+\+$' { if ($bump) { throw 'Use only one bump flag.' }; $bump = 'minor' }
        '^\-\+\+\+$' { if ($bump) { throw 'Use only one bump flag.' }; $bump = 'patch' }
        default { throw "Unknown argument: $flag" }
    }
}
if (-not $bump -and -not $wantTag) { $bump = 'patch' }
$lines = readVerFile
$parts = @($lines[0] -split '\.')
if ($parts.Count -ne 3 -or ($parts | Where-Object { $_ -notmatch '^\d+$' })) { throw "Invalid semantic version: $($lines[0])" }
$major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
switch ($bump) {
    'major' { $major++; $minor = 0; $patch = 0 }
    'minor' { $minor++; $patch = 0 }
    'patch' { $patch++ }
}
$tagValue = $lines[1]
if ($wantTag) { $tagValue = Read-Host 'Release tag (leave empty to use v<version>)' }
writeVerFile -SemVer "$major.$minor.$patch" -Tag $tagValue -Build $lines[2]
syncPackageVersion
if (Test-Path -LiteralPath $buildNotes) {
    $tail = @([IO.File]::ReadAllLines($buildNotes) | Select-Object -Skip 1)
    writeFileNoBom -LiteralPath $buildNotes -Content ((@("v$major.$minor.$patch release") + $tail) -join "`n")
}
Write-Host "Version -> $major.$minor.$patch"
