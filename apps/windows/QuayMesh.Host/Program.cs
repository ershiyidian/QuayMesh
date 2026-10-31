using System.Diagnostics;
using System.Text;
using System.IO.Pipes;
using System.Text.Json;
using System.Windows.Forms;
using QuayMesh.Shared;

namespace QuayMesh.Host;

internal static class Program
{
    private static Mutex? _singleInstance;
    private static CancellationTokenSource? _superviseCancel;
    private static Task? _superviseTask;

    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var command = args.FirstOrDefault(value => value is "--open" or "--status" or "--exit");

        // --status: 只查询现有管道，不创建新 worker/tunnel/Job 或产生托盘，未运行明确返回
        if (command == "--status")
        {
            var exitCode = SendCommand(PipeProtocol.GetStatus);
            Environment.Exit(exitCode);
            return;
        }

        // --exit: 向现有管道发送退出请求；未运行则直接退出
        if (command == "--exit")
        {
            SendCommand(PipeProtocol.ExitApplication);
            return;
        }

        // 互斥体检测单实例
        _singleInstance = new Mutex(true, "Local\\QuayMesh.Host", out var created);
        if (!created)
        {
            SendCommand(PipeProtocol.OpenUi);
            return;
        }

        var config = HostConfig.Load();
        if (args.Contains("--supervise")) config.Supervise = true;
        using var localUserApi = new LocalUserPipeServer();
        config.Worker.Environment["QUAYMESH_LOCAL_API_ENDPOINT"] = localUserApi.Endpoint;
        config.Worker.Environment["QUAYMESH_LOCAL_API_INTERNAL_PIPE"] = localUserApi.InternalEndpoint;
        config.Worker.Environment["QUAYMESH_LOCAL_API_BRIDGE_KEY"] = localUserApi.BridgeKey;

        var runtimeInstanceId = Guid.NewGuid().ToString("N");
        var runtimeStartedAt = DateTimeOffset.UtcNow.ToString("O");
        var runtimePipe = $"\\\\.\\pipe\\QuayMesh.Runtime.{runtimeInstanceId}";
        config.Worker.Environment["QUAYMESH_RUNTIME_CONTROL_PIPE"] = runtimePipe;
        config.Worker.Environment["QUAYMESH_RUNTIME_INSTANCE_ID"] = runtimeInstanceId;
        config.Worker.Environment["QUAYMESH_RUNTIME_STARTED_AT"] = runtimeStartedAt;

        Directory.CreateDirectory(HostConfig.LogDirectory);
        File.WriteAllText(
            Path.Combine(HostConfig.LogDirectory, "runtime-control.json"),
            JsonSerializer.Serialize(new { pipe = runtimePipe, instanceId = runtimeInstanceId, startedAt = runtimeStartedAt }));

        using var log = new RollingLog(Path.Combine(HostConfig.LogDirectory, "host.log"));
        var workerLog = new RollingLog(Path.Combine(HostConfig.LogDirectory, "worker.log"));
        using var job = new ProcessJob();
        var workers = new WorkerSupervisor(config, workerLog, job);
        var companions = new NodeComponentStatus(config, log, job);
        using var runtime = new RuntimeController(workers, log);
        var ui = new UiLauncher(config, log, job);
        HostPipeServer? pipe = null;

        var latestStatus = new HostStatus(
            config.Worker.Enabled ? WorkerState.Starting : WorkerState.Stopped,
            null,
            ServiceState.Starting,
            null,
            ServiceState.Starting,
            null,
            "node",
            null,
            null,
            !config.Supervise);

        HostStatus Snapshot() => latestStatus;

        var stopGate = new object();
        Task? stopTask = null;
        Task StopHostAsync()
        {
            lock (stopGate) return stopTask ??= StopHostCoreAsync();
        }

