#requires -Version 7.0
param([Alias('f')][switch]$Force, [Parameter(Position = 0)][string]$Message)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\scriptHelper.ps1"
Set-Location -LiteralPath $repoRoot
$commitMessage = if (Test-Path -LiteralPath $buildNotes) { ([IO.File]::ReadAllLines($buildNotes) | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() } else { '' }
if (-not $commitMessage) { $commitMessage = $Message }
if (-not $commitMessage) { throw 'Provide a commit message or add a non-empty first line to buildNotes.txt.' }
$branch = ((& git branch --show-current) | Out-String).Trim()
if ($LASTEXITCODE) { throw 'Could not determine the current branch.' }
if (-not $branch) { throw 'Detached HEAD; refusing to push.' }
runNativeCommand git @('add', '-A') 'git add'
runNativeCommand git @('commit', '-m', $commitMessage) 'git commit'
$pushArgs = @('push', 'origin', $branch); if ($Force) { $pushArgs += '--force' }
runNativeCommand git $pushArgs 'git push'
closeOut 3