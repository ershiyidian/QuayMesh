using System.Text.Json;
using QuayMesh.Host;
using QuayMesh.Shared;

namespace QuayMesh.Tests;

[TestClass]
public sealed class NodeComponentStatusTests
{
    [TestMethod]
    public void StoppedAndStartingComponentsAcceptNullPid()
    {
        var directory=Path.Combine(Path.GetTempPath(),"qm-component-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            File.WriteAllText(Path.Combine(directory,"node-status.json"),JsonSerializer.Serialize(new
            {
                components=new object[]
                {
                    new { id="mesh", state="backoff", pid=(int?)null },
                    new { id="discovery", state="waiting", pid=(int?)null },
                }
            }));
            using var log=new RollingLog(Path.Combine(directory,"component.log"));
            var status=new NodeComponentStatus(new HostConfig { StateDirectory=directory },log);
            Assert.AreEqual(ServiceState.Unhealthy,status.Mesh().State);
            Assert.IsNull(status.Mesh().Pid);
            Assert.AreEqual(ServiceState.Starting,status.Discovery().State);
            Assert.IsNull(status.Discovery().Pid);

            File.WriteAllText(Path.Combine(directory,"node-status.json"),JsonSerializer.Serialize(new
            {
                components=new[] {new { id="mesh",state="ready",pid=(int?)12345 } }
            }));
            Assert.AreEqual(ServiceState.Healthy,status.Mesh().State);
            Assert.AreEqual(12345,status.Mesh().Pid);

            File.WriteAllText(Path.Combine(directory,"node-status.json"),JsonSerializer.Serialize(new
            {
                components=new[] {new { id="mesh",state="degraded",pid=(int?)12345,observedAt=(long?)null } }
            }));
            Assert.AreEqual(ServiceState.Unhealthy,status.Mesh().State);
            Assert.AreEqual(12345,status.Mesh().Pid);
            File.SetLastWriteTimeUtc(Path.Combine(directory,"node-status.json"),DateTime.UtcNow.AddMinutes(-1));
            Assert.AreEqual(ServiceState.UnknownIdentity,status.Mesh().State);
            Assert.AreEqual(12345,status.Mesh().Pid);

            File.WriteAllText(Path.Combine(directory,"node-status.json"),JsonSerializer.Serialize(new
            {
                components=new[] {new { id="mesh",state="ready",pid=(int?)12345,observedAt=DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds() } }
            }));
            Assert.AreEqual(ServiceState.UnknownIdentity,status.Mesh().State);
        }
        finally
        {
            Directory.Delete(directory,true);
        }
    }
}
