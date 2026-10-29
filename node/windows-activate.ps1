param(
    [Parameter(Mandatory = $true)][string]$PreparedManifest,
    [switch]$RunActivation,
    [string]$ResultDirectory
)
$ErrorActionPreference = 'Stop'
$preparedPath = (Resolve-Path -LiteralPath $PreparedManifest).Path
$prepared = Get-Content -LiteralPath $preparedPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($prepared.version -ne 1 -or $prepared.platform -ne 'win32' -or
    $prepared.sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw '需要有效的 Windows 已准备发行记录。'
}
$releaseRoot = (Resolve-Path -LiteralPath $prepared.directory).Path
$release = Get-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($release.sourceCommit -ne $prepared.sourceCommit -or $release.platform -ne 'windows-x64' -or
    $release.uncommittedSource -ne $false) {
    throw '安装记录与已提交发行包的身份不一致。'
}
$node = Get-Content -LiteralPath $prepared.stagedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($node.id -ne $prepared.nodeId -or
    [IO.Path]::GetFullPath($node.stateDir) -ne [IO.Path]::GetFullPath($prepared.stateDir)) {
    throw '准备配置中的节点或状态目录与安装记录不一致。'
}
$runtime = Join-Path $releaseRoot 'runtime\node.exe'
$entryPoint = Join-Path $releaseRoot 'bin\quaymesh.js'
if ([IO.Path]::GetFullPath($prepared.nodeExecutable) -ne [IO.Path]::GetFullPath($runtime) -or
    [IO.Path]::GetFullPath($prepared.entrypoint) -ne [IO.Path]::GetFullPath($entryPoint)) {
    throw '安装记录必须使用所选发行包自己的 Node 与入口。'
}
$taskName = 'QuayMesh-Activate-' + ($prepared.nodeId -replace '[^A-Za-z0-9_.-]', '_')

function Save-Result($value) {
    $temporary = Join-Path $ResultDirectory ('result.' + $PID + '.tmp')
    $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination (Join-Path $ResultDirectory 'result.json') -Force
}

if (!$RunActivation) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and $existing.State -eq 'Running') { throw '该节点已有正在执行的发行激活任务。' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $administrator = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $runLevel = 'Limited'
    if ($node.mesh.enabled -ne $false -and $node.mesh.mode -eq 'tun') {
        if (!$administrator) { throw 'TUN 节点需要从已提升权限的会话注册激活任务。' }
        $runLevel = 'Highest'
    }
    $ResultDirectory = Join-Path $prepared.stateDir ('activations\' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $ResultDirectory -Force | Out-Null
    $resultPath = Join-Path $ResultDirectory 'result.json'
    $outcome = [ordered]@{ status = 'queued'; nodeId = $prepared.nodeId; sourceCommit = $prepared.sourceCommit;
        taskName = $taskName; preparedManifest = $preparedPath; queuedAt = (Get-Date -Format o) }
    Save-Result $outcome
    $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel $runLevel
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -PreparedManifest "{1}" -RunActivation -ResultDirectory "{2}"' -f $PSCommandPath, $preparedPath, $ResultDirectory
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $releaseRoot
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
    } catch {
        $outcome.status = 'failed'
        $outcome.error = $_.Exception.Message
        Save-Result $outcome
        throw
    }
    # Task Scheduler starts a separate process outside the current Host Job.
    # Returning now lets a caller's managed diagnostic command finish before
    # the independent task asks the Core to freeze admission and drain work.
    [ordered]@{ status = 'queued'; taskName = $taskName; resultPath = $resultPath } | ConvertTo-Json
    return
}

if (!$ResultDirectory -or !(Test-Path -LiteralPath (Join-Path $ResultDirectory 'result.json'))) {
    throw '独立激活任务缺少预先登记的结果文件。'
}
$queued = Get-Content -LiteralPath (Join-Path $ResultDirectory 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($queued.status -ne 'queued' -or $queued.sourceCommit -ne $prepared.sourceCommit -or
    $queued.nodeId -ne $prepared.nodeId -or $queued.preparedManifest -ne $preparedPath) {
    throw '激活任务已经执行，或登记身份不匹配。'
}
$outcome = [ordered]@{ status = 'running'; nodeId = $prepared.nodeId; sourceCommit = $prepared.sourceCommit;
    taskName = $taskName; preparedManifest = $preparedPath; startedAt = (Get-Date -Format o); pid = $PID }
Save-Result $outcome
$logPath = Join-Path $ResultDirectory 'activation.log'
$transcript = $false
$committed = $false
try {
    Start-Transcript -LiteralPath $logPath -Force | Out-Null
    $transcript = $true
    Start-Sleep -Seconds 3
    & $runtime (Join-Path $releaseRoot 'node\verify-installed.mjs')
    if ($LASTEXITCODE -ne 0) { throw '发行包、Node 或 SQLite 原生依赖验证失败，保持当前服务。' }
    Save-Result $outcome
    # Use the installer's authoritative quiescence decision, including valid
    # physical proofs for historical unknown receipts. Active or unproven work
    # still blocks activation. No independent SQL gate runs before this drain.
    # activateInstallation freezes admission, checks the drain, backs up the
    # SQLite database, then requires one unchanged ready Core for 60 seconds.
    # Schema migration failures retain recovery_required instead of starting
    # an older binary against the migrated database.
    & $runtime $entryPoint activate --prepared $preparedPath
    if ($LASTEXITCODE -ne 0) { throw '发行激活未完成，请检查安装过渡记录和本次日志。' }
    $committed = $true
    $status = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/status' -f $prepared.adminPort) -TimeoutSec 5
    if ($status.nodeId -ne $prepared.nodeId -or $status.release -ne $prepared.sourceCommit) {
        throw '安装器已完成，管理端身份复核尚待确认。'
    }
    $outcome.status = 'completed'
    $outcome.core = @($status.components | Where-Object { $_.id -eq 'core' })
} catch {
    $outcome.status = if ($committed) { 'verification_required' } else { 'failed' }
    $outcome.error = $_.Exception.Message
    $transitionPath = Join-Path $prepared.stateDir 'installation-transition.json'
    if (Test-Path -LiteralPath $transitionPath) {
        $transition = Get-Content -LiteralPath $transitionPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $outcome.installationPhase = $transition.phase
        $outcome.databaseBackup = $transition.database.backup
    }
    # The Node installer owns rollback. Do not restart old binaries, stop an
    # already committed service, or touch independent user processes here.
} finally {
    $outcome.finishedAt = (Get-Date -Format o)
    Save-Result $outcome
    if ($transcript) { Stop-Transcript | Out-Null }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
$outcome | ConvertTo-Json -Depth 12
if ($outcome.status -ne 'completed') { exit 1 }
