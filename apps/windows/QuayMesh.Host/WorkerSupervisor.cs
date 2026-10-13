using System.Diagnostics;
using System.Net.Http;
using QuayMesh.Shared;

namespace QuayMesh.Host;

public sealed class WorkerSupervisor : IDisposable
{
    private readonly HostConfig _config;
    private readonly RollingLog _log;
    private readonly HttpClient _http = new(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
    private readonly ProcessJob? _job;
    private readonly object _gate = new();
    private Process? _ownedProcess;
    private Task? _startTask;
    private DateTimeOffset _startedAt = DateTimeOffset.MinValue;
    private DateTimeOffset _nextStart = DateTimeOffset.MinValue;
    private int _crashes;
    private DateTimeOffset _windowStart = DateTimeOffset.Now;
    private int? _lastExit;
    private bool _stopping;

    public WorkerSupervisor(HostConfig config, RollingLog log, ProcessJob? job = null)
    {
        _config = config;
        _log = log;
        _job = job;
    }

    public int? LastExitCode => _lastExit;
    public string? LastExitAt { get; private set; }

    public async Task<(WorkerState State, int? Pid, string? ProcessName)> ProbeAsync(CancellationToken cancellationToken, bool allowStart = true)
    {
        if (!_config.Supervise || !_config.Worker.Enabled)
            return (WorkerState.ExternalManaged, null, null);

        Process? owned;
        Task? starting;
        lock (_gate)
        {
            owned = _ownedProcess;
            starting = _startTask;
        }

        if (starting is not null && !starting.IsCompleted)
            return (WorkerState.Starting, owned?.Id, owned?.ProcessName);

        var pid = TcpListenerLookup.ListeningPid(_config.Port);
        if (pid is null)
        {
            // 端口未被监听：若已启动的子进程仍在运行，在宽限期内报告 Starting，超期报告 Unhealthy，不杀不重复 spawn
            if (owned is { HasExited: false })
            {
                return (WithinGrace() ? WorkerState.Starting : WorkerState.Unhealthy, owned.Id, owned.ProcessName);
            }

            if (!allowStart)
                return (_crashes >= 5 ? WorkerState.Unhealthy : WorkerState.Stopped, null, null);

            StartWorker();
            return (_crashes >= 5 ? WorkerState.Unhealthy : WorkerState.Starting, null, null);
        }

        string? name = null;
        try
        {
            using var process = Process.GetProcessById(pid.Value);
            name = process.ProcessName;
        }
        catch { }

        var identity = ProcessIdentity.Compare(pid.Value, _config.Worker);
        if (identity == ProcessIdentity.MatchResult.Unknown)
        {
            _log.Write($"无法核对端口 {_config.Port} 占用进程 pid {pid} 的身份");
            return (WorkerState.UnknownIdentity, pid, name);
        }

        if (identity != ProcessIdentity.MatchResult.Match)
        {
            _log.Write($"端口 {_config.Port} 被外部未知进程占用 pid {pid} ({name})，不杀外部进程");
            return (WorkerState.PortConflict, pid, name);
        }

        if (owned is null || owned.HasExited || owned.Id != pid.Value)
        {
            // 匹配但不是本实例启动的进程：认定为外部已管理，不接管不杀
            return (WorkerState.ExternalManaged, pid, name);
        }

        var healthy = await GetOk($"http://127.0.0.1:{_config.Port}/healthz", cancellationToken);
        if (!healthy)
            return (WithinGrace() ? WorkerState.Starting : WorkerState.Unhealthy, pid, name);

        var ready = await GetOk($"http://127.0.0.1:{_config.Port}/readyz", cancellationToken);
        if (ready)
        {
            // 稳定健康后复位退避
            lock (_gate)
            {
                if (_crashes > 0)
                {
                    _crashes = 0;
                    _nextStart = DateTimeOffset.MinValue;
                }
            }
            return (WorkerState.Healthy, pid, name);
        }

        return (WithinGrace() ? WorkerState.Starting : WorkerState.Unhealthy, pid, name);
    }

    private void NoteExit(Process process)
    {
        lock (_gate)
        {
            if (!ReferenceEquals(_ownedProcess, process)) return;
            _lastExit = process.ExitCode;
            LastExitAt = DateTimeOffset.UtcNow.ToString("O");
            _ownedProcess = null;
            _startTask = null;

            if (DateTimeOffset.Now - _windowStart > TimeSpan.FromMinutes(10))
            {
                _windowStart = DateTimeOffset.Now;
                _crashes = 0;
            }

            _crashes++;
            var delay = _crashes switch { 1 => 1, 2 => 2, 3 => 5, 4 => 10, _ => 30 };
            _nextStart = DateTimeOffset.Now.AddSeconds(delay);
        }
        _log.Write($"工作进程已退出，退出码：{process.ExitCode}");
    }

    public void StartWorker()
    {
        lock (_gate)
        {
            if (_stopping || !_config.Supervise || !_config.Worker.Enabled || string.IsNullOrWhiteSpace(_config.Worker.Executable))
                return;

            // 仅允许一个 starting attempt
            if (_ownedProcess is { HasExited: false } || (_startTask is not null && !_startTask.IsCompleted))
                return;

            if (DateTimeOffset.Now - _windowStart > TimeSpan.FromMinutes(10)) { _windowStart = DateTimeOffset.Now; _crashes = 0; }
            if (_crashes >= 5 || DateTimeOffset.Now < _nextStart)
                return;

            _startTask = StartWorkerAsync();
        }
    }

    public void RestartOwnedWorker()
    {
        Process? process;
        lock (_gate) { process = _ownedProcess; }

        if (process is not null && !process.HasExited)
        {
            try
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
            catch (Exception error)
            {
                _log.Write($"工作进程停止失败：{error.Message}");
                return;
            }

            if (!process.HasExited)
            {
                _log.Write("工作进程未能在超时内退出");
                return;
            }
        }

        lock (_gate)
        {
            _ownedProcess = null;
            _crashes = 0;
            _nextStart = DateTimeOffset.MinValue;
        }

        StartWorker();
    }

    public void StopOwnedWorker()
    {
        lock (_gate) { _stopping = true; }
        Process? process;
        lock (_gate) { process = _ownedProcess; }
        if (process is not null && !process.HasExited)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception error)
            {
                _log.Write($"工作进程停止失败：{error.Message}");
            }
        }
    }

    public async Task StopOwnedWorkerAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        lock (_gate) { _stopping = true; }
        Process? process;
        lock (_gate) { process = _ownedProcess; }
        if (process is null || process.HasExited) return;

        try
        {
            if (await RuntimeControlClient.ShutdownAsync(process, _config.Worker, timeout, cancellationToken))
            {
                _log.Write("工作进程通过运行时控制管道正常关闭");
                return;
            }

            _log.Write("工作进程正常退出超时，强制终止所属进程树");
            process.Kill(entireProcessTree: true);
        }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException or OperationCanceledException)
        {
            _log.Write($"工作进程正常退出异常：{error.Message}");
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
    }

    private async Task StartWorkerAsync()
    {
        await Task.Yield();
        try
        {
            var info = new ProcessStartInfo(_config.Worker.Executable, _config.Worker.Arguments)
            {
                WorkingDirectory = string.IsNullOrWhiteSpace(_config.Worker.WorkingDirectory) ? Environment.CurrentDirectory : _config.Worker.WorkingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };

            foreach (var pair in _config.Worker.Environment)
            {
                info.Environment[pair.Key] = pair.Value;
            }

            Process process;
            lock (_gate)
            {
                if (_stopping) return;
                process = Process.Start(info) ?? throw new InvalidOperationException("工作进程启动失败，未返回进程句柄。");
                try
                {
                    _job?.Add(process);
                }
                catch
                {
                    process.Kill(entireProcessTree: true);
                    process.Dispose();
                    throw;
                }

                _ownedProcess = process;
                _startedAt = DateTimeOffset.Now;
                _nextStart = DateTimeOffset.MaxValue;
            }

            process.OutputDataReceived += (_, args) =>
            {
                if (args.Data is not null) _log.Write($"worker stdout: {args.Data}");
            };
            process.ErrorDataReceived += (_, args) =>
            {
                if (args.Data is not null) _log.Write($"worker stderr: {args.Data}");
            };
            process.Exited += (_, _) => NoteExit(process);
            process.EnableRaisingEvents = true;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (process.HasExited) NoteExit(process);

            _log.Write($"工作进程已启动 pid {process.Id}");
        }
        catch (Exception error)
        {
            _log.Write($"工作进程启动异常：{error.Message}");
            lock (_gate)
            {
                _startTask = null;
                _crashes++;
                var delay = _crashes switch { 1 => 1, 2 => 2, 3 => 5, 4 => 10, _ => 30 };
                _nextStart = DateTimeOffset.Now.AddSeconds(delay);
            }
        }
    }

    private bool WithinGrace() => DateTimeOffset.Now - _startedAt < TimeSpan.FromSeconds(45);

    private async Task<bool> GetOk(string url, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _http.GetAsync(url, cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        StopOwnedWorker();
        _http.Dispose();
    }
}
