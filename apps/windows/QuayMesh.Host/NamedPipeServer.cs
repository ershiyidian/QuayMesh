using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using QuayMesh.Shared;

namespace QuayMesh.Host;

public sealed class HostPipeServer
{
    private readonly Func<HostStatus> _status;
    private readonly Action _restart;
    private readonly string _logDirectory;
    private readonly string _portalUrl;
    private readonly Action? _openUi;
    private readonly Action? _toggleUi;
    private readonly Action? _reconnect;
    private readonly Action? _exit;
    private readonly Action<string>? _log;
    private readonly string _pipeName;
    private CancellationTokenSource? _cancel;

    public HostPipeServer(
        Func<HostStatus> status,
        Action restart,
        string logDirectory,
        string portalUrl,
        Action? openUi = null,
        Action? reconnect = null,
        Action? exit = null,
        Action<string>? log = null,
        Action? toggleUi = null,
        string pipeName = PipeProtocol.PipeName)
    {
        _status = status;
        _restart = restart;
        _logDirectory = logDirectory;
        _portalUrl = portalUrl;
        _openUi = openUi;
        _reconnect = reconnect;
        _exit = exit;
        _log = log;
        _toggleUi = toggleUi;
        _pipeName = pipeName;
    }

    public void Start()
    {
        _cancel = new CancellationTokenSource();
        _log?.Invoke("Host pipe starting");
        _ = Task.Run(() => Loop(_cancel.Token));
    }

    public void Stop() => _cancel?.Cancel();

    private async Task Loop(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(
                    _pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

                await server.WaitForConnectionAsync(cancellationToken);

                try
                {
                    using var reader = new StreamReader(server, leaveOpen: true);
                    using var writer = new StreamWriter(server, leaveOpen: true) { AutoFlush = true };
                    using var readTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    readTimeout.CancelAfter(TimeSpan.FromSeconds(2));
                    var request = await ReadLineLimitedAsync(reader, 16 * 1024, readTimeout.Token);
                    var op = "";
                    var confirm = false;
                    if (!string.IsNullOrWhiteSpace(request))
                    {
                        using var document = JsonDocument.Parse(request);
                        if (document.RootElement.ValueKind == JsonValueKind.Object)
                        {
                            op = document.RootElement.TryGetProperty("op", out var value) ? value.GetString() ?? "" : "";
                            confirm = document.RootElement.TryGetProperty("confirm", out var flag) && flag.ValueKind == JsonValueKind.True;
                        }
                        else if (document.RootElement.ValueKind == JsonValueKind.String)
                        {
                            op = document.RootElement.GetString() ?? "";
                        }
                    }
                    object response = op switch
                    {
                        PipeProtocol.OpenLogFolder => OpenLogs(),
                        PipeProtocol.OpenPortal => OpenPortal(),
                        PipeProtocol.GetStatus => _status(),
                        PipeProtocol.OpenUi => Invoke(_openUi),
                        PipeProtocol.ToggleUi => Invoke(_toggleUi),
                        PipeProtocol.ReconnectConsole => Invoke(_reconnect),
                        PipeProtocol.ExitApplication => Invoke(_exit),
                        PipeProtocol.RestartWorker when confirm => Restart(),
                        PipeProtocol.RestartWorker => new { ok = false, error = "confirmation_required" },
                        _ => new { ok = false, error = "unknown_operation" },
                    };
                    await writer.WriteLineAsync(JsonSerializer.Serialize(response));
                    await writer.FlushAsync(cancellationToken);
                }
                catch (Exception error)
                {
                    _log?.Invoke($"Pipe client error: {error.Message}");
                }
                finally
                {
                    if (server.IsConnected)
                    {
                        server.Disconnect();
                    }
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception error)
            {
                _log?.Invoke($"Host pipe error: {error.Message}");
                try { await Task.Delay(100, cancellationToken); } catch { break; }
            }
        }
    }

    private static async Task<string?> ReadLineLimitedAsync(TextReader reader, int maximumLength, CancellationToken cancellationToken)
    {
        var builder = new System.Text.StringBuilder();
        var buffer = new char[1];
        while (builder.Length <= maximumLength)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(), cancellationToken);
            if (count == 0) return builder.Length == 0 ? null : builder.ToString();
            if (buffer[0] == '\n') return builder.ToString().TrimEnd('\r');
            builder.Append(buffer[0]);
        }
        throw new InvalidDataException("管道请求过大。");
    }

    private static object Invoke(Action? action)
    {
        if (action is not null)
        {
            Task.Run(action);
        }
        return new { ok = true };
    }

    private object OpenLogs()
    {
        Task.Run(() =>
        {
            try
            {
                Directory.CreateDirectory(_logDirectory);
                Process.Start(new ProcessStartInfo("explorer.exe", _logDirectory) { UseShellExecute = true });
            }
            catch { }
        });
        return new { ok = true };
    }

    private object OpenPortal()
    {
        Task.Run(() =>
        {
            try
            {
                Process.Start(new ProcessStartInfo(_portalUrl) { UseShellExecute = true });
            }
            catch { }
        });
        return new { ok = true };
    }

    private object Restart()
    {
        Task.Run(_restart);
        return new { ok = true };
    }
}
