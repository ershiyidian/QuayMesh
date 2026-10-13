param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseDirectory,
    [switch]$RunCutover
)

$ErrorActionPreference = 'Stop'
$releaseRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$release = Get-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($release.platform -ne 'windows-x64' -or $release.uncommittedSource) {
    throw '需要已经提交代码的完整 Windows x64 发行包。'
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要在管理员 PowerShell 中执行，才能修改 EasyTier 和 QuayMesh 的计划任务。'
}

$runtime = Join-Path $releaseRoot 'runtime\node.exe'
$entryPoint = Join-Path $releaseRoot 'bin\quaymesh.js'
$configDir = Join-Path $env:LOCALAPPDATA 'QuayMesh\config'
$nodeConfig = Join-Path $configDir 'node.json'
$node = Get-Content -LiteralPath $nodeConfig -Encoding UTF8 -Raw | ConvertFrom-Json
if (!$node.mesh.enabled -or $node.mesh.mode -ne 'tun') {
    throw '当前 QuayMesh 节点尚未启用受管 TUN 网络。'
}

$taskName = 'QuayMesh-Release-Cutover'
$resultPath = Join-Path $node.stateDir 'release-cutover-result.json'
$logPath = Join-Path $node.stateDir 'release-cutover.log'

# 切换会停止当前 QuayMesh Host，因而由 Windows 计划任务在独立进程中完成部署。
if (!$RunCutover) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and $existing.State -eq 'Running') {
        throw 'QuayMesh 已经有一个正在执行的发行切换任务。'
    }
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ReleaseDirectory "{1}" -RunCutover' -f $PSCommandPath, $releaseRoot
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $releaseRoot
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(2)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output "已独立启动 QuayMesh 网络和版本切换。完成记录：$resultPath"
    return
}

$outcome = [ordered]@{ sourceCommit = $release.sourceCommit; startedAt = (Get-Date -Format o); status = 'running' }
Start-Transcript -Path $logPath -Force | Out-Null
$outcome | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
$easyTask = Get-ScheduledTask -TaskName 'EasyTier'
$easyWasEnabled = $easyTask.State -ne 'Disabled'
$cutoverStarted = $false
$rollbackDirectory = Join-Path $node.stateDir 'release-cutover-rollback'

function Find-PreparedManifest {
    $preparedFiles = @(Get-ChildItem -LiteralPath (Join-Path $configDir 'installations') -Filter 'prepared.json' -File -Recurse |
        Sort-Object LastWriteTimeUtc -Descending)
    foreach ($file in $preparedFiles) {
        $candidate = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($candidate.sourceCommit -eq $release.sourceCommit -and $candidate.nodeId -eq $node.id -and
            (Test-Path -LiteralPath $candidate.stagedConfig) -and (Test-Path -LiteralPath $candidate.directory)) {
            return $file.FullName
        }
    }
    return $null
}

