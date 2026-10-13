using System;
using System.IO;
using System.Text;

namespace QuayMeshApp
{
    internal static class ClientLog
    {
        private static readonly object Gate = new object();
        public static void Write(string text)
        {
            lock (Gate)
            {
                string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuayMesh", "logs");
                Directory.CreateDirectory(directory);
                string path = Path.Combine(directory, "web-client.log");
                if (File.Exists(path) && new FileInfo(path).Length > 1024 * 1024)
                {
                    if (File.Exists(path + ".1")) File.Delete(path + ".1");
                    File.Move(path, path + ".1");
                }
                File.AppendAllText(path, DateTimeOffset.Now.ToString("O") + " " + text.Replace('\r', ' ').Replace('\n', ' ') + Environment.NewLine, new UTF8Encoding(false));
            }
        }
    }
}
