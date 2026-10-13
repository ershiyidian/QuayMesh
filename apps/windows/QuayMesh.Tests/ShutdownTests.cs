using QuayMesh.Host;

namespace QuayMesh.Tests;

[TestClass]
public sealed class ShutdownTests
{
    [TestMethod]
    public async Task ExitAsync_TransitionsStateToStopped()
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), "tq-shutdown-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        var logFile = Path.Combine(tempDirectory, "test.log");

        try
        {
            var config = new HostConfig
            {
                Supervise = true,
                Worker = new ProcessLaunch { Enabled = false }
            };

            using var log = new RollingLog(logFile);
            using var supervisor = new WorkerSupervisor(config, log);
            using var runtime = new RuntimeController(supervisor, log);

            await runtime.StartAsync(CancellationToken.None);
            Assert.AreEqual(RuntimeState.Running, runtime.State, "启动后运行状态应当为 Running。");

            await runtime.ExitAsync(TimeSpan.FromSeconds(3), CancellationToken.None);
            Assert.AreEqual(RuntimeState.Stopped, runtime.State, "退出后运行状态必须变为 Stopped。");
        }
        finally
        {
            try { Directory.Delete(tempDirectory, true); } catch { }
        }
    }
}
