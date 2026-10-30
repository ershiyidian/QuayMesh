using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace QuayMeshApp
{
    public class MainForm : Form
    {
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        private AppConfig config;
        private readonly Panel surface = new Panel { Dock = DockStyle.Fill };
        private readonly ToolStripLabel status = new ToolStripLabel("正在连接控制台");
        private ToolStrip toolbar;
        private readonly BrowserSessionStore sessions = new BrowserSessionStore();
        private bool lightTheme;
        private Task savingSession;
        private readonly Label notice = new Label { Dock = DockStyle.Top, AutoSize = false, Height = 44, Visible = false, Padding = new Padding(12), BackColor = Color.FromArgb(68, 49, 22), ForeColor = Color.White };
        private readonly System.Windows.Forms.Timer retry = new System.Windows.Forms.Timer();
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly HttpClient http = new HttpClient(new HttpClientHandler { UseProxy = false });
        private WebView2 webView;
        private Task connecting;
        private bool permitExit;
        private bool resourcesDisposed;
        private bool recreate;
        private bool navigationSucceeded;
        private bool reconnectPending = true;
        private bool viewPaused;
        private int attempts;
        private int processFailures;

        public MainForm(AppConfig initialConfig, bool hasHost)
        {
            config = initialConfig;
            Text = "QuayMesh";
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            Size = new Size(1420, 900);
            MinimumSize = new Size(720, 520);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = WindowTheme.Background(false);
            string icon = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app.ico");
            if (File.Exists(icon)) Icon = new Icon(icon);
            toolbar = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.Top, Padding = new Padding(8, 4, 8, 4), Font = new Font("Segoe UI", 9F), BackColor=WindowTheme.Surface(false), ForeColor=WindowTheme.Text(false), RenderMode=ToolStripRenderMode.System };
            toolbar.Items.Add(status);
            toolbar.Items.Add(new ToolStripSeparator());
            toolbar.Items.Add("刷新", null, delegate { Reconnect(); });
            toolbar.Items.Add("浏览器打开", null, delegate { OpenBrowser(); });
            toolbar.Items.Add("设置", null, delegate { OpenSettings(); });
            Controls.Add(surface);
            Controls.Add(notice);
            Controls.Add(toolbar);
            HandleCreated += delegate { WindowTheme.Apply(this, lightTheme); };
            retry.Tick += delegate { retry.Stop(); Reconnect(false); };
            FormClosing += OnClosing;
            Resize += async delegate { await UpdateVisibilityAsync(); };
            Disposed += delegate
            {
                if (resourcesDisposed) return;
                resourcesDisposed = true;
                permitExit = true;
                lifetime.Cancel();
                retry.Dispose();
                http.Dispose();
                lifetime.Dispose();
            };
        }

        public void ShowAndFocus()
        {
            if (InvokeRequired) { BeginInvoke((Action)ShowAndFocus); return; }
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            SetForegroundWindow(Handle);
            ResumeView(true);
        }

        public void ToggleVisibility()
        {
            if (Visible && WindowState != FormWindowState.Minimized) { Hide(); PauseView(); }
            else ShowAndFocus();
        }

        public void Reconnect()
        {
            Reconnect(true);
        }

        private async void Reconnect(bool manual)
        {
            if (permitExit || IsDisposed) return;
            if (manual) { attempts = 0; processFailures = 0; }
            reconnectPending = true;
            if (!Visible || WindowState == FormWindowState.Minimized || processFailures >= 3) { retry.Stop(); return; }
            if (connecting != null) { await connecting; return; }
            retry.Stop();
            connecting = ConnectAsync();
            try { await connecting; }
            finally { connecting = null; }
        }

        private async Task ConnectAsync()
        {
            retry.Stop();
            try
            {
                status.Text = "正在连接控制台";
                if (webView == null || recreate) await CreateViewAsync();
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
                {
                    timeout.CancelAfter(TimeSpan.FromSeconds(5));
                    using (var response = await http.GetAsync(config.ServerUrl, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
                    {
                        if (!response.IsSuccessStatusCode && (int)response.StatusCode != 401 && (int)response.StatusCode != 403)
                            throw new HttpRequestException("控制台返回 HTTP " + (int)response.StatusCode);
                    }
                }
                if (permitExit || IsDisposed) return;
                notice.Visible = false;
                // 始终使用用户选定来源，网络波动不会切换登录数据库。
                if (navigationSucceeded && webView.CoreWebView2.Source.StartsWith(config.ServerUrl, StringComparison.OrdinalIgnoreCase)) webView.Reload();
                else webView.CoreWebView2.Navigate(config.ServerUrl);
                status.Text = "控制台正在加载";
            }
            catch (OperationCanceledException) { if (!permitExit) ConnectionFailed("连接超时，请检查后台服务或网络。"); }
            catch (Exception error) { if (!permitExit) ConnectionFailed(error.Message); }
        }

        private async Task CreateViewAsync()
        {
            if (webView != null) { surface.Controls.Remove(webView); webView.Dispose(); }
            webView = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            surface.Controls.Add(webView);
            string userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuayMesh", "WebView2Data");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData, null);
            await webView.EnsureCoreWebView2Async(environment);
            webView.ZoomFactor = 1.0;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
            webView.CoreWebView2.WebMessageReceived += OnWebMessage;
            try { await sessions.RestoreAsync(webView.CoreWebView2, config.ServerUrl); }
            catch (System.Security.Cryptography.CryptographicException error) { sessions.Clear(); ClientLog.Write("登录凭据无法解密：" + error.GetType().Name); }
            webView.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                if (!TrustedPage(e.Uri)) { e.Cancel = true; if (AppConfig.IsValidServerUrl(e.Uri)) Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true }); }
            };
            webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                if (AppConfig.IsValidServerUrl(e.Uri)) Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
            };
            webView.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (permitExit) return;
                if (e.IsSuccess && e.HttpStatusCode >= 200 && e.HttpStatusCode < 400)
                {
                    navigationSucceeded = true;
                    reconnectPending = false;
                    attempts = 0;
                    retry.Stop();
                    notice.Visible = false;
                    status.Text = "已连接控制台";
                }
                else ConnectionFailed(e.HttpStatusCode >= 400
                    ? "控制台返回 HTTP " + e.HttpStatusCode
                    : "页面加载失败：" + e.WebErrorStatus,
                    e.HttpStatusCode != 401 && e.HttpStatusCode != 403);
            };
            webView.CoreWebView2.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs e)
            {
                recreate = true;
                navigationSucceeded = false;
                processFailures++;
                ClientLog.Write("WebView2 进程异常：" + e.ProcessFailedKind);
                ConnectionFailed("网页组件已停止，点击刷新重新打开。");
            };
            recreate = false;
            navigationSucceeded = false;
        }

        private void ConnectionFailed(string message, bool retryConnection = true)
        {
            reconnectPending = retryConnection;
            retry.Stop();
            toolbar.Visible = true;
            status.Text = processFailures >= 3 ? "网页组件需要手动刷新" : retryConnection ? "等待恢复连接" : "连接需要检查";
            ShowNotice(message);
            ClientLog.Write(message);
            if (retryConnection && Visible && WindowState != FormWindowState.Minimized && processFailures < 3)
            {
                retry.Interval = Math.Min(30000, 2000 * (1 << attempts));
                attempts = Math.Min(attempts + 1, 4);
                retry.Start();
            }
        }

        private void ShowNotice(string message)
        {
            notice.Text = message;
            notice.Visible = true;
        }

        private async Task UpdateVisibilityAsync()
        {
            if (WindowState == FormWindowState.Minimized || !Visible) { PauseView(); return; }
            ResumeView(false);
            await Task.CompletedTask;
        }

        private void ResumeView(bool checkConnection)
        {
            bool wasPaused = viewPaused;
            viewPaused = false;
            if (webView != null && webView.CoreWebView2 != null && !recreate) webView.CoreWebView2.Resume();
            if ((wasPaused || checkConnection) && reconnectPending) Reconnect(false);
        }

        private async void PauseView()
        {
            viewPaused = true;
            retry.Stop();
            if (webView == null || webView.CoreWebView2 == null || recreate) return;
            try
            {
                bool suspended = await webView.CoreWebView2.TrySuspendAsync();
                if (suspended && Visible && WindowState != FormWindowState.Minimized && !IsDisposed) webView.CoreWebView2.Resume();
            }
            catch (Exception error) { ClientLog.Write("网页暂停失败：" + error.Message); }
        }

        private void OpenBrowser()
        {
            try { Process.Start(new ProcessStartInfo(config.ServerUrl) { UseShellExecute = true }); }
            catch (Exception error) { ShowNotice(error.Message); }
        }

        private void OpenSettings()
        {
            using (var dialog = new SettingsForm(config, lightTheme))
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    dialog.Config.Save();
                    config = dialog.Config;
                    navigationSucceeded = false;
                    attempts = 0;
                    Reconnect();
                }
                catch (Exception error) { MessageBox.Show(this, error.Message, "设置保存失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }
        }

        private bool TrustedPage(string address)
        {
            Uri uri;
            if (!Uri.TryCreate(address, UriKind.Absolute, out uri)) return false;
            var expected = new Uri(config.ServerUrl);
            return uri.GetLeftPart(UriPartial.Authority) == expected.GetLeftPart(UriPartial.Authority)
                && (uri.AbsolutePath == "/console" || uri.AbsolutePath.StartsWith("/console/", StringComparison.Ordinal));
        }

        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!TrustedPage(e.Source)) return;
            try
            {
                var message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                object type;
                if (message == null || !message.TryGetValue("type", out type)) return;
                object value; message.TryGetValue("value", out value);
                if ((string)type == "theme")
                {
                    toolbar.Visible = false;
                    lightTheme = (value as string) == "light";
                    WindowTheme.Apply(this,lightTheme);
                    toolbar.BackColor=WindowTheme.Surface(lightTheme);toolbar.ForeColor=WindowTheme.Text(lightTheme);
                    webView.DefaultBackgroundColor=BackColor;
                }
                else if ((string)type == "session")
                {
                    if (savingSession != null) await savingSession;
                    if (value is bool && (bool)value)
                    {
                        savingSession = sessions.SaveAsync(webView.CoreWebView2,config.ServerUrl);
                        try { await savingSession; } finally { savingSession=null; }
                    }
                    else sessions.Clear();
                }
                else if ((string)type == "settings") OpenSettings();
                else if ((string)type == "external") OpenBrowser();
            }
            catch (Exception error) { ClientLog.Write("窗口操作失败：" + error.GetType().Name); }
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (!permitExit && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); PauseView(); return; }
            permitExit = true;
            retry.Stop();
            lifetime.Cancel();
        }

        public void ExitApplication()
        {
            if (permitExit || IsDisposed) return;
            permitExit = true;
            retry.Stop();
            lifetime.Cancel();
            Close();
            Application.ExitThread();
        }
    }
}
