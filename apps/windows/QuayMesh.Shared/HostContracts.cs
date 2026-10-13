namespace QuayMesh.Shared;

public enum WorkerState
{
    Stopped,
    Starting,
    Healthy,
    Unhealthy,
    PortConflict,
    ExternalManaged,
    UnknownIdentity,
}

public enum ServiceState
{
    Stopped,
    Starting,
    Healthy,
    Unhealthy,
    ExternalManaged,
    UnknownIdentity,
}

public sealed record HostStatus(
    WorkerState WorkerState,
    int? WorkerPid,
    ServiceState TunnelState,
    int? TunnelPid,
    ServiceState EasyTierState,
    int? EasyTierPid,
    string? ListenerProcess,
    int? LastExitCode,
    string? LastExitAt,
    bool ObserveOnly);

public static class MachineLayout
{
    public const double WideBreakpoint = 964;
    public const double MediumBreakpoint = 476;

    public static int ColumnsFor(double width) => width >= WideBreakpoint ? 4 : width >= MediumBreakpoint ? 2 : 1;
}

public static class PipeProtocol
{
    public const string PipeName = "QuayMesh.Host";
    public const string GetStatus = "GET_STATUS";
    public const string OpenUi = "OPEN_UI";
    public const string ToggleUi = "TOGGLE_UI";
    public const string OpenLogFolder = "OPEN_LOG_FOLDER";
    public const string RestartWorker = "RESTART_WORKER";
    public const string OpenPortal = "OPEN_PORTAL";
    public const string ReconnectConsole = "RECONNECT_CONSOLE";
    public const string ExitApplication = "EXIT_APPLICATION";
}

public static class SecretRedactor
{
    private static readonly string[] Markers = ["password", "token", "secret", "authorization", "cookie", "credential"];

    public static string Redact(string? value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        var text = value;
        foreach (var marker in Markers)
        {
            var index = 0;
            while ((index = text.IndexOf(marker, index, StringComparison.OrdinalIgnoreCase)) >= 0)
            {
                var end = Math.Min(text.Length, index + marker.Length + 80);
                text = text[..index] + marker + "=<redacted>" + text[end..];
                index += marker.Length + 11;
            }
        }
        return text;
    }
}
