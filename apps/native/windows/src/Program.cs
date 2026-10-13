using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace QuayMeshApp
{
    static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("shell32.dll", SetLastError = true)] private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

        [STAThread]
        static void Main(string[] args)
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { Run(args); }
            catch (Exception error)
            {
                ClientLog.Write(error.GetType().Name + ": " + error.Message);
                MessageBox.Show(error.Message, "QuayMesh 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
            }
        }

        static void Run(string[] args)
        {
            if (!args.Contains("--host")) { OpenHost(args.Contains("--exit")); return; }
            bool first;
            using (var mutex = new Mutex(true, @"Local\QuayMesh.Application", out first))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\QuayMesh.ShowWindow"))
            using (var toggle = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\QuayMesh.ToggleWindow"))
            using (var refresh = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\QuayMesh.RefreshWindow"))
            using (var exit = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\QuayMesh.ExitWindow"))
            {
                if (!first) { if (args.Contains("--exit")) exit.Set(); else if (!args.Contains("--background")) show.Set(); return; }
                if (args.Contains("--exit")) return;
                using (var form = new MainForm(AppConfig.Load(), true))
                {
                    var handle = form.Handle;
                    form.FormClosed += delegate { Application.ExitThread(); };
                    var registrations = new List<RegisteredWaitHandle>();
                    registrations.Add(Register(show, form, form.ShowAndFocus));
                    registrations.Add(Register(toggle, form, form.ToggleVisibility));
                    registrations.Add(Register(refresh, form, form.Reconnect));
                    registrations.Add(Register(exit, form, form.ExitApplication));
                    try
                    {
                        if (!args.Contains("--background")) form.ShowAndFocus();
                        Application.Run();
                    }
                    finally { foreach (var registration in registrations) registration.Unregister(null); }
                }
            }
        }

        static RegisteredWaitHandle Register(WaitHandle signal, MainForm form, Action action)
        {
            return ThreadPool.RegisterWaitForSingleObject(signal, delegate(object state, bool timedOut)
            {
                if (form.IsDisposed || !form.IsHandleCreated) return;
                try { form.BeginInvoke(action); }
                catch (InvalidOperationException) { if (!form.IsDisposed) throw; }
            }, null, Timeout.Infinite, false);
        }

        static void OpenHost(bool exit)
        {
            string executable = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "QuayMesh.Host.exe");
            if (!File.Exists(executable)) throw new FileNotFoundException("找不到 QuayMesh 托盘程序。", executable);
            Process.Start(new ProcessStartInfo(executable, exit ? "--exit" : "--supervise --open")
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(executable)
            });
        }
    }
}
