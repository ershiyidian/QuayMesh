using System.Diagnostics;
using System.Runtime.InteropServices;

namespace QuayMesh.Host;

public sealed class UiLauncher
{
    public const string EventShowWindow = @"Local\QuayMesh.ShowWindow";
    public const string EventToggleWindow = @"Local\QuayMesh.ToggleWindow";
    public const string EventRefreshWindow = @"Local\QuayMesh.RefreshWindow";
    public const string EventExitWindow = @"Local\QuayMesh.ExitWindow";

    private readonly HostConfig _config;
    private readonly RollingLog _log;
    private readonly ProcessJob? _job;
    private readonly object _launchGate = new();
    private Process? _process;
    private bool _stopping;
    private readonly string _eventPrefix;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(nint handle);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(nint handle, int command);

    public UiLauncher(HostConfig config, RollingLog log, ProcessJob? job = null, string eventPrefix = @"Local\QuayMesh")
    {
        _config = config;
        _log = log;
        _job = job;
        _eventPrefix = eventPrefix;
    }

    public void Open()
    {
        lock (_launchGate) { if (_stopping) return; }
        try
        {
            if (EventWaitHandle.TryOpenExisting(_eventPrefix + ".ShowWindow", out var showEvent))
            {
                using (showEvent)
                {
                    showEvent.Set();
                    _log.Write("已通过命名事件激活客户端窗口 (ShowWindow)");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            _log.Write($"激活客户端窗口事件异常：{ex.Message}");
        }

        lock (_launchGate)
        {
            if (_stopping) return;
            if (_process is not null && !_process.HasExited)
            {
                try
                {
                    var h = _process.MainWindowHandle;
                    if (h != nint.Zero)
                    {
                        ShowWindow(h, 9);
                        SetForegroundWindow(h);
                        _log.Write($"已激活运行中客户端窗口 pid {_process.Id}");
                        return;
                    }
                }
                catch { }
                return;
            }

            var executable = ResolveUiExecutable();
            if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
            {
                _log.Write("桌面客户端程序未配置或不存在：" + executable);
                return;
            }

            // 检查当前用户会话中是否已有同路径实例
            try
            {
                var fullExecutable = Path.GetFullPath(executable);
                var processName = Path.GetFileNameWithoutExtension(executable);
                var currentSessionId = Process.GetCurrentProcess().SessionId;
                foreach (var existing in Process.GetProcessesByName(processName))
                {
                    try
                    {
                        if (existing.SessionId == currentSessionId &&
                            string.Equals(ProcessIdentity.GetProcessExecutablePath(existing.Id), fullExecutable, StringComparison.OrdinalIgnoreCase))
                        {
                            var h = existing.MainWindowHandle;
                            _process = existing;
                            if (h != nint.Zero)
                            {
                                ShowWindow(h, 9);
                                SetForegroundWindow(h);
                                _log.Write($"已认领并激活已有运行中客户端窗口 pid {existing.Id}");
                                return;
                            }
                            return;
                        }
                    }
                    catch { }
                    finally
                    {
                        if (!ReferenceEquals(_process, existing))
                        {
                            existing.Dispose();
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _log.Write($"检测已有客户端实例警告：{ex.Message}");
            }

            // 无运行实例才启动新实例
            try
            {
                var launchArgs = string.IsNullOrWhiteSpace(_config.UiArguments) ? "--host" : $"{_config.UiArguments} --host";
                var startInfo = new ProcessStartInfo(executable, launchArgs)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory
                };
                var launched = Process.Start(startInfo);
                if (launched is null)
                {
                    _log.Write($"启动客户端未返回进程：{executable}");
                    return;
                }

                try
                {
                    _job?.Add(launched);
                }
                catch (Exception error)
                {
                    _log.Write($"客户端 Job 归属警告：{error.Message}");
                }

                _process = launched;
                _log.Write($"已启动桌面客户端 pid {launched.Id} ({executable})");
            }
            catch (Exception error)
            {
                _log.Write($"桌面客户端启动失败 ({executable}): {error.Message}");
            }
        }
    }

    public void Toggle()
    {
        try
        {
            if (EventWaitHandle.TryOpenExisting(_eventPrefix + ".ToggleWindow", out var toggleEvent))
            {
                using (toggleEvent)
                {
                    toggleEvent.Set();
                    _log.Write("已通过命名事件切换客户端窗口 (ToggleWindow)");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            _log.Write($"切换客户端窗口事件异常：{ex.Message}");
        }

        Open();
    }

    public void Refresh()
    {
        try
        {
            if (EventWaitHandle.TryOpenExisting(_eventPrefix + ".RefreshWindow", out var refreshEvent))
            {
                using (refreshEvent)
                {
                    refreshEvent.Set();
                    _log.Write("已通过命名事件刷新客户端页面 (RefreshWindow)");
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            _log.Write($"刷新客户端页面事件异常：{ex.Message}");
        }

        _log.Write("网页壳未注册 RefreshWindow 事件，无法远程重连页面");
    }

    public void Close()
    {
        try
        {
            if (EventWaitHandle.TryOpenExisting(_eventPrefix + ".ExitWindow", out var exitEvent))
            {
                using (exitEvent)
                {
                    exitEvent.Set();
                    _log.Write("已发送优雅退出事件至客户端窗口 (ExitWindow)");
                }
            }
        }
        catch (Exception ex)
        {
            _log.Write($"发送退出窗口事件异常：{ex.Message}");
        }

        Process? process;
        lock (_launchGate)
        {
            _stopping = true;
            process = _process;
            _process = null;
        }

        if (process is null) return;

        try
        {
            if (!process.HasExited)
            {
                if (!process.WaitForExit(3000) && !process.HasExited)
                {
                    _log.Write($"客户端窗口未在超时内退出，终止所属进程树 pid {process.Id}");
                    process.Kill(entireProcessTree: true);
                }
            }
        }
        catch (Exception error)
        {
            _log.Write($"桌面客户端停止异常：{error.Message}");
        }
        finally
        {
            try { process.Dispose(); } catch { }
        }
    }

    private string ResolveUiExecutable()
    {
        var executable = HostConfig.Load().UiExecutable;
        if (string.IsNullOrWhiteSpace(executable)) executable = _config.UiExecutable;
        if (string.IsNullOrWhiteSpace(executable))
        {
            var candidate = Path.Combine(AppContext.BaseDirectory, "QuayMesh.exe");
            if (File.Exists(candidate)) executable = candidate;
        }
        return executable;
    }
}
