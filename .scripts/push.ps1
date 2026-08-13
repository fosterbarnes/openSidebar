#requires -Version 7.0

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$Message,
    [Alias('f')][switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root

$branch = if (git branch --list main) { 'main' }
          elseif (git branch --list master) { 'master' }
          else { Read-Host 'Branch name' }
if (-not $branch) { throw 'A branch name is required.' }

& git add -A
if ($LASTEXITCODE -ne 0) { throw "git add failed (exit $LASTEXITCODE)." }

& git commit -m $Message
if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)." }

$pushArgs = if ($Force) { @('--force') } else { @() }
& git push origin $branch @pushArgs
if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)." }
