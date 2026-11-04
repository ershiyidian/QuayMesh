param(
    [switch]$Unregister,
    [string]$HostExecutable,
    [ValidateRange(1, 300)][int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'

if ($HostExecutable) {
    if ($Unregister) { throw 'Graceful Host shutdown cannot unregister the Task.' }
    $expectedImage = [IO.Path]::GetFullPath($HostExecutable)
    $scheduler = New-Object -ComObject Schedule.Service
    $scheduler.Connect()
    $folder = $scheduler.GetFolder('\')
    $registered = $folder.GetTask('QuayMesh')
    $definition = [string]$registered.Xml
    $actions = @($registered.Definition.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Type -ne 0 -or
        -not [string]::Equals([IO.Path]::GetFullPath($actions[0].Path), $expectedImage, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The registered QuayMesh Task does not launch the expected Host.'
    }
    $instances = @($registered.GetInstances(0))
    if ($instances.Count -ne 1) { throw 'Expected exactly one running QuayMesh Task instance.' }
    $instanceGuid = [string]$instances[0].InstanceGuid
    $enginePid = [int]$instances[0].EnginePID
    if ([string]::IsNullOrWhiteSpace($instanceGuid) -or $enginePid -lt 1 -or
        -not [string]::Equals([IO.Path]::GetFullPath($instances[0].CurrentAction), $expectedImage, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The running QuayMesh Task identity does not match the expected Host.'
    }
    $engineProcess = Get-Process -Id $enginePid -ErrorAction Stop
    $exitClient = $null
    try {
        $null = $engineProcess.Handle
        $engineStart = $engineProcess.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
        if ($engineProcess.HasExited -or
            -not [string]::Equals([IO.Path]::GetFullPath($engineProcess.MainModule.FileName), $expectedImage, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The Task engine process is not the expected Host generation.'
        }
        function Get-OriginalTaskInstances {
            $currentTask = $folder.GetTask('QuayMesh')
            if ([string]$currentTask.Xml -cne $definition) { throw 'The QuayMesh Task definition changed during shutdown.' }
            $current = @($currentTask.GetInstances(0))
            foreach ($instance in $current) {
                if ([string]$instance.InstanceGuid -ne $instanceGuid -or [int]$instance.EnginePID -ne $enginePid) {
                    throw 'The QuayMesh Task instance changed during shutdown.'
                }
            }
            return $current
        }
        if (@(Get-OriginalTaskInstances).Count -ne 1 -or $engineProcess.HasExited) {
            throw 'The original QuayMesh Host exited before its shutdown request.'
        }
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $exitClient = Start-Process -FilePath $expectedImage -ArgumentList '--exit' -PassThru -NoNewWindow
        $clientBudget = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $exitClient.WaitForExit($clientBudget) -or $exitClient.ExitCode -ne 0) {
            throw 'The Host exit client did not complete successfully; shutdown remains unconfirmed.'
        }
        while ([DateTime]::UtcNow -lt $deadline) {
            $remaining = @(Get-OriginalTaskInstances)
            if ($engineProcess.HasExited -and $remaining.Count -eq 0) {
                [pscustomobject]@{
                    stopped = $true
                    taskInstance = $instanceGuid
                    hostPid = $enginePid
                    hostStart = ('win32:' + $engineStart)
                    forced = $false
                } | ConvertTo-Json -Compress
                return
            }
            Start-Sleep -Milliseconds 200
        }
        throw 'Timed out waiting for the original QuayMesh Host and Task instance to exit; no Task stop was requested.'
    }
    finally {
        if ($exitClient) { $exitClient.Dispose() }
        $engineProcess.Dispose()
    }
}

$task = Get-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\'
}
if ($task -and $Unregister) {
    Unregister-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\' -Confirm:$false
}
