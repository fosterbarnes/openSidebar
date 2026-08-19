#requires -Version 7.0
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$scriptPath = Join-Path $PSScriptRoot 'newVersion.ps1'
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue)?.Source
if (-not $shell) { $shell = (Get-Command powershell -ErrorAction SilentlyContinue)?.Source }
if (-not $shell) { throw 'PowerShell 7 or Windows PowerShell is required.' }

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "openSidebar-script-check-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path "$tempRoot\.scripts", "$tempRoot\.version" | Out-Null
Copy-Item -LiteralPath $scriptPath -Destination "$tempRoot\.scripts\newVersion.ps1"
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'scriptHelper.ps1') -Destination "$tempRoot\.scripts\scriptHelper.ps1"
try {
    foreach ($case in @(
        @{ Args = @(); Expected = '1.2.8' }
        @{ Args = @('-+'); Expected = '2.0.0' }
        @{ Args = @('-++'); Expected = '1.3.0' }
        @{ Args = @('-+++'); Expected = '1.2.8' }
    )) {
        Set-Content -LiteralPath "$tempRoot\.version\version" -Value "1.2.7`n`n" -NoNewline
        Set-Content -LiteralPath "$tempRoot\.version\versionTag" -Value '' -NoNewline
        Set-Content -LiteralPath "$tempRoot\.version\versionBuild" -Value 'x64' -NoNewline
        @{ name = 'script-check'; version = '1.2.7' } | ConvertTo-Json | Set-Content -LiteralPath "$tempRoot\package.json"
        $output = & $shell -NoProfile -File "$tempRoot\.scripts\newVersion.ps1" @($case.Args) 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Version script failed for '$($case.Args -join ' ')'." }
        $actual = (Get-Content -LiteralPath "$tempRoot\.version\version" -Raw).Split("`n")[0].Trim()
        if ($actual -ne $case.Expected) { throw "Version script returned '$actual'; expected '$($case.Expected)'." }
    }
    Set-Content -LiteralPath "$tempRoot\.version\version" -Value "1.2.7`n`n" -NoNewline
    Set-Content -LiteralPath "$tempRoot\.version\versionTag" -Value '' -NoNewline
    Set-Content -LiteralPath "$tempRoot\.version\versionBuild" -Value 'x64' -NoNewline
    @{ name = 'script-check'; version = '1.2.7' } | ConvertTo-Json | Set-Content -LiteralPath "$tempRoot\package.json"
    & $shell -NoProfile -File "$tempRoot\.scripts\newVersion.ps1" 'major' 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { throw 'Named bump syntax must be rejected.' }
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Script contract checks passed.'
