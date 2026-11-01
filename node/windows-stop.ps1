param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\'
}
if ($task -and $Unregister) {
    Unregister-ScheduledTask -TaskName 'QuayMesh' -TaskPath '\' -Confirm:$false
}
