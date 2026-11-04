using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

public class WindowsStopHost
{
    public static int Main(string[] args)
    {
        string marker = Environment.GetEnvironmentVariable("QUAYMESH_STOP_FIXTURE_MARKER");
        string mode = Environment.GetEnvironmentVariable("QUAYMESH_STOP_FIXTURE_MODE");
        if (args.Length == 1 && args[0] == "--exit")
        {
            File.AppendAllText(marker, Process.GetCurrentProcess().Id + Environment.NewLine);
            if (mode == "client-failure") return 7;
            if (mode == "client-timeout") Thread.Sleep(5000);
            return 0;
        }
        Console.WriteLine("ready");
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            if (mode != "host-stuck" && mode != "client-failure" && mode != "client-timeout" && File.Exists(marker))
            {
                Thread.Sleep(250);
                return 0;
            }
            Thread.Sleep(20);
        }
        return 91;
    }
}
