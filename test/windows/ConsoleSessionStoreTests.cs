using System;
using System.IO;
using System.Text;
using QuayMeshApp;

internal static class ConsoleSessionStoreTests
{
    private static void Require(bool success,string message) { if (!success) throw new Exception(message); }
    public static void Main(string[] args)
    {
        string directory = Path.Combine(Path.GetTempPath(),"quaymesh-cookie-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string file = Path.Combine(directory,"session.bin");
            string value = Guid.NewGuid().ToString("N")+Guid.NewGuid().ToString("N");
            var store = new BrowserSessionStore(file);
            var cookie = new SavedConsoleSession { Origin="http://127.0.0.1:17676",Value=value,ExpiresUtcTicks=DateTime.UtcNow.AddDays(30).Ticks,Secure=false };
            store.Save(cookie);
            Require(!Encoding.UTF8.GetString(File.ReadAllBytes(file)).Contains(value),"cookie stored in plaintext");
            Require(new BrowserSessionStore(file).Read(cookie.Origin+"/console/").Value==value,"durable session did not restore");
            Require(store.Read("https://other.example/console/")==null,"session crossed origin");
            cookie.ExpiresUtcTicks=DateTime.UtcNow.AddSeconds(-1).Ticks;store.Save(cookie);
            Require(store.Read(cookie.Origin)==null&&!File.Exists(file),"expired session persisted");
            cookie.ExpiresUtcTicks=DateTime.UtcNow.AddDays(1).Ticks;store.Save(cookie);store.Clear();
            Require(store.Read(cookie.Origin)==null,"logout did not clear session");
            Console.WriteLine("5 Windows session storage checks passed");
        }
        finally { Directory.Delete(directory,true); }
    }
}
