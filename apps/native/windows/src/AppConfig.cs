using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace QuayMeshApp
{
    public class AppConfig
    {
        public string ServerUrl { get; set; }

        public AppConfig()
        {
            ServerUrl = "http://127.0.0.1:17676/console/";
        }

        public static string GetConfigFilePath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuayMesh", "config.json");
        }

        public static bool IsValidServerUrl(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && string.IsNullOrEmpty(uri.UserInfo)
                && (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback));
        }

        public static AppConfig Load()
        {
            string path = GetConfigFilePath();
            if (!File.Exists(path)) throw new FileNotFoundException("请先安装 QuayMesh 节点。", path);
            AppConfig config = new JavaScriptSerializer().Deserialize<AppConfig>(File.ReadAllText(path, Encoding.UTF8));
            if (config == null || !IsValidServerUrl(config.ServerUrl))
                throw new InvalidDataException("控制台地址无效，请检查 " + path);
            return config;
        }

        public void Save()
        {
            if (!IsValidServerUrl(ServerUrl)) throw new InvalidDataException("服务器地址只接受 HTTPS 或本机回环 HTTP。");
            string path = GetConfigFilePath();
            var serializer = new JavaScriptSerializer();
            var saved = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
            saved["ServerUrl"] = ServerUrl;
            string temporary = path + ".new";
            File.WriteAllText(temporary, serializer.Serialize(saved), new UTF8Encoding(false));
            File.Replace(temporary, path, null);
        }
    }
}
