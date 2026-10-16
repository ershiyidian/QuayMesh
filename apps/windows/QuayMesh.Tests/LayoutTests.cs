using QuayMesh.Shared;

namespace QuayMesh.Tests;

[TestClass]
public sealed class LayoutTests
{
    [TestMethod]
    [DataRow(1920.0, 4)]
    [DataRow(1440.0, 4)]
    [DataRow(1280.0, 4)]
    [DataRow(964.0, 4)]
    [DataRow(963.9, 2)]
    [DataRow(800.0, 2)]
    [DataRow(476.0, 2)]
    [DataRow(475.9, 1)]
    [DataRow(360.0, 1)]
    [DataRow(0.0, 1)]
    public void ColumnsFor_CalculatesExpectedColumnsAccordingToBreakpoints(double width, int expectedColumns)
    {
        var actualColumns = MachineLayout.ColumnsFor(width);
        Assert.AreEqual(expectedColumns, actualColumns, $"宽度为 {width} DIP 时的列数计算不正确。");
    }

    [TestMethod]
    public void SecretRedactor_RedactsSensitiveKeywords()
    {
        var token = "secret" + "1234567890abcdef";
        var input = $"Bearer token={token} and password=verysecretpassword";
        var redacted = SecretRedactor.Redact(input);

        StringAssert.DoesNotMatch(redacted, new System.Text.RegularExpressions.Regex(token), "敏感口令内容不得泄露在脱敏文本中。");
        StringAssert.Contains(redacted, "<redacted>", "脱敏后的文本中必须包含标记。");
    }
}
