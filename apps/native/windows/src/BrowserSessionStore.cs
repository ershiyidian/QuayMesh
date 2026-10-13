using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;

namespace QuayMeshApp
{
    public sealed class SavedConsoleSession
    {
        public string Origin { get; set; }
        public string Value { get; set; }
        public long ExpiresUtcTicks { get; set; }
        public bool Secure { get; set; }
    }

    public sealed class BrowserSessionStore
    {
        private readonly string path;
        private readonly byte[] entropy = Encoding.UTF8.GetBytes("QuayMesh.ConsoleSession.v1");

        public BrowserSessionStore() : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QuayMesh", "console-session.bin")) { }
        public BrowserSessionStore(string file) { path = Path.GetFullPath(file); }

        public void Clear() { if (File.Exists(path)) File.Delete(path); }

        public async Task SaveAsync(CoreWebView2 browser, string address)
        {
            var cookies = await browser.CookieManager.GetCookiesAsync(address);
            var cookie = cookies.FirstOrDefault(item => item.Name == "qm_console_session");
            if (cookie == null || cookie.IsSession || cookie.Expires.ToUniversalTime() <= DateTime.UtcNow) { Clear(); return; }
            var saved = new SavedConsoleSession { Origin = new Uri(address).GetLeftPart(UriPartial.Authority), Value = cookie.Value,
                ExpiresUtcTicks = cookie.Expires.ToUniversalTime().Ticks, Secure = cookie.IsSecure };
            Save(saved);
        }

        public void Save(SavedConsoleSession saved)
        {
            byte[] protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(saved)), entropy, DataProtectionScope.CurrentUser);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + ".new";
            File.WriteAllBytes(temporary, protectedBytes);
            if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
        }

        public async Task RestoreAsync(CoreWebView2 browser, string address)
        {
            var saved = Read(address);
            if (saved == null) return;
            var origin = new Uri(address);
            var expires = new DateTime(saved.ExpiresUtcTicks, DateTimeKind.Utc);
            var existing = await browser.CookieManager.GetCookiesAsync(address);
            if (existing.Any(cookie => cookie.Name == "qm_console_session")) return;
            var restored = browser.CookieManager.CreateCookie("qm_console_session", saved.Value, origin.Host, "/console");
            restored.IsHttpOnly = true;
            restored.IsSecure = saved.Secure;
            restored.SameSite = CoreWebView2CookieSameSiteKind.Strict;
            restored.Expires = expires;
            browser.CookieManager.AddOrUpdateCookie(restored);
        }

        public SavedConsoleSession Read(string address)
        {
            if (!File.Exists(path)) return null;
            var saved = new JavaScriptSerializer().Deserialize<SavedConsoleSession>(Encoding.UTF8.GetString(
                ProtectedData.Unprotect(File.ReadAllBytes(path), entropy, DataProtectionScope.CurrentUser)));
            if (saved == null || new DateTime(saved.ExpiresUtcTicks,DateTimeKind.Utc) <= DateTime.UtcNow) { Clear(); return null; }
            return saved.Origin == new Uri(address).GetLeftPart(UriPartial.Authority) ? saved : null;
        }
    }
}
