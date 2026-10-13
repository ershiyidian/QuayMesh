using System.IO.Pipes;
using System.Text.Json;
using QuayMesh.Host;
using QuayMesh.Shared;

namespace QuayMesh.Tests;

[TestClass]
public sealed class PipeTests
{
    [TestMethod]
    public async Task NamedPipe_HandlesGetStatusAndRejectsUnknownOperation()
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), "tq-pipe-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        var pipeName = "QuayMesh.Tests." + Guid.NewGuid().ToString("N");

        var dummyStatus = new HostStatus(
            WorkerState: WorkerState.Healthy,
            WorkerPid: 1234,
            TunnelState: ServiceState.Healthy,
            TunnelPid: 5678,
            EasyTierState: ServiceState.Healthy,
            EasyTierPid: 9012,
            ListenerProcess: "node",
            LastExitCode: 0,
            LastExitAt: null,
            ObserveOnly: false);

        var server = new HostPipeServer(
            status: () => dummyStatus,
            restart: () => { },
            logDirectory: tempDirectory,
            portalUrl: "http://127.0.0.1:17776/console/",
            pipeName: pipeName);

        server.Start();
        await Task.Delay(200);

        try
        {
            // 测试获取状态
            using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
            {
                await client.ConnectAsync(2000);
                var writer = new StreamWriter(client, leaveOpen: true) { AutoFlush = true };
                var reader = new StreamReader(client, leaveOpen: true);

                await writer.WriteLineAsync(JsonSerializer.Serialize(new { op = PipeProtocol.GetStatus }));
                var responseJson = await reader.ReadLineAsync();
                Assert.IsNotNull(responseJson, "管道服务端应当返回响应。");

                using var doc = JsonDocument.Parse(responseJson);
                Assert.AreEqual((int)WorkerState.Healthy, doc.RootElement.GetProperty("WorkerState").GetInt32());
            }

            // 测试未知操作
            using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
            {
                await client.ConnectAsync(2000);
                var writer = new StreamWriter(client, leaveOpen: true) { AutoFlush = true };
                var reader = new StreamReader(client, leaveOpen: true);

                await writer.WriteLineAsync(JsonSerializer.Serialize(new { op = "UNKNOWN_OP" }));
                var responseJson = await reader.ReadLineAsync();
                Assert.IsNotNull(responseJson, "管道服务端应当返回错误响应。");

                using var doc = JsonDocument.Parse(responseJson);
                Assert.IsFalse(doc.RootElement.GetProperty("ok").GetBoolean(), "未知操作应当返回失败状态。");
            }
        }
        finally
        {
            server.Stop();
            try { Directory.Delete(tempDirectory, true); } catch { }
        }
    }
}
