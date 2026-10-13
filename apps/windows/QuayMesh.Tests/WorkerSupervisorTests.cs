using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using QuayMesh.Host;
using QuayMesh.Shared;

namespace QuayMesh.Tests;

[TestClass]
public sealed class WorkerSupervisorTests
{
    [TestMethod]
    public async Task ProbeAsync_ForeignPortListener_ReportsPortConflictWithoutKilling()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        var tempDirectory = Path.Combine(Path.GetTempPath(), "tq-supervisor-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        var logFile = Path.Combine(tempDirectory, "test.log");

        try
        {
            var config = new HostConfig
            {
                Port = port,
                Supervise = true,
                Worker = new ProcessLaunch
                {
                    Enabled = true,
                    Executable = "node.exe",
                    Arguments = "federation-cli.js serve"
                }
            };

            using var log = new RollingLog(logFile);
            using var supervisor = new WorkerSupervisor(config, log);

            var probeResult = await supervisor.ProbeAsync(CancellationToken.None, allowStart: false);

            Assert.AreEqual(WorkerState.PortConflict, probeResult.State, "非任务队列的监听端口应当判定为端口冲突。");
            Assert.AreEqual(Environment.ProcessId, probeResult.Pid, "占用端口的当前进程标识符应当正确报告。");
        }
        finally
        {
            listener.Stop();
            try { Directory.Delete(tempDirectory, true); } catch { }
        }
    }
}
