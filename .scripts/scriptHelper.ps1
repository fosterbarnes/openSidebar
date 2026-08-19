#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
$root = $repoRoot
$versionFolder = "$repoRoot\.version"
$version = "$versionFolder\version"
$versionBuild = "$versionFolder\versionBuild"
$versionTag = "$versionFolder\versionTag"
$buildNotes = "$repoRoot\buildNotes.txt"
$readme = "$repoRoot\README.md"
$scripts = "$repoRoot\.scripts"
$noBom = New-Object System.Text.UTF8Encoding $false
$weztermExe = (Get-Command wezterm.exe -ErrorAction SilentlyContinue)?.Source

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
    $lockPath = "$repoRoot\package-lock.json"
    $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
    $package.version = $versionContents
    $json = $package | ConvertTo-Json -Depth 20
    writeFileNoBom -LiteralPath $packagePath -Content ($json + "`n")
    Push-Location $repoRoot
    try {
        & npm install --package-lock-only --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm lockfile synchronization failed with exit code $LASTEXITCODE." }
        $syncLock = @'
const fs = require("node:fs");
const pkg = require("./package.json");
const lockPath = "./package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
lock.version = pkg.version;
if (lock.packages && lock.packages[""]) lock.packages[""].version = pkg.version;
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
'@
        & node -e $syncLock
        if ($LASTEXITCODE -ne 0) { throw "Could not write package-lock.json versions through Node." }
    }
    finally {
        Pop-Location
    }
}

function deleteDir {
    param([Parameter(Mandatory)][string]$Path)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function runNativeCommand {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)]$ArgumentList, [Parameter(Mandatory)][string]$Name)
    & $FilePath @ArgumentList
    if ($LASTEXITCODE) { throw "$Name failed (exit $LASTEXITCODE)." }
}

function writeClearedLine {
    param([Parameter(Mandatory)][string]$Text, [Parameter(Mandatory)][int]$PadWidth, [switch]$NoNewline)
    Write-Host "`r$Text$(' ' * [Math]::Max(0, $PadWidth - $Text.Length))" -NoNewline:$NoNewline
}

function closeOut {
    param([int]$Seconds = 5)
    $caller = $MyInvocation.PSCommandPath
    if ([string]::IsNullOrWhiteSpace($caller)) { return }
    $argv = [Environment]::GetCommandLineArgs()
    $fileArg = $null
    for ($i = 0; $i -lt $argv.Length; $i++) {
        if ("$($argv[$i])" -match '^(?i)-File$|^(?i)-f$') {
            if ($i + 1 -lt $argv.Length) { $fileArg = $argv[$i + 1] }
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($fileArg)) { return }
    try {
        $fileFull = [IO.Path]::GetFullPath($fileArg)
        $callerFull = [IO.Path]::GetFullPath($caller)
    } catch { return }
    if (-not [string]::Equals($fileFull, $callerFull, [StringComparison]::OrdinalIgnoreCase)) { return }
    if ($Seconds -lt 0) { $Seconds = 0 }
    if ($Seconds -gt 0) {
        $pad = "closing after $Seconds seconds..."
        foreach ($n in $Seconds..1) {
            writeClearedLine -Text "closing after $n seconds..." -PadWidth $pad.Length -NoNewline
            Start-Sleep -Seconds 1
        }
        writeClearedLine -Text 'closing...' -PadWidth $pad.Length
    }
    try {
        if ($env:WEZTERM_PANE -and $weztermExe) { & $weztermExe @('cli', 'kill-pane', '--pane-id', $env:WEZTERM_PANE) }
    } catch { }
    [Environment]::Exit(0)
}

$versionLines = readVerFile
$versionContents = $versionLines[0]
$versionTagContents = $versionLines[1]
Set-Location -LiteralPath $repoRoot