param(
    [string]$EasyTier,
    [string]$Tunnel,
    [string]$Egress,
    [switch]$BuildComponents
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
corepack pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
if ($BuildComponents) {
    corepack pnpm build:components --source
} elseif ($EasyTier -or $Tunnel) {
    $arguments = @('build:components','--easytier',$EasyTier,'--tunnel',$Tunnel)
    if ($Egress) { $arguments += @('--egress',$Egress) }
    & corepack pnpm @arguments
}
if ($LASTEXITCODE -ne 0) { throw '组件准备失败。' }
corepack pnpm build:bundle
if ($LASTEXITCODE -ne 0) { throw '发行包构建失败。' }
