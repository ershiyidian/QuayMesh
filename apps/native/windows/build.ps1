param([string]$OutputDirectory = '')

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Icon = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..\..\..\app.ico'))
Set-Location $ScriptDir

$OutDir = if ($OutputDirectory) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $ScriptDir "bin" }
if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

# 查找 .NET Framework 4.8 csc.exe
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    Write-Error "错误: 系统未找到 .NET Framework csc.exe 编译器。"
    exit 1
}

Write-Host "检测到系统编译器: $csc"

$LibsDir = Join-Path $ScriptDir "libs"
$Net48LibDir = Join-Path $LibsDir "net48"
$WvCore = Join-Path $Net48LibDir "Microsoft.Web.WebView2.Core.dll"
$WvWinForms = Join-Path $Net48LibDir "Microsoft.Web.WebView2.WinForms.dll"

if (-not (Test-Path $WvCore) -or -not (Test-Path $WvWinForms)) {
    Write-Error "缺少 WebView2 官方程序集依赖: $WvCore 或 $WvWinForms"
    exit 1
}

$Sources = Get-ChildItem -Path (Join-Path $ScriptDir "src") -Filter "*.cs" -Recurse | Select-Object -ExpandProperty FullName
$TargetExe = Join-Path $OutDir "QuayMesh.exe"

# 构建参数数组
$CscArgs = @(
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    "/win32icon:$Icon",
    "/win32manifest:$ScriptDir\app.manifest",
    "/out:$TargetExe",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Net.Http.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.Security.dll",
    "/reference:$WvCore",
    "/reference:$WvWinForms"
) + $Sources

Write-Host "正在调用 csc.exe 编译 QuayMesh.exe ..."
& $csc $CscArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "编译失败，csc.exe 退出代码: $LASTEXITCODE"
    exit $LASTEXITCODE
}

# 复制运行时依赖
Copy-Item -Path $Icon -Destination $OutDir -Force
Copy-Item -Path (Join-Path $ScriptDir "QuayMesh.exe.config") -Destination $OutDir -Force
Copy-Item -Path $WvCore -Destination $OutDir -Force
Copy-Item -Path $WvWinForms -Destination $OutDir -Force
$Loader = Join-Path $LibsDir "WebView2Loader.dll"
if (Test-Path $Loader) {
    Copy-Item -Path $Loader -Destination $OutDir -Force
}
$Runtimes = Join-Path $LibsDir "runtimes"
if (Test-Path $Runtimes) {
    Copy-Item -Path $Runtimes -Destination $OutDir -Recurse -Force
}

Write-Host "=== QuayMesh.exe 编译完成 ==="
Write-Host "产物文件: $TargetExe"

