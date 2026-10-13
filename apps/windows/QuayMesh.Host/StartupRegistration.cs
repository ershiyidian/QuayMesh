using System.Diagnostics;
using System.Xml.Linq;
using Microsoft.Win32;

namespace QuayMesh.Host;

public static class StartupRegistration
{
    private const string TaskName = "\\QuayMesh";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public static void Install()
    {
        RunTaskCommand(false, "/Change", "/TN", TaskName, "/ENABLE");
        ClearLegacyStartup();
    }

    public static void Uninstall()
    {
        RunTaskCommand(false, "/Change", "/TN", TaskName, "/DISABLE");
        ClearLegacyStartup();
    }

    public static bool IsInstalled()
    {
        var query = RunTaskCommand(true, "/Query", "/TN", TaskName, "/XML");
        if (query.ExitCode != 0) return false;
        var document = XDocument.Parse(query.Output);
        var enabled = document.Descendants().FirstOrDefault(element =>
            element.Name.LocalName == "Enabled" && element.Parent?.Name.LocalName == "Settings");
        return enabled?.Value.Trim().ToLowerInvariant() != "false";
    }

    public static bool Toggle()
    {
        if (IsInstalled())
        {
            Uninstall();
            return false;
        }
        Install();
        return true;
    }

    private static void ClearLegacyStartup()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        key?.DeleteValue("QuayMeshHost", throwOnMissingValue: false);
        key?.DeleteValue("QuayMesh", throwOnMissingValue: false);
    }

    private static (int ExitCode, string Output) RunTaskCommand(bool allowMissing, params string[] args)
    {
        var start = new ProcessStartInfo("schtasks.exe")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var command = Process.Start(start) ?? throw new InvalidOperationException("无法启动 Windows 计划任务管理器");
        var output = command.StandardOutput.ReadToEnd();
        var error = command.StandardError.ReadToEnd();
        command.WaitForExit();
        if (command.ExitCode != 0 && !allowMissing)
            throw new InvalidOperationException($"QuayMesh 计划任务操作失败（{command.ExitCode}）：{error}");
        return (command.ExitCode, output);
    }
}
