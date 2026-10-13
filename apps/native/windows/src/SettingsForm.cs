using System;
using System.Drawing;
using System.Windows.Forms;

namespace QuayMeshApp
{
    public class SettingsForm : Form
    {
        public AppConfig Config { get; private set; }
        private readonly TextBox address;

        public SettingsForm(AppConfig config, bool light)
        {
            Config = config;
            Text = "QuayMesh 设置";
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F,96F);
            Font = new Font("Segoe UI", 9F);
            ClientSize = new Size(540, 190);
            WindowTheme.Apply(this,light);
            HandleCreated += delegate { WindowTheme.Apply(this,light); };
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            StartPosition = FormStartPosition.CenterParent;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            var label = new Label { Text = "控制台地址", AutoSize = true, Location = new Point(20, 22) };
            address = new TextBox { Text = config.ServerUrl, Location = new Point(20, 48), Width = 500 };
            address.BackColor=WindowTheme.Surface(light);address.ForeColor=WindowTheme.Text(light);
            address.BorderStyle=BorderStyle.FixedSingle;
            var save = new Button { Text = "保存", Location = new Point(350, 130), Width = 80 };
            var cancel = new Button { Text = "取消", Location = new Point(440, 130), Width = 80, DialogResult = DialogResult.Cancel };
            WindowTheme.Button(save,light,true);WindowTheme.Button(cancel,light,false);
            save.Click += Save;
            Controls.AddRange(new Control[] { label, address, save, cancel });
            AcceptButton = save;
            CancelButton = cancel;
        }

        private void Save(object sender, EventArgs e)
        {
            if (!AppConfig.IsValidServerUrl(address.Text.Trim()))
            {
                MessageBox.Show(this, "请输入 HTTPS 地址或本机 HTTP 地址。", "地址无效", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            Config.ServerUrl = address.Text.Trim();
            Config.Save();
            DialogResult = DialogResult.OK;
            Close();
        }
    }
}
