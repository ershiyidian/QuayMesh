using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

namespace QuayMesh.Host;

/// <summary>Two OS-local pipes: clients use the public pipe; the Core connects
/// to a private persistent channel. Neither pipe has administrative operations.</summary>
public sealed class LocalUserPipeServer : IDisposable
{
    private const string Protocol = "quaymesh.local-user.v1";
    private const string BridgeProtocol = "quaymesh.local-user.bridge.v1";
    private const int FrameLimit = 65536;
    private const int InternalLimit = FrameLimit + 1024;
    private static readonly JsonSerializerOptions Json = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly SecurityIdentifier _user = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("User SID is unavailable.");
    private readonly SecurityIdentifier _system = new(WellKnownSidType.LocalSystemSid, null);
    private readonly CancellationTokenSource _stop = new();
    private readonly object _gate = new();
    private readonly ConcurrentDictionary<string, Pending> _pending = new();
    private Core? _core;
    private sealed class Core(NamedPipeServerStream pipe)
    { public readonly NamedPipeServerStream Pipe = pipe; public readonly SemaphoreSlim Writes = new(1, 1); }
    private sealed class Pending(Core core)
    { public readonly Core Core = core; public readonly Channel<JsonElement> Responses = Channel.CreateBounded<JsonElement>(4); }
    public string BridgeKey { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public string Endpoint { get; }
    public string InternalEndpoint { get; } = @"\\.\pipe\QuayMesh.LocalUser.Core." + Guid.NewGuid().ToString("N");

    public LocalUserPipeServer(string? testEndpoint = null)
    {
        if (testEndpoint is not null && !System.Text.RegularExpressions.Regex.IsMatch(testEndpoint, @"^\\\\\.\\pipe\\QuayMesh\.LocalUser\.Test\.[a-f0-9]{32}$"))
            throw new ArgumentException("The fixture must use an isolated test pipe.");
        var suffix = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(_user.Value)))[..24].ToLowerInvariant();
        Endpoint = testEndpoint ?? @"\\.\pipe\QuayMesh.LocalUser." + suffix;
    }
    public void Start()
    {
        var first = CreatePipe(Endpoint, true, 32);
        NamedPipeServerStream second;
        try { second = CreatePipe(InternalEndpoint, true, 2); } catch { first.Dispose(); throw; }
        _ = Task.Run(() => AcceptLoop(Endpoint, first, 32, Serve));
        _ = Task.Run(() => AcceptLoop(InternalEndpoint, second, 2, ConnectCore));
    }
    public void Stop() { _stop.Cancel(); lock (_gate) _core?.Pipe.Dispose(); }
    public void Dispose() => Stop();

    private async Task AcceptLoop(string endpoint, NamedPipeServerStream? first, int maximum, Func<NamedPipeServerStream, Task> serve)
    {
        var slots = new SemaphoreSlim(maximum, maximum);
        while (!_stop.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null; var acquired = false;
            try
            {
                await slots.WaitAsync(_stop.Token); acquired = true;
                pipe = first ?? CreatePipe(endpoint, false, maximum); first = null;
                await pipe.WaitForConnectionAsync(_stop.Token);
                var accepted = pipe; pipe = null;
                _ = serve(accepted).ContinueWith(_ => slots.Release(), TaskScheduler.Default); acquired = false;
            }
            catch (OperationCanceledException) { break; }
            catch { try { await Task.Delay(500, _stop.Token); } catch { break; } }
            finally { pipe?.Dispose(); if (acquired) slots.Release(); }
        }
        first?.Dispose();
    }
    private async Task ConnectCore(NamedPipeServerStream pipe)
    {
        await using (pipe)
        using (var input = new BufferedStream(pipe, 16384))
        using (var cancel = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
        {
            Core? core = null;
            try
            {
                cancel.CancelAfter(TimeSpan.FromSeconds(5));
                var first = await ReadFrame(input, InternalLimit, cancel.Token) ?? throw new IOException();
                using var registration = JsonDocument.Parse(first); var value = registration.RootElement;
                var supplied = Encoding.UTF8.GetBytes(value.GetProperty("key").GetString() ?? "");
                if (value.GetProperty("protocol").GetString() != BridgeProtocol
                    || !CryptographicOperations.FixedTimeEquals(supplied, Encoding.UTF8.GetBytes(BridgeKey))) throw new UnauthorizedAccessException();
                var nodeId = value.GetProperty("nodeId").GetString() ?? "";
                var directory = value.GetProperty("configDir").GetString() ?? "";
                if (nodeId.Length is < 1 or > 256) throw new InvalidDataException();
                core = new Core(pipe);
                lock (_gate) { if (_core is not null) throw new IOException("An active Core already owns this channel."); _core = core; }
                await PublishDiscovery(directory, nodeId, cancel.Token);
                await SendCore(core, new { protocol = BridgeProtocol, kind = "ready" }, cancel.Token);
                cancel.CancelAfter(Timeout.InfiniteTimeSpan);
                while (!_stop.IsCancellationRequested)
                {
                    var frame = await ReadFrame(input, InternalLimit, cancel.Token); if (frame is null) break;
                    using var document = JsonDocument.Parse(frame); var message = document.RootElement;
                    if (message.GetProperty("kind").GetString() != "response") throw new InvalidDataException();
                    var id = message.GetProperty("connectionId").GetString() ?? "";
                    if (_pending.TryGetValue(id, out var pending) && ReferenceEquals(pending.Core, core))
                    {
                        if (!pending.Responses.Writer.TryWrite(message.GetProperty("response").Clone()))
                            pending.Responses.Writer.TryComplete(new IOException("Client is not receiving responses."));
                    }
                }
            }
            catch { }
            finally
            {
                if (core is not null)
                {
                    lock (_gate) { if (ReferenceEquals(_core, core)) _core = null; }
                    foreach (var pair in _pending) if (ReferenceEquals(pair.Value.Core, core))
                        pair.Value.Responses.Writer.TryComplete(new IOException("Core connection closed."));
                }
            }
        }
    }
    private async Task Serve(NamedPipeServerStream pipe)
    {
        await using (pipe)
        using (var input = new BufferedStream(pipe, 16384))
        using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
        {
            var id = "invalid"; string? connectionId = null; Pending? pending = null; Task disconnected = Task.CompletedTask;
            try
            {
                deadline.CancelAfter(TimeSpan.FromSeconds(10));
                var bytes = await ReadFrame(input, FrameLimit, deadline.Token); if (bytes is null) return;
                using var parsed = JsonDocument.Parse(bytes); var request = parsed.RootElement;
                if (request.GetProperty("protocol").GetString() != Protocol) throw new InvalidDataException();
                id = request.GetProperty("id").GetString() ?? "invalid"; if (id.Length is < 1 or > 256) throw new InvalidDataException();
                Core core; lock (_gate) core = _core ?? throw new IOException("Core is unavailable.");
                connectionId = Guid.NewGuid().ToString("N"); pending = new Pending(core);
                if (!_pending.TryAdd(connectionId, pending)) throw new IOException();
                disconnected = WatchDisconnect(input, deadline);
                await SendCore(core, new { kind = "request", connectionId, request }, deadline.Token);
                while (!_stop.IsCancellationRequested)
                {
                    deadline.CancelAfter(TimeSpan.FromSeconds(45));
                    var response = await pending.Responses.Reader.ReadAsync(deadline.Token);
                    var frame = Encoding.UTF8.GetBytes(response.GetRawText());
                    await WriteFrame(pipe, frame, FrameLimit, deadline.Token);
                    if (response.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.True) break;
                }
            }
            catch
            {
                if (!_stop.IsCancellationRequested && pipe.IsConnected)
                {
                    try { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                        await WriteFrame(pipe, JsonSerializer.SerializeToUtf8Bytes(new { protocol = Protocol, id, ok = false,
                            error = new { code = "LOCAL_API_UNAVAILABLE", message = "LOCAL_API_UNAVAILABLE" }, done = true }), FrameLimit, timeout.Token); }
                    catch { }
                }
            }
            finally
            {
                deadline.Cancel(); try { await disconnected; } catch { }
                if (connectionId is not null) _pending.TryRemove(connectionId, out _);
                if (pending is not null)
                {
                    try { using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                        await SendCore(pending.Core, new { kind = "cancel", connectionId }, timeout.Token); } catch { }
                }
            }
        }
    }
    private static async Task WatchDisconnect(Stream input, CancellationTokenSource deadline)
    {
        try { await input.ReadAsync(new byte[1].AsMemory(), deadline.Token); } catch (OperationCanceledException) { return; } catch { }
        deadline.Cancel();
    }
    private static async Task SendCore(Core core, object value, CancellationToken token)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, Json);
        await core.Writes.WaitAsync(token);
        try { await WriteFrame(core.Pipe, bytes, InternalLimit, token); } finally { core.Writes.Release(); }
    }
    private static async Task WriteFrame(Stream stream, byte[] bytes, int limit, CancellationToken token)
    {
        if (bytes.Length + 1 > limit) throw new InvalidDataException("Frame is too large.");
        await stream.WriteAsync(bytes, token); await stream.WriteAsync(new byte[] { 10 }, token); await stream.FlushAsync(token);
    }
    // Callers use BufferedStream: byte framing does not cause a syscall per byte.
    private static async Task<byte[]?> ReadFrame(Stream stream, int limit, CancellationToken token)
    {
        using var bytes = new MemoryStream(); var one = new byte[1];
        while (bytes.Length < limit)
        {
            var read = await stream.ReadAsync(one.AsMemory(), token);
            if (read == 0) { if (bytes.Length == 0) return null; throw new InvalidDataException(); }
            if (one[0] == 10) return bytes.ToArray(); bytes.WriteByte(one[0]);
        }
        throw new InvalidDataException();
    }
    private async Task PublishDiscovery(string directory, string nodeId, CancellationToken token)
    {
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\")) throw new InvalidDataException();
        var info = new DirectoryInfo(directory); if (info.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new InvalidDataException();
        var acl = info.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (!Equals(acl.GetOwner(typeof(SecurityIdentifier)), _user)) throw new UnauthorizedAccessException();
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        const FileSystemRights mutations = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles
            | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow && !rule.IdentityReference.Equals(_user)
                && !rule.IdentityReference.Equals(_system) && !rule.IdentityReference.Equals(administrators)
                && (rule.FileSystemRights & mutations) != 0) throw new UnauthorizedAccessException();
        var destination = Path.Combine(directory, "local-user-api.json");
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(new { protocol = Protocol, endpoint = Endpoint, nodeId }), token);
            var fileAcl = new FileSecurity(); fileAcl.SetOwner(_user); fileAcl.SetAccessRuleProtection(true, false);
            fileAcl.AddAccessRule(new(_user, FileSystemRights.FullControl, AccessControlType.Allow));
            fileAcl.AddAccessRule(new(_system, FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(temporary).SetAccessControl(fileAcl); File.Move(temporary, destination, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public int InheritHandle; }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor, uint revision, out IntPtr result, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode, uint instances,
        uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes attributes);
    private NamedPipeServerStream CreatePipe(string endpoint, bool first, int maximum)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor($"O:{_user.Value}D:P(A;;GA;;;{_user.Value})(A;;GA;;;SY)", 1, out var descriptor, out _))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            // PIPE_REJECT_REMOTE_CLIENTS is independent of the protected DACL.
            var handle = CreateNamedPipe(endpoint, 0x00000003u | 0x40000000u | (first ? 0x00080000u : 0u), 0x00000008,
                (uint)maximum, InternalLimit, InternalLimit, 0, ref security);
            if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new System.ComponentModel.Win32Exception(error); }
            return new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
        }
        finally { LocalFree(descriptor); }
    }
}
