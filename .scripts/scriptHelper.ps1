#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$root = $repoRoot
$versionFolder = "$repoRoot\.version"
$version = "$versionFolder\version"
$versionBuild = "$versionFolder\versionBuild"
$versionTag = "$versionFolder\versionTag"
$buildNotes = "$repoRoot\buildNotes.txt"
$noBom = New-Object System.Text.UTF8Encoding $false

function readVerFile {
    param([string]$LiteralPath = $version)
    $lines = @(([IO.File]::ReadAllText($LiteralPath) -split '\r?\n' | ForEach-Object { $_.Trim() }))
    while ($lines.Count -lt 3) { $lines += '' }
    $lines
}

function writeFileNoBom {
    param([Parameter(Mandatory)][string]$LiteralPath, [Parameter(Mandatory)][string]$Content)
    [IO.File]::WriteAllText($LiteralPath, $Content, $noBom)
}

function writeVerFile {
    param(
        [Parameter(Mandatory)][string]$SemVer,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Tag,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Build
    )
    writeFileNoBom -LiteralPath $version -Content (($SemVer.Trim(), $Tag.Trim(), $Build.Trim()) -join "`n")
    $script:versionContents = $SemVer.Trim()
    $script:versionTagContents = $Tag.Trim()
}

function getReleaseTag {
    if ($versionTagContents) { return $versionTagContents }
    return "v$versionContents"
}

function syncPackageVersion {
    $packagePath = "$repoRoot\package.json"
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $package.version = $versionContents
    $json = $package | ConvertTo-Json -Depth 20
    writeFileNoBom -LiteralPath $packagePath -Content ($json + "`n")
    & npm install --package-lock-only --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm lockfile synchronization failed with exit code $LASTEXITCODE." }
}

$versionLines = readVerFile
$versionContents = $versionLines[0]
$versionTagContents = $versionLines[1]
