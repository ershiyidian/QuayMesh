using System.Text.Json;
using QuayMesh.Shared;

namespace QuayMesh.Host;

public sealed class NodeComponentStatus
{
    private readonly HostConfig _config;
    private readonly RollingLog _log;
    public NodeComponentStatus(HostConfig config,RollingLog log,ProcessJob? job=null)
    {
        _config=config;
        _log=log;
    }

    public (ServiceState State,int? Pid) Mesh() => Probe("mesh");
    public (ServiceState State,int? Pid) Discovery() => Probe("discovery");

    private (ServiceState State,int? Pid) Probe(string name)
    {
        var path=Path.Combine(_config.StateDirectory,"node-status.json");
        if (!File.Exists(path)) return (ServiceState.Starting,null);
        try
        {
            using var doc=JsonDocument.Parse(File.ReadAllText(path));
            foreach(var component in doc.RootElement.GetProperty("components").EnumerateArray())
            {
                if(component.GetProperty("id").GetString()!=name) continue;
                int? pid=component.TryGetProperty("pid",out var rawPid)
                    && rawPid.ValueKind==JsonValueKind.Number
                    && rawPid.TryGetInt32(out var value)?value:null;
                var state=component.GetProperty("state").GetString() switch
                {
                    "ready"=>ServiceState.Healthy,
                    "starting" or "waiting"=>ServiceState.Starting,
                    "backoff"=>ServiceState.Unhealthy,
                    _=>ServiceState.Stopped
                };
                return (state,pid);
            }
            return (ServiceState.Stopped,null);
        }
        catch(Exception error) when(error is IOException or JsonException)
        {
            _log.Write($"节点状态读取失败：{error.Message}");
            return (ServiceState.Unhealthy,null);
        }
    }
}
