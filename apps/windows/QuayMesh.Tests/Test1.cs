using QuayMesh.Host;

namespace QuayMesh.Tests;

[TestClass]
public sealed class UiLauncherAndEventTests
{
    [TestMethod]
    [DataRow("ShowWindow")]
    [DataRow("ToggleWindow")]
    [DataRow("RefreshWindow")]
    [DataRow("ExitWindow")]
    public void CommandsSignalTheirOwnNamedEvent(string command)
    {
        var eventPrefix = @"Local\QuayMesh.Tests." + Guid.NewGuid().ToString("N");
        using var signal = new EventWaitHandle(false, EventResetMode.AutoReset, eventPrefix + "." + command);
        var directory = Path.Combine(Path.GetTempPath(), "tq-ui-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            using var log = new RollingLog(Path.Combine(directory, "test.log"));
            var launcher = new UiLauncher(new HostConfig(), log, eventPrefix: eventPrefix);
            switch (command)
            {
                case "ShowWindow": launcher.Open(); break;
                case "ToggleWindow": launcher.Toggle(); break;
                case "RefreshWindow": launcher.Refresh(); break;
                case "ExitWindow": launcher.Close(); break;
                default: throw new ArgumentOutOfRangeException(nameof(command));
            }
            Assert.IsTrue(signal.WaitOne(1000), "命令应到达本次测试创建的真实命名事件。");
        }
        finally { Directory.Delete(directory, true); }
    }

    [TestMethod]
    public void ProcessIdentity_SplitArgs_ParsesCommandLineCorrectly()
    {
        var tokens = ProcessIdentity.SplitArgs("node.exe \"C:\\Program Files\\App\\script.js\" --port 7676 --flag");
        CollectionAssert.AreEqual(new[] { "node.exe", @"C:\Program Files\App\script.js", "--port", "7676", "--flag" }, tokens);
    }
}
