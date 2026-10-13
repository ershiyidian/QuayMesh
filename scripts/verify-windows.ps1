param(
    [string]$Release = (Join-Path $PSScriptRoot '..\releases\quaymesh-0.1.0-windows-x64'),
    [switch]$CheckStatus
)

$ErrorActionPreference = 'Stop'
$releasePath = [IO.Path]::GetFullPath($Release)
if (-not (Test-Path $releasePath)) { throw "发行目录不存在: $releasePath" }

# 正式 build-windows 把 Host 与窗口放在 components\windows-x64，验证脚本按实际布局检查。
$componentDir = Join-Path $releasePath 'components\windows-x64'
$required = @(
    (Join-Path $releasePath 'runtime\node.exe'),
    (Join-Path $releasePath 'bin\quaymesh.js'),
    (Join-Path $releasePath 'release.json'),
    (Join-Path $componentDir 'tunnel-client.exe'),
    (Join-Path $componentDir 'easytier-core.exe'),
    (Join-Path $componentDir 'QuayMesh.Host.exe'),
    (Join-Path $componentDir 'QuayMesh.Host.dll'),
    (Join-Path $componentDir 'QuayMesh.exe'),
    (Join-Path $componentDir 'Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $componentDir 'Microsoft.Web.WebView2.WinForms.dll'),
    (Join-Path $componentDir 'WebView2Loader.dll')
)
$missing = @($required | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) { throw ("缺少发行文件:`n" + ($missing -join "`n")) }

$releaseInfo = Get-Content (Join-Path $releasePath 'release.json') -Raw | ConvertFrom-Json
if (-not $releaseInfo.sourceCommit -match '^[0-9a-f]{40}$') { throw 'release.json 缺少有效 sourceCommit' }

$result = [ordered]@{
    release = $releasePath
    checkedAt = [DateTimeOffset]::Now.ToString('O')
    sourceCommit = $releaseInfo.sourceCommit
    hostStatus = $null
    processesBefore = @(Get-Process QuayMesh.Host,QuayMesh -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime,Path)
}
if ($CheckStatus) {
    $hostDll = Join-Path $componentDir 'QuayMesh.Host.dll'
    $status = & dotnet $hostDll --status
    if ($LASTEXITCODE -ne 0) { throw "Host status failed: $LASTEXITCODE" }
    if (-not $status) { throw 'Host status returned no JSON' }
    $result.hostStatus = $status | ConvertFrom-Json
}
$result.processesAfter = @(Get-Process QuayMesh.Host,QuayMesh -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime,Path)
$result | ConvertTo-Json -Depth 6
