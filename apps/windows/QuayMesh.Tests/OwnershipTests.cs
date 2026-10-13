using System.Diagnostics;
using QuayMesh.Host;

namespace QuayMesh.Tests;

[TestClass]
public sealed class OwnershipTests
{
    [TestMethod]
    public void ProcessJob_TerminatesOwnedProcess_LeavesUnrelatedProcessRunning()
    {
        var ownedStart = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 30 >nul")
        {
            CreateNoWindow = true,
            UseShellExecute = false
        };
        var unrelatedStart = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 30 >nul")
        {
            CreateNoWindow = true,
            UseShellExecute = false
        };

        var owned = Process.Start(ownedStart)!;
        var unrelated = Process.Start(unrelatedStart)!;

        try
        {
            using (var job = new ProcessJob())
            {
                job.Add(owned);

                Assert.IsFalse(owned.HasExited, "加入作业对象的子进程应当保持运行状态。");
                Assert.IsFalse(unrelated.HasExited, "独立的外部进程应当保持运行状态。");
            }

            var exited = owned.WaitForExit(4000);
            Assert.IsTrue(exited, "作业对象释放后，所属子进程必须被操作系统终止。");
            Assert.IsFalse(unrelated.HasExited, "未加入作业对象的外部进程不得被误终止。");
        }
        finally
        {
            try
            {
                if (!unrelated.HasExited)
                {
                    unrelated.Kill(entireProcessTree: true);
                }
                unrelated.Dispose();
            }
            catch
            {
            }

            try
            {
                if (!owned.HasExited)
                {
                    owned.Kill(entireProcessTree: true);
                }
                owned.Dispose();
            }
            catch
            {
            }
        }
    }

    [TestMethod]
    public void ProcessIdentity_RejectsMismatchedCommandLine()
    {
        var launch = new ProcessLaunch
        {
            Executable = "cmd.exe",
            Arguments = "/c echo test"
        };
        var currentPid = Environment.ProcessId;
        var result = ProcessIdentity.Compare(currentPid, launch);
        Assert.AreNotEqual(ProcessIdentity.MatchResult.Match, result, "当前测试进程不得误判定为匹配的工作进程配置。");
    }
}
