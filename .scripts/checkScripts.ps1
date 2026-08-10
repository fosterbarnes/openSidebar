#requires -Version 7.0
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot "newVersion.ps1"
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $shell) { $shell = (Get-Command powershell -ErrorAction SilentlyContinue)?.Source }
if (-not $shell) { throw "PowerShell 7 or Windows PowerShell is required." }

$cases = @(
    @{ Flag = "-+"; Expected = "2.0.0" }
    @{ Flag = "-++"; Expected = "1.3.0" }
    @{ Flag = "-+++"; Expected = "1.2.4" }
    @{ Flag = "+"; Expected = "2.0.0" }
    @{ Flag = "++"; Expected = "1.3.0" }
    @{ Flag = "+++"; Expected = "1.2.4" }
)

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "openSidebar-script-check-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$tempScripts = Join-Path $tempRoot ".scripts"
New-Item -ItemType Directory -Path $tempScripts | Out-Null
$tempScriptPath = Join-Path $tempScripts "newVersion.ps1"
Copy-Item -LiteralPath $scriptPath -Destination $tempScriptPath
try {
    foreach ($case in $cases) {
        $packagePath = Join-Path $tempRoot "package.json"
        @{ name = "script-check"; version = "1.2.3" } | ConvertTo-Json | Set-Content -LiteralPath $packagePath
        $versionOutput = & $shell -NoProfile -File $tempScriptPath $case.Flag 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Version script failed for '$($case.Flag)'." }
        $actual = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).version
        if ($actual -ne $case.Expected) {
            throw "Version script returned '$actual' for '$($case.Flag)'; expected '$($case.Expected)'."
        }
    }

    $packagePath = Join-Path $tempRoot "package.json"
    @{ name = "script-check"; version = "1.2.3" } | ConvertTo-Json | Set-Content -LiteralPath $packagePath
    $rejectedOutput = & $shell -NoProfile -File $tempScriptPath "major" 2>&1
    if ($LASTEXITCODE -eq 0) { throw "Named bump syntax must be rejected." }
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Script contract checks passed."
