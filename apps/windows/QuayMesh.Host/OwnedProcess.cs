using System.Diagnostics;

namespace QuayMesh.Host;

public sealed class OwnedProcess : IDisposable
{
    public OwnedProcess(Process process, ProcessJob job)
    {
        Process = process;
        Job = job;
        Job.Add(process);
    }

    public Process Process { get; }
    public ProcessJob Job { get; }
    public int Pid => Process.Id;

    public async Task<int> WaitForExitAsync(CancellationToken cancellationToken)
    {
        await Process.WaitForExitAsync(cancellationToken);
        return Process.ExitCode;
    }

    public void Stop()
    {
        if (!Process.HasExited) Process.Kill(entireProcessTree: true);
    }

    public void Dispose()
    {
        Process.Dispose();
        Job.Dispose();
    }
}
