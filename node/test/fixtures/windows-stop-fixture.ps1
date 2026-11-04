param(
    [string]$StopScript,
    [string]$EngineExecutable,
    [int]$EnginePid,
    [string]$Marker,
    [string]$Mode
)
$ErrorActionPreference = 'Stop'
$global:FixtureMode = $Mode
$global:FixtureMarker = $Marker
$global:FixtureEnginePid = $EnginePid
$global:FixtureExpectedImage = if ($Mode -eq 'engine-mismatch') { Join-Path $env:SystemRoot 'System32\cmd.exe' } else { $EngineExecutable }
$global:FixtureExitRequests = 0
$global:FixtureForceStops = 0
$global:FixtureUnregisters = 0
$global:FixtureTask = [pscustomobject]@{
    Xml = '<Task>fixture</Task>'
    Definition = [pscustomobject]@{ Actions = @([pscustomobject]@{ Type=0; Path=$global:FixtureExpectedImage }) }
}
$global:FixtureTask | Add-Member ScriptMethod GetInstances {
    param($flags)
    $requested = Test-Path -LiteralPath $global:FixtureMarker
    if ($requested -and $global:FixtureMode -eq 'host-stuck') { return @() }
    if ($requested -and $global:FixtureMode -eq 'success') {
        $elapsed = ([DateTime]::UtcNow - (Get-Item -LiteralPath $global:FixtureMarker).LastWriteTimeUtc).TotalMilliseconds
        if ($elapsed -ge 800) { return @() }
    }
    $guid = if ($requested -and $global:FixtureMode -eq 'replacement') { '{replacement}' } else { '{original}' }
    return [pscustomobject]@{ InstanceGuid=$guid; EnginePID=$global:FixtureEnginePid; CurrentAction=$global:FixtureExpectedImage }
}
$global:FixtureFolder = [pscustomobject]@{}
$global:FixtureFolder | Add-Member ScriptMethod GetTask {
    param($name)
    if ($name -cne 'QuayMesh') { throw 'Unexpected Task name' }
    if ($global:FixtureMode -eq 'definition-change' -and (Test-Path -LiteralPath $global:FixtureMarker)) {
        $global:FixtureTask.Xml = '<Task>replacement</Task>'
    }
    return $global:FixtureTask
}
$global:FixtureScheduler = [pscustomobject]@{}
$global:FixtureScheduler | Add-Member ScriptMethod Connect {}
$global:FixtureScheduler | Add-Member ScriptMethod GetFolder {
    param($path)
    if ($path -cne '\') { throw 'Unexpected Task folder' }
    return $global:FixtureFolder
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -cne 'Schedule.Service') { throw 'Unexpected COM boundary' }
    return $global:FixtureScheduler
}
function Get-ScheduledTask {
    param($TaskName, $TaskPath, $ErrorAction)
    if ($global:FixtureMode -ne 'explicit') { throw 'Graceful mode reached explicit Task stop' }
    return [pscustomobject]@{ State='Running' }
}
function Stop-ScheduledTask {
    param($TaskName, $TaskPath)
    $global:FixtureForceStops++
}
function Unregister-ScheduledTask {
    param($TaskName, $TaskPath, [switch]$Confirm)
    $global:FixtureUnregisters++
}
$failure = $null
$output = @()
try {
    if ($Mode -eq 'explicit') {
        $output = @(& $StopScript -Unregister)
    } else {
        $output = @(& $StopScript -HostExecutable $global:FixtureExpectedImage -TimeoutSeconds 2)
    }
}
catch { $failure = $_.Exception.Message }
if (Test-Path -LiteralPath $Marker) {
    $requests = @(Get-Content -LiteralPath $Marker)
    $global:FixtureExitRequests = $requests.Count
    if ($Mode -eq 'client-timeout') {
        $client = $null
        try {
            $client = [Diagnostics.Process]::GetProcessById([int]$requests[0])
            $null = $client.Handle
            if (-not $client.HasExited -and $client.MainModule.FileName -eq $EngineExecutable) {
                $client.Kill()
                $client.WaitForExit()
            }
        }
        catch [ArgumentException] {}
        finally { if ($client) { $client.Dispose() } }
    }
}
$engineAlive = $false
if ($EnginePid -gt 0) {
    try {
        $observed = [Diagnostics.Process]::GetProcessById($EnginePid)
        $engineAlive = -not $observed.HasExited
        $observed.Dispose()
    }
    catch [ArgumentException] {}
}
[pscustomobject]@{
    error=$failure
    output=$output
    exitRequests=$global:FixtureExitRequests
    forceStops=$global:FixtureForceStops
    unregisters=$global:FixtureUnregisters
    engineAlive=$engineAlive
} | ConvertTo-Json -Depth 4 -Compress
