namespace QuayMesh.Tests;

[TestClass]
public sealed class SingleInstanceTests
{
    private const string TestMutexName = "Local\\QuayMesh.TestMutex." + nameof(SingleInstanceTests);

    [TestMethod]
    public void Mutex_CorrectlyDetectsExistingInstance()
    {
        using var first = new Mutex(true, TestMutexName, out var createdNew);
        Assert.IsTrue(createdNew, "首次创建互斥体应当成功。");

        var detected = Mutex.TryOpenExisting(TestMutexName, out var second);
        Assert.IsTrue(detected, "应当能够检测到已存在的互斥体。");
        second?.Dispose();
    }
}
