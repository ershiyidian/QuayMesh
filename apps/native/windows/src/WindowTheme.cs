using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace QuayMeshApp
{
    public static class WindowTheme
    {
        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        public static Color Background(bool light) { return light ? Color.FromArgb(244,244,246) : Color.FromArgb(14,14,16); }
        public static Color Surface(bool light) { return light ? Color.White : Color.FromArgb(22,22,24); }
        public static Color Text(bool light) { return light ? Color.FromArgb(32,32,36) : Color.FromArgb(236,236,239); }
        public static void Apply(Form form, bool light)
        {
            form.BackColor = Background(light);
            form.ForeColor = Text(light);
            int dark = light ? 0 : 1;
            if (form.IsHandleCreated)
            {
                DwmSetWindowAttribute(form.Handle, 20, ref dark, sizeof(int));
                var caption=Surface(light);var text=Text(light);
                int captionColor=caption.R | (caption.G<<8) | (caption.B<<16);
                int textColor=text.R | (text.G<<8) | (text.B<<16);
                DwmSetWindowAttribute(form.Handle,35,ref captionColor,sizeof(int));
                DwmSetWindowAttribute(form.Handle,36,ref textColor,sizeof(int));
            }
        }
        public static void Button(Button button, bool light, bool primary)
        {
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderColor = light ? Color.FromArgb(205,205,213) : Color.FromArgb(58,58,66);
            button.BackColor = primary ? Color.FromArgb(138,180,255) : Surface(light);
            button.ForeColor = primary ? Color.FromArgb(15,32,61) : Text(light);
            button.Height = 34;
        }
    }
}
