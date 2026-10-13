using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace QuayMesh.Host;

public static class RuntimeControlClient
{
    public static async Task<bool> ShutdownAsync(Process process,ProcessLaunch launch,TimeSpan timeout,CancellationToken cancellationToken)
    {
        if(!launch.Environment.TryGetValue("QUAYMESH_NODE_CONTROL_URL",out var url) ||
           !launch.Environment.TryGetValue("QUAYMESH_NODE_TOKEN_FILE",out var tokenFile))
            throw new InvalidDataException("缺少 QuayMesh Node 管理配置");
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        using var http=new HttpClient(new HttpClientHandler{UseProxy=false});
        http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",(await File.ReadAllTextAsync(tokenFile,deadline.Token)).Trim());
        using var response=await http.PostAsync(new Uri(new Uri(url),"/shutdown"),null,deadline.Token);
        response.EnsureSuccessStatusCode();
        await process.WaitForExitAsync(deadline.Token);
        return true;
    }
}
