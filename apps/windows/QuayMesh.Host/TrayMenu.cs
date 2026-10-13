using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using QuayMesh.Shared;

namespace QuayMesh.Host;

public sealed class TrayMenu : IDisposable
{
    private readonly NotifyIcon _tray;
    private readonly ContextMenuStrip _menu;
    private readonly ToolStripMenuItem _itemToggleConsole;
    private readonly ToolStripMenuItem _itemReconnect;
    private readonly ToolStripMenuItem _itemStatus;
    private readonly ToolStripMenuItem _itemRestartWorker;
    private readonly ToolStripMenuItem _itemLogs;
    private readonly ToolStripMenuItem _itemStartup;
    private readonly ToolStripMenuItem _itemAbout;
    private readonly ToolStripMenuItem _itemExit;

    private readonly Func<HostStatus> _getStatus;
    private readonly Action _openUi;
    private readonly Action _toggleUi;
    private readonly Action _reconnect;
    private readonly Action _restartWorker;
    private readonly Func<Task> _exitAsync;
    private readonly Action<string> _log;
    private bool _isExiting;

    public TrayMenu(
        Func<HostStatus> getStatus,
        Action openUi,
        Action toggleUi,
        Action reconnect,
        Action restartWorker,
        Func<Task> exitAsync,
        Action<string> log)
    {
        _getStatus = getStatus;
        _openUi = openUi;
        _toggleUi = toggleUi;
        _reconnect = reconnect;
        _restartWorker = restartWorker;
        _exitAsync = exitAsync;
        _log = log;

        _menu = new ContextMenuStrip();
        _itemToggleConsole = new ToolStripMenuItem("显示或隐藏窗口", null, (_, _) => SafeAction(_toggleUi));
        _itemReconnect = new ToolStripMenuItem("重新连接控制台", null, (_, _) => SafeAction(_reconnect));
        _itemStatus = new ToolStripMenuItem("本机状态", null, (_, _) => ShowStatus());
        _itemRestartWorker = new ToolStripMenuItem("重新启动本机服务", null, (_, _) => ConfirmAndRestartWorker());
        _itemLogs = new ToolStripMenuItem("打开日志", null, (_, _) => OpenLogs());
        _itemStartup = new ToolStripMenuItem("开机启动", null, (_, _) => ToggleStartup())
        {
            CheckOnClick = false,
            Checked = StartupRegistration.IsInstalled()
        };
        _itemAbout = new ToolStripMenuItem("关于 QuayMesh", null, (_, _) => MessageBox.Show("QuayMesh Host 统一管理服务", "关于 QuayMesh", MessageBoxButtons.OK, MessageBoxIcon.Information));
        _itemExit = new ToolStripMenuItem("退出 QuayMesh", null, (_, _) => TriggerExit());

        _menu.Items.AddRange(new ToolStripItem[]
        {
            _itemToggleConsole,
            _itemReconnect,
            _itemStatus,
            _itemRestartWorker,
            new ToolStripSeparator(),
            _itemLogs,
            _itemStartup,
            _itemAbout,
            new ToolStripSeparator(),
            _itemExit
        });

        _menu.Opening += (_, _) =>
        {
            if (_isExiting) return;
            try
            {
                _itemStartup.Checked = StartupRegistration.IsInstalled();
            }
            catch { }
            SetMenuEnabled(true);
        };

        _tray = new NotifyIcon
        {
            Visible = true,
            Text = "QuayMesh Host",
            Icon = LoadIcon(),
            ContextMenuStrip = _menu,
        };

        _tray.MouseClick += (_, eventArgs) =>
        {
            if (eventArgs.Button == MouseButtons.Left)
            {
                SafeAction(_openUi);
            }
        };

        _tray.DoubleClick += (_, _) => SafeAction(_openUi);
    }

    private void SafeAction(Action action)
    {
        if (_isExiting) return;
        Task.Run(() =>
        {
            try
            {
                action();
            }
            catch (Exception error)
            {
                _log($"托盘操作执行异常：{error.Message}");
            }
        });
    }

    private void ShowStatus()
    {
        if (_isExiting) return;
        Task.Run(() =>
        {
            try
            {
                var status = _getStatus();
                var message = $"工作服务：{status.WorkerState} (PID: {status.WorkerPid ?? 0})\n" +
                              $"加密隧道：{status.TunnelState} (PID: {status.TunnelPid ?? 0})\n" +
                              $"虚拟网络：{status.EasyTierState} (PID: {status.EasyTierPid ?? 0})";
                _log($"本机状态报告：{message.Replace('\n', ' ')}");
                MessageBox.Show(message, "本机状态", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                _log($"获取本机状态失败：{error.Message}");
            }
        });
    }

    private void ConfirmAndRestartWorker()
    {
        if (_isExiting) return;
        var confirm = MessageBox.Show(
            "重新启动会中断本机正在执行的任务。远端服务器任务保持运行。确定继续吗？",
            "重启服务确认",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);
        if (confirm == DialogResult.Yes)
        {
            SafeAction(_restartWorker);
        }
    }

    private void ToggleStartup()
    {
        try
        {
            var newState = StartupRegistration.Toggle();
            _itemStartup.Checked = newState;
            _log(newState ? "已开启开机启动" : "已关闭开机启动");
        }
        catch (Exception error)
        {
            _log($"修改开机启动异常：{error.Message}");
        }
    }

    private void OpenLogs()
    {
        Task.Run(() =>
        {
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", HostConfig.LogDirectory) { UseShellExecute = true });
            }
            catch (Exception error)
            {
                _log($"打开日志目录失败：{error.Message}");
            }
        });
    }

    private void TriggerExit()
    {
        if (_isExiting) return;

        var confirm = MessageBox.Show(
            "退出会停止 QuayMesh 管理的本机服务和本机任务。远端服务器任务保持运行。确定退出吗？",
            "退出 QuayMesh",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Question);
        if (confirm != DialogResult.OK) return;

        _isExiting = true;
        SetMenuEnabled(false);

        // UI 线程立即隐藏并销毁 NotifyIcon，防止遗留灰色幽灵图标
        try
        {
            _tray.Visible = false;
            _tray.Dispose();
        }
        catch { }

        Task.Run(async () =>
        {
            try
            {
                await _exitAsync();
            }
            catch (Exception error)
            {
                _log($"退出执行异常：{error.Message}");
            }
            finally
            {
                try { Application.Exit(); } catch { }
            }
        });
    }

    private void SetMenuEnabled(bool enabled)
    {
        foreach (ToolStripItem item in _menu.Items)
        {
            item.Enabled = enabled;
        }
    }

    private static Icon LoadIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "app.ico");
        if (File.Exists(path)) return new Icon(path);
        return Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? SystemIcons.Application;
    }

    public void Dispose()
    {
        try { _tray.Visible = false; } catch { }
        try { _tray.Dispose(); } catch { }
        try { _menu.Dispose(); } catch { }
    }
}
