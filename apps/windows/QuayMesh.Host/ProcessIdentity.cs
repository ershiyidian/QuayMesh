using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace QuayMesh.Host;

public static class ProcessIdentity
{
    public enum MatchResult { Match, Mismatch, Unknown }
    private const uint QueryLimitedInformation = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(nint process, int flags, StringBuilder path, ref int length);
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(nint process, int informationClass, nint buffer, int length, out int required);
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern nint CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern nint LocalFree(nint memory);

    public static MatchResult Compare(int pid, ProcessLaunch launch)
    {
        var executable = GetProcessExecutablePath(pid);
        if (executable is null || string.IsNullOrWhiteSpace(launch.Executable)) return MatchResult.Unknown;
        if (!string.Equals(Path.GetFullPath(executable), Path.GetFullPath(launch.Executable), StringComparison.OrdinalIgnoreCase)) return MatchResult.Mismatch;
        var command = CommandLine(pid);
        if (command is null) return MatchResult.Unknown;
        var actual = SplitArgs(command).Skip(1).ToArray();
        var expected = SplitArgs("process " + launch.Arguments).Skip(1).ToArray();
        if (actual.Length != expected.Length) return MatchResult.Mismatch;
        var working = string.IsNullOrWhiteSpace(launch.WorkingDirectory) ? AppContext.BaseDirectory : launch.WorkingDirectory;
        for (var index = 0; index < expected.Length; index++)
        {
            var pathArgument = Path.IsPathRooted(expected[index]) || expected[index].EndsWith(".js", StringComparison.OrdinalIgnoreCase) || expected[index].EndsWith(".mjs", StringComparison.OrdinalIgnoreCase);
            if (pathArgument)
            {
                if (!string.Equals(Path.GetFullPath(actual[index], working), Path.GetFullPath(expected[index], working), StringComparison.OrdinalIgnoreCase)) return MatchResult.Mismatch;
            }
            else if (!string.Equals(actual[index], expected[index], StringComparison.Ordinal)) return MatchResult.Mismatch;
        }
        return MatchResult.Match;
    }

    public static string? GetProcessExecutablePath(int pid)
    {
        var process = OpenProcess(QueryLimitedInformation, false, pid);
        if (process == nint.Zero) return null;
        try
        {
            var path = new StringBuilder(32768);
            var length = path.Capacity;
            return QueryFullProcessImageName(process, 0, path, ref length) ? path.ToString() : null;
        }
        finally { CloseHandle(process); }
    }

    public static string? CommandLine(int pid)
    {
        var process = OpenProcess(QueryLimitedInformation, false, pid);
        if (process == nint.Zero) return null;
        try
        {
            NtQueryInformationProcess(process, 60, nint.Zero, 0, out var size);
            if (size <= 0) return null;
            var memory = Marshal.AllocHGlobal(size);
            try
            {
                if (NtQueryInformationProcess(process, 60, memory, size, out _) != 0) return null;
                var length = (ushort)Marshal.ReadInt16(memory);
                var text = Marshal.ReadIntPtr(memory, nint.Size == 8 ? 8 : 4);
                return text == nint.Zero ? "" : Marshal.PtrToStringUni(text, length / 2);
            }
            finally { Marshal.FreeHGlobal(memory); }
        }
        finally { CloseHandle(process); }
    }

    public static string[] SplitArgs(string commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return [];
        var memory = CommandLineToArgvW(commandLine, out var count);
        if (memory == nint.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var args = new string[count];
            for (var index = 0; index < count; index++) args[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * nint.Size)) ?? "";
            return args;
        }
        finally { LocalFree(memory); }
    }

    public static bool IsExecutable(int pid, string expectedPath)
    {
        var executable = GetProcessExecutablePath(pid);
        return executable is not null && !string.IsNullOrWhiteSpace(expectedPath) && string.Equals(Path.GetFullPath(executable), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase);
    }

    public static DateTimeOffset GetStartTimeSafe(int pid)
    {
        try { using var process = Process.GetProcessById(pid); return new DateTimeOffset(process.StartTime); }
        catch (ArgumentException) { return DateTimeOffset.MinValue; }
        catch (InvalidOperationException) { return DateTimeOffset.MinValue; }
        catch (Win32Exception) { return DateTimeOffset.MinValue; }
    }
}
