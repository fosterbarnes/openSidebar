#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$PackOnly
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\scriptHelper.ps1"
Set-Location -LiteralPath $repoRoot
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    function Invoke-Checked([string]$Command, [string[]]$Arguments) {
        Write-Host "> $Command $($Arguments -join ' ')"
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE." }
    }

    if (-not $PackOnly) {
        Invoke-Checked "pwsh" @("-NoProfile", "-File", (Join-Path $PSScriptRoot "checkScripts.ps1"))
        Invoke-Checked "npm" @("run", "typecheck")
        Invoke-Checked "npm" @("test")
        Invoke-Checked "npm" @("run", "build")
    }
    Invoke-Checked "npm" @("run", "pack:check")
}
finally {
    Pop-Location
}

