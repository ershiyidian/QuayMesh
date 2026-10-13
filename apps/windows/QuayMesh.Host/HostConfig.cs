using System.Text.Json;

namespace QuayMesh.Host;

public sealed class ProcessLaunch
{
    public bool Enabled { get; set; }
    public string Executable { get; set; } = "";
    public string Arguments { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";
    public Dictionary<string,string> Environment { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed class HostConfig
{
    public string ServerUrl { get; set; } = "http://127.0.0.1:17676/console/";
    public string StateDirectory { get; set; } = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),"QuayMesh","state");
    public bool Supervise { get; set; } = true;
    public int Port { get; set; } = 17677;
    public string UiExecutable { get; set; } = "";
    public string UiArguments { get; set; } = "";
    public ProcessLaunch Worker { get; set; } = new();

    public static string ConfigPath => Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),"QuayMesh","config.json");
    public static string LogDirectory => Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData),"QuayMesh","logs");

    public static HostConfig Load()
    {
        var config=JsonSerializer.Deserialize<HostConfig>(File.ReadAllText(ConfigPath))
            ?? throw new InvalidDataException("QuayMesh Host 配置为空");
        if (config.Port is <1 or >65535) throw new InvalidDataException("管理端口无效");
        if (!Uri.TryCreate(config.ServerUrl,UriKind.Absolute,out var uri) || uri.Scheme is not ("http" or "https"))
            throw new InvalidDataException("Console 地址无效");
        return config;
    }
}
