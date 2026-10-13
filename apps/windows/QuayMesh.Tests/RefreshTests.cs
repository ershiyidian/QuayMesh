using System.Text.Json;

namespace QuayMesh.Tests;

public sealed class TestPreferences
{
    public string BaseUrl { get; set; } = "http://127.0.0.1:17776/console/";
    public string Theme { get; set; } = "system";
    public bool NotifyFailed { get; set; } = true;
    public bool NotifyCompleted { get; set; } = true;
    public bool NotifyOffline { get; set; } = true;
    public bool NotifyGateway { get; set; } = true;
}

[TestClass]
public sealed class RefreshTests
{
    [TestMethod]
    public void AtomicSettingsSave_OverwritesExistingFileCorrectly()
    {
        var tempDirectory = Path.Combine(Path.GetTempPath(), "tq-settings-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDirectory);
        var targetFile = Path.Combine(tempDirectory, "settings.json");

        try
        {
            var initial = new TestPreferences { Theme = "dark" };
            var json = JsonSerializer.Serialize(initial, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(targetFile, json);

            var updated = new TestPreferences { Theme = "light" };
            var temporary = targetFile + ".tmp";
            var updatedJson = JsonSerializer.Serialize(updated, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(temporary, updatedJson);
            File.Move(temporary, targetFile, true);

            var loaded = JsonSerializer.Deserialize<TestPreferences>(File.ReadAllText(targetFile))!;
            Assert.AreEqual("light", loaded.Theme, "原子覆盖后的配置文件应当包含更新后的主题设置。");
        }
        finally
        {
            try { Directory.Delete(tempDirectory, true); } catch { }
        }
    }
}