        async Task StopHostCoreAsync()
        {
            try
            {
                log.Write("开始停止 QuayMesh Host 及受管服务...");

                // 1. 先取消并等待监督循环退出
                _superviseCancel?.Cancel();
                if (_superviseTask is not null)
                {
                    try { await _superviseTask; } catch { }
                }

                // 2. 优雅关闭网页窗口
                ui.Close();

                // 3. 正常关闭运行时（RuntimeControlClient -> 超时强制关闭拥有进程树 -> 停止伴随服务）
                await runtime.ExitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);

                // 4. 停止命名管道服务
                pipe?.Stop();
                localUserApi.Stop();
                log.Write("QuayMesh Host 受管服务已全部停止");
            }
            catch (Exception error)
            {
                log.Write($"Host 停止异常：{error}");
            }
        }

        pipe = new HostPipeServer(
            Snapshot,
            () => workers.RestartOwnedWorker(),
            HostConfig.LogDirectory,
            config.ServerUrl,
            openUi: () => ui.Open(),
            reconnect: () => ui.Refresh(),
            exit: () =>
            {
                _ = Task.Run(async () =>
                {
                    await StopHostAsync();
                    try { Application.Exit(); } catch { }
                });
            },
            log: log.Write,
            toggleUi: () => ui.Toggle());

        pipe.Start();
        try { localUserApi.Start(); }
        catch
        {
            config.Worker.Environment.Remove("QUAYMESH_LOCAL_API_ENDPOINT");
            config.Worker.Environment.Remove("QUAYMESH_LOCAL_API_INTERNAL_PIPE");
            config.Worker.Environment.Remove("QUAYMESH_LOCAL_API_BRIDGE_KEY");
            log.Write("Local user API pipe is unavailable; existing worker supervision continues.");
        }
        log.Write(config.Supervise ? "host supervising" : "host observe-only");

        if (args.Contains("--install-startup"))
        {
            StartupRegistration.Install();
        }

        // 单一串行监督循环
        _superviseCancel = new CancellationTokenSource();
        var cancelToken = _superviseCancel.Token;

        _superviseTask = Task.Run(async () =>
        {
            while (!cancelToken.IsCancellationRequested)
            {
                try
                {
                    if (config.Supervise)
                    {
                            }

                    var worker = await workers.ProbeAsync(cancelToken, allowStart: config.Supervise);
                    var tunnel = companions.Discovery();
                    var easy = companions.Mesh();

                    var status = new HostStatus(
                        worker.State,
                        worker.Pid,
                        tunnel.State,
                        tunnel.Pid,
                        easy.State,
                        easy.Pid,
                        worker.ProcessName,
                        workers.LastExitCode,
                        workers.LastExitAt,
                        !config.Supervise);

                    latestStatus = status;

                    try
                    {
                        var json = JsonSerializer.Serialize(status, new JsonSerializerOptions { WriteIndented = true });
                        File.WriteAllText(Path.Combine(HostConfig.LogDirectory, "last-status.json"), json);
                    }
                    catch (Exception ex)
                    {
                        log.Write($"写入 last-status.json 异常: {ex.Message}");
                    }

                    await Task.Delay(10000, cancelToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception error)
                {
                    log.Write("监督循环异常: " + error.Message);
                    try { await Task.Delay(5000, cancelToken); } catch { break; }
                }
            }
        }, cancelToken);

        using var tray = new TrayMenu(
            Snapshot,
            openUi: () => ui.Open(),
            toggleUi: () => ui.Toggle(),
            reconnect: () => ui.Refresh(),
            restartWorker: () => workers.RestartOwnedWorker(),
            exitAsync: StopHostAsync,
            log: log.Write);

        if (!args.Contains("--background"))
        {
            WaitForLoopbackPort(new Uri(config.ServerUrl).Port, TimeSpan.FromSeconds(60), log);
            ui.Open();
        }

        Application.Run();

        // UI 线程消息循环退出后，确保后台完全停止
        try
        {
            StopHostAsync().GetAwaiter().GetResult();
        }
        catch { }

        pipe.Stop();
        workerLog.Dispose();
        try { _singleInstance.ReleaseMutex(); } catch { }
    }

    private static void WaitForLoopbackPort(int port, TimeSpan timeout, RollingLog log)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (TcpListenerLookup.IsLoopbackListening(port))
            {
                log.Write($"端口 {port} 已开始监听，打开窗口");
                return;
            }

            System.Threading.Thread.Sleep(250);
        }

        log.Write($"端口 {port} 在 {timeout.TotalSeconds:0} 秒内没有开始监听，仍然打开窗口");
    }

    private static int SendCommand(string operation)
    {
        NamedPipeClientStream? client = null;
        try
        {
            client = new NamedPipeClientStream(".", PipeProtocol.PipeName, PipeDirection.InOut);
            client.Connect(2000);
            // 服务端写完一行就会关掉管道。阅读器不要连带关掉管道，否则成功读到状态后，关闭动作会被误报成 Host 没在运行。
            using var writer = new StreamWriter(client, Encoding.UTF8, 1024, leaveOpen: true) { AutoFlush = true };
            using var reader = new StreamReader(client, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
            writer.WriteLine(JsonSerializer.Serialize(new { op = operation }));

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var readTask = reader.ReadLineAsync(cts.Token).AsTask();
            if (Task.WhenAny(readTask, Task.Delay(3000, cts.Token)).GetAwaiter().GetResult() != readTask)
            {
                Console.Error.WriteLine("读取管道响应超时。");
                return 1;
            }

            var response = readTask.GetAwaiter().GetResult();
            if (response is null)
            {
                Console.Error.WriteLine("管道没有返回内容。");
                return 1;
            }
            if (operation == PipeProtocol.GetStatus)
            {
                Console.WriteLine(response);
            }
            return 0;
        }
        catch (TimeoutException)
        {
            if (operation == PipeProtocol.GetStatus)
            {
                Console.Error.WriteLine("连接 QuayMesh Host 管道超时，服务可能未在运行。");
            }
            return 1;
        }
        catch (Exception error)
        {
            if (operation == PipeProtocol.GetStatus)
            {
                Console.Error.WriteLine($"QuayMesh Host 未在运行：{error.Message}");
            }
            return 1;
        }
        finally
        {
            try { client?.Dispose(); } catch (IOException) { }
        }
    }
}
