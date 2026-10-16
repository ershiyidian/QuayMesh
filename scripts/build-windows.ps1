param([string]$Output = (Join-Path $PSScriptRoot '..\components\windows-x64'))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Path $target -Force | Out-Null
$project = Join-Path $root 'apps\windows\QuayMesh.Host\QuayMesh.Host.csproj'
dotnet publish $project -c Release -r win-x64 --self-contained true -o $target
if ($LASTEXITCODE -ne 0) { throw 'QuayMesh Host 构建失败。' }
& (Join-Path $root 'apps\native\windows\build.ps1') -OutputDirectory $target
if ($LASTEXITCODE -ne 0) { throw 'QuayMesh 窗口构建失败。' }
