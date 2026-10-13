param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'QuayMesh' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName 'QuayMesh'
}
if ($task -and $Unregister) {
    Unregister-ScheduledTask -TaskName 'QuayMesh' -Confirm:$false
}
