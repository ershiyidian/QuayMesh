using QuayMesh.Shared;

namespace QuayMesh.Host;

public enum RuntimeState
{
    Starting,
    Running,
    Degraded,
    Stopping,
    Stopped,
}

public sealed class RuntimeController : IDisposable
{
    private readonly WorkerSupervisor _worker;
    private readonly RollingLog _log;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private CancellationTokenSource _cancel = new();
    private RuntimeState _state = RuntimeState.Stopped;

    public RuntimeController(WorkerSupervisor worker, RollingLog log)
    {
        _worker = worker;
        _log = log;
    }

    public RuntimeState State => _state;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_state is RuntimeState.Running or RuntimeState.Starting) return;
            _state = RuntimeState.Starting;
            _worker.StartWorker();
            _state = RuntimeState.Running;
        }
        finally { _gate.Release(); }
    }

    public async Task<HostStatus> ProbeAsync(Func<Task<HostStatus>> probe, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_state is RuntimeState.Stopping or RuntimeState.Stopped) return await probe();
            var status = await probe();
            _state = status.WorkerState is WorkerState.Healthy or WorkerState.ExternalManaged ? RuntimeState.Running : RuntimeState.Degraded;
            return status;
        }
        finally { _gate.Release(); }
    }

    public async Task ExitAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            _state = RuntimeState.Stopping;
            _cancel.Cancel();
            await _worker.StopOwnedWorkerAsync(timeout, cancellationToken);
            _state = RuntimeState.Stopped;
            _log.Write("runtime stopped");
        }
        finally { _gate.Release(); }
    }

    public void Dispose()
    {
        _cancel.Cancel();
        _worker.Dispose();
        _gate.Dispose();
        _cancel.Dispose();
    }
}
