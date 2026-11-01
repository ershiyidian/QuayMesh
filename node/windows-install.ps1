param(
    [Parameter(Mandatory=$true)][string]$NodeExecutable,
    [Parameter(Mandatory=$true)][string]$EntryPoint,
    [Parameter(Mandatory=$true)][string]$Config,
    [Parameter(Mandatory=$true)][string]$Directory,
    [switch]$DesktopUi,
    [switch]$Start
)
$ErrorActionPreference = 'Stop'
$arguments = '"{0}" run --config "{1}"' -f $EntryPoint, $Config
$executable = $NodeExecutable
$nodeSettings = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$runLevel = 'Limited'
if ($nodeSettings.mesh.enabled -ne $false -and $nodeSettings.mesh.mode -eq 'tun') {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (!$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'TUN 节点需要管理员权限，请以管理员身份运行安装命令。'
    }
    $runLevel = 'Highest'
}
if ($DesktopUi) {
    $hostPath = Join-Path $Directory 'components\windows-x64\QuayMesh.Host.exe'
    $uiPath = Join-Path $Directory 'components\windows-x64\QuayMesh.exe'
    if (!(Test-Path $hostPath) -or !(Test-Path $uiPath)) { throw '发行包缺少 QuayMesh Windows 窗口组件。' }
    $settings = Get-Content $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    $cluster = Get-Content $settings.clusterFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $appDir = Join-Path $env:LOCALAPPDATA 'QuayMesh'
    New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    $port = if ($settings.adminPort) { $settings.adminPort } else { 17677 }
    $hostConfig = @{
        ServerUrl = ('http://127.0.0.1:{0}/console/' -f $cluster.discovery.localPort)
        StateDirectory = $settings.stateDir
        Port = $port
        Supervise = $true
        Worker = @{
            Executable = $NodeExecutable
            Arguments = $arguments
            WorkingDirectory = $Directory
            Enabled = $true
            Environment = @{
                QUAYMESH_NODE_CONTROL_URL = ('http://127.0.0.1:{0}' -f $port)
                QUAYMESH_NODE_TOKEN_FILE = (Join-Path $settings.stateDir 'cluster.token')
            }
        }
        UiExecutable = $uiPath
        UiArguments = ''
    }
    $hostConfig | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $appDir 'config.json') -Encoding UTF8
    $executable = $hostPath
    $arguments = '--supervise --background'
}
$action = New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $Directory
$trigger = @(
    (New-ScheduledTaskTrigger -AtStartup)
    (New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name))
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -RunLevel $runLevel -Force | Out-Null

# 托盘界面和节点统一使用同一个计划任务，移除历史注册表启动项。
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
foreach ($name in @('QuayMeshHost', 'QuayMesh')) {
    if (Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name $name
    }
}
if ($Start) { Start-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\' }
Write-Output 'QuayMesh 已安装。'
