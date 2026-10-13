using System.Text.Json;
using QuayMesh.Host;
using QuayMesh.Shared;

namespace QuayMesh.Tests;

[TestClass]
public sealed class CompanionTests
{
    [TestMethod]
    public void StoppedComponents_ReturnStoppedState()
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), "tq-companion-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        var logFile = Path.Combine(tempDirectory, "test.log");

        try
        {
            File.WriteAllText(Path.Combine(tempDirectory, "node-status.json"), JsonSerializer.Serialize(new
            {
                components = new[]
                {
                    new { id = "mesh", state = "stopped", pid = (int?)null },
                    new { id = "discovery", state = "stopped", pid = (int?)null }
                }
            }));
            using var log = new RollingLog(logFile);
            var companions = new NodeComponentStatus(new HostConfig { StateDirectory = tempDirectory }, log);

            var easyTierStatus = companions.Mesh();
            var tunnelStatus = companions.Discovery();

            Assert.AreEqual(ServiceState.Stopped, easyTierStatus.State, "未启用的伴随服务应当处于停止状态。");
            Assert.AreEqual(ServiceState.Stopped, tunnelStatus.State, "未启用的隧道服务应当处于停止状态。");
        }
        finally
        {
            try { Directory.Delete(tempDirectory, true); } catch { }
        }
    }
}