try {
    # 先检查已有的已验证安装，避免为同一提交重复复制发行包。
    $preparedPath = Find-PreparedManifest
    if (!$preparedPath) {
        & $runtime $entryPoint install --config $nodeConfig --config-dir $configDir --no-start
        if ($LASTEXITCODE -ne 0) { throw 'QuayMesh 发行包准备失败。' }
        $preparedPath = Find-PreparedManifest
    }
    if (!$preparedPath) { throw '发行包准备完成，但没有找到有效安装记录。' }

    $preflightPath = Join-Path $releaseRoot 'node\cutover-preflight.mjs'
    if (!(Test-Path $preflightPath)) { throw '发行包缺少安全切换预检查。' }
    $idle = & $runtime $preflightPath $node.stateDir
    if ($LASTEXITCODE -ne 0) {
        throw ('仍有正在执行的工作，保持当前版本：{0}' -f ($idle -join ' '))
    }
    $outcome.preflight = $idle -join ''

    New-Item -ItemType Directory -Path $rollbackDirectory -Force | Out-Null
    Copy-Item -LiteralPath $nodeConfig -Destination (Join-Path $rollbackDirectory 'node.json') -Force
    Copy-Item -LiteralPath (Join-Path $env:LOCALAPPDATA 'QuayMesh\config.json') -Destination (Join-Path $rollbackDirectory 'host.json') -Force
    Copy-Item -LiteralPath (Join-Path $configDir 'installation.json') -Destination (Join-Path $rollbackDirectory 'installation.json') -Force
    $oldTaskXml = Export-ScheduledTask -TaskName 'QuayMesh'
    $oldTaskXml | Set-Content -LiteralPath (Join-Path $rollbackDirectory 'quaymesh-task.xml') -Encoding Unicode

    $rpcOwners = @(Get-NetTCPConnection -State Listen -LocalPort $node.mesh.rpcPort -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess)
    $external = @(Get-CimInstance Win32_Process -Filter "Name='easytier-core.exe'" |
        Where-Object {
            $rpcOwners -contains $_.ProcessId -and
            $_.ExecutablePath -and
            $_.ExecutablePath -notlike (Join-Path $env:LOCALAPPDATA 'QuayMesh\releases\*')
        })
    if ($external.Count -gt 1) { throw "找到 $($external.Count) 个独立 EasyTier 实例，停止切换。" }

    $cutoverStarted = $true
    if ($easyWasEnabled) { Disable-ScheduledTask -TaskName 'EasyTier' | Out-Null }
    foreach ($instance in $external) {
        Stop-Process -Id $instance.ProcessId -Force
    }

    # 旧版维护接口可能因滞留的控制台/MCP长连接返回409；独立读取执行台账
    # 已确认无正在执行的工作后，由计划任务终止旧Host，绕开该错误维护门。
    # --background 的 Host 是单实例托盘进程，计划任务可能已处于 Ready。
    # 必须通过现有 Host 管道发送 --exit 才能停止真正的受管进程树。
    $installed = Get-Content -LiteralPath (Join-Path $configDir 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldHost = Join-Path $installed.directory 'components\windows-x64\QuayMesh.Host.exe'
    if (!(Test-Path $oldHost)) { throw '当前安装记录缺少可执行的 QuayMesh Host 停止入口。' }
    & $oldHost --exit
    $oldTask = Get-ScheduledTask -TaskName 'QuayMesh'
    if ($oldTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName 'QuayMesh' -ErrorAction Stop
    }
    $deadlineOld = (Get-Date).AddSeconds(30)
    do {
        $oldListeners = @(Get-NetTCPConnection -State Listen -LocalPort $node.adminPort -ErrorAction SilentlyContinue)
        if ($oldListeners.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadlineOld)
    if ($oldListeners.Count -ne 0) { throw '旧QuayMesh服务未释放管理端口，已中止新版本激活。' }

    & $runtime $entryPoint activate --prepared $preparedPath
    if ($LASTEXITCODE -ne 0) { throw 'QuayMesh 发行包激活失败。安装器已执行恢复步骤。' }

    $deadline = (Get-Date).AddSeconds(110)
    $ready = $false
    do {
        Start-Sleep -Seconds 2
        $status = $null
        try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($node.adminPort)/status" -TimeoutSec 4 }
        catch { continue }
        $quayTask = Get-ScheduledTask -TaskName 'QuayMesh'
        $triggers = @($quayTask.Triggers | ForEach-Object { $_.CimClass.CimClassName })
        $easyState = (Get-ScheduledTask -TaskName 'EasyTier').State
        $ready = $status.release -eq $release.sourceCommit -and
            @($status.components | Where-Object { $_.id -eq 'mesh' -and $_.state -eq 'ready' }).Count -eq 1 -and
            @($status.components | Where-Object { $_.id -eq 'core' -and $_.state -eq 'ready' }).Count -eq 1 -and
            $status.membership.connected -eq $true -and
            $triggers -contains 'MSFT_TaskBootTrigger' -and
            $triggers -contains 'MSFT_TaskLogonTrigger' -and
            $easyState -eq 'Disabled'
    } while (!$ready -and (Get-Date) -lt $deadline)
    if (!$ready) { throw '新发行的网络、核心或计划任务在限定时间内没有恢复。' }
    $outcome.status = 'completed'
    $outcome.meshPid = @($status.components | Where-Object id -eq 'mesh')[0].pid
    $outcome.membershipConnected = $status.membership.connected
    $outcome.discoveryReady = $status.discovery.ready
} catch {
    $outcome.status = 'failed'
    $outcome.error = $_.Exception.Message
    if ($cutoverStarted) {
        # 网络接管失败时先停用受管实例，再恢复原独立通道。
        Stop-ScheduledTask -TaskName 'QuayMesh' -ErrorAction SilentlyContinue
        if (Test-Path (Join-Path $rollbackDirectory 'node.json')) {
            Copy-Item -LiteralPath (Join-Path $rollbackDirectory 'node.json') -Destination $nodeConfig -Force
            Copy-Item -LiteralPath (Join-Path $rollbackDirectory 'host.json') -Destination (Join-Path $env:LOCALAPPDATA 'QuayMesh\config.json') -Force
            Copy-Item -LiteralPath (Join-Path $rollbackDirectory 'installation.json') -Destination (Join-Path $configDir 'installation.json') -Force
            $oldTaskXml = Get-Content -LiteralPath (Join-Path $rollbackDirectory 'quaymesh-task.xml') -Encoding Unicode -Raw
            Register-ScheduledTask -TaskName 'QuayMesh' -Xml $oldTaskXml -Force | Out-Null
        }
        if ($easyWasEnabled) {
            Enable-ScheduledTask -TaskName 'EasyTier' | Out-Null
            Start-ScheduledTask -TaskName 'EasyTier'
        }
        Start-ScheduledTask -TaskName 'QuayMesh'
    }
    throw
} finally {
    $outcome.finishedAt = Get-Date -Format o
    $outcome | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    Stop-Transcript | Out-Null
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
$outcome | ConvertTo-Json -Depth 5
