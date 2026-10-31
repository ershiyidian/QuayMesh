using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using QuayMesh.Host;

internal static class Program
{
    private static void Check(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private static string Name(string endpoint) => endpoint[@"\\.\pipe\".Length..];
    private static async Task<NamedPipeClientStream> Connect(string endpoint, string server = ".")
    {
        var pipe = new NamedPipeClientStream(server, Name(endpoint), PipeDirection.InOut, PipeOptions.Asynchronous);
        try { await pipe.ConnectAsync(1500); return pipe; } catch { pipe.Dispose(); throw; }
    }
    private static async Task Send(Stream stream, object value)
    { var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value) + "\n"); await stream.WriteAsync(bytes); await stream.FlushAsync(); }
    private static async Task<JsonElement> Read(StreamReader reader)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var line = await reader.ReadLineAsync(deadline.Token) ?? throw new IOException("Pipe closed.");
        using var document = JsonDocument.Parse(line); return document.RootElement.Clone();
    }
    private static object Request(string method) => new { protocol = "quaymesh.local-user.v1", id = "fixture",
        credential = "qml1_" + new string('x', 43), method, @params = method switch {
            "tasks.get" or "events.read" or "events.watch" => (object)new { task_id = "task-a" },
            "peer.send" => new { target_task_id = "task-b", message_key = "once", body = "你好" },
            "peer.receive" => new { request_key = "receive-once" },
            "peer.ack" => new { delivery_id = "delivery", message_ids = new[] { "message" } }, _ => new { } } };
    private static async Task Main()
    {
        var directory = Path.Combine(Path.GetTempPath(), "quaymesh-native-api-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var user = WindowsIdentity.GetCurrent().User!;
        var acl = new DirectorySecurity(); acl.SetOwner(user); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new(user, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(directory).SetAccessControl(acl);
        using var host = new LocalUserPipeServer(@"\\.\pipe\QuayMesh.LocalUser.Test." + Guid.NewGuid().ToString("N"));
        try
        {
            host.Start();
            // An invalid private key cannot register a Core or publish discovery.
            await using (var invalid = await Connect(host.InternalEndpoint))
            {
                await Send(invalid, new { protocol = "quaymesh.local-user.bridge.v1", key = "wrong", configDir = directory, nodeId = "fixture" });
                using var reader = new StreamReader(invalid, leaveOpen: true);
                try { await Read(reader); throw new InvalidOperationException("Invalid key was accepted."); } catch (IOException) { }
            }
            Check(!File.Exists(Path.Combine(directory, "local-user-api.json")), "Unverified discovery was written.");
            await using var core = await Connect(host.InternalEndpoint);
            ValidateAcl(core.SafePipeHandle, user);
            using var coreReader = new StreamReader(core, leaveOpen: true);
            await Send(core, new { protocol = "quaymesh.local-user.bridge.v1", key = host.BridgeKey, configDir = directory, nodeId = "fixture" });
            Check((await Read(coreReader)).GetProperty("kind").GetString() == "ready", "Private Core handshake failed.");
            var discovery = new FileInfo(Path.Combine(directory, "local-user-api.json")).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
            Check(discovery.AreAccessRulesProtected && Equals(discovery.GetOwner(typeof(SecurityIdentifier)), user), "Discovery is not private.");
            var methods = new ConcurrentDictionary<string, string>();
            var cancellations = new ConcurrentDictionary<string, TaskCompletionSource<bool>>();
            var seen = new ConcurrentDictionary<string, bool>();
            var reads = Task.Run(async () => {
                try {
                    for (;;) {
                        var envelope = await Read(coreReader); var kind = envelope.GetProperty("kind").GetString();
                        var connectionId = envelope.GetProperty("connectionId").GetString()!;
                        if (kind == "cancel") { if (cancellations.TryGetValue(connectionId, out var cancelled)) cancelled.TrySetResult(true); continue; }
                        Check(kind == "request", "Unexpected internal operation.");
                        var request = envelope.GetProperty("request"); var method = request.GetProperty("method").GetString()!;
                        methods[connectionId] = method; seen[method] = true;
                        if (method == "events.watch") cancellations[connectionId] = new(TaskCreationOptions.RunContinuationsAsynchronously);
                        await Send(core, new { kind = "response", connectionId, response = new { protocol = "quaymesh.local-user.v1", id = "fixture", ok = true,
                            result = new { method }, done = method != "events.watch" } });
                    }
                } catch (IOException) { } catch (OperationCanceledException) { } catch (ObjectDisposedException) { }
            });
            foreach (var method in new[] { "status.get", "tasks.list", "tasks.get", "events.read", "peer.send", "peer.receive", "peer.ack" })
            {
                await using var pipe = await Connect(host.Endpoint); ValidateAcl(pipe.SafePipeHandle, user);
                using var reader = new StreamReader(pipe, leaveOpen: true); await Send(pipe, Request(method));
                var response = await Read(reader); Check(response.GetProperty("result").GetProperty("method").GetString() == method, "Method frame changed.");
            }
            // Public disconnect cancels only the matching private Core request.
            var watch = await Connect(host.Endpoint); using (var reader = new StreamReader(watch, leaveOpen: true)) {
                await Send(watch, Request("events.watch")); Check(!(await Read(reader)).GetProperty("done").GetBoolean(), "Watch became a completed read."); }
            watch.Dispose();
            await cancellations.Single().Value.Task.WaitAsync(TimeSpan.FromSeconds(4));
            Check(seen.Count == 8, "Not all eight methods passed through.");
            // Oversize is rejected before it can become a Core request.
            var before = methods.Count;
            await using (var large = await Connect(host.Endpoint)) {
                await large.WriteAsync(Encoding.ASCII.GetBytes(new string('x', 65536) + "\n"));
                using var reader = new StreamReader(large, leaveOpen: true);
                try { Check(!(await Read(reader)).GetProperty("ok").GetBoolean(), "Oversized request succeeded."); } catch (IOException) { }
            }
            Check(methods.Count == before, "Oversized request reached Core.");
            // The network-name path must be refused even though the SID is valid.
            var remoteConnected = false;
            try { await using var remote = await Connect(host.Endpoint, Environment.MachineName); remoteConnected = true; }
            catch (IOException) { } catch (TimeoutException) { } catch (UnauthorizedAccessException) { }
            Check(!remoteConnected, "PIPE_REJECT_REMOTE_CLIENTS did not refuse network access.");
            // Core loss terminates an existing client watch without inventing data.
            await using var survivor = await Connect(host.Endpoint); using var survivorReader = new StreamReader(survivor, leaveOpen: true);
            await Send(survivor, Request("events.watch")); await Read(survivorReader); core.Dispose();
            Check(!(await Read(survivorReader)).GetProperty("ok").GetBoolean(), "Core disconnect did not close the client observation.");
            host.Stop(); await reads;
            Console.WriteLine(JsonSerializer.Serialize(new { passed = true, methods = 8, invalidKey = true, privateAcl = true,
                clientCancellation = true, coreDisconnect = true, oversizedRejected = true, networkPipeRejected = true }));
        }
        finally { host.Stop(); Directory.Delete(directory, true); }
    }
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(SafePipeHandle handle, uint type, uint info, out IntPtr owner, out IntPtr group,
        out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    private static void ValidateAcl(SafePipeHandle pipe, SecurityIdentifier user)
    {
        Check(GetSecurityInfo(pipe, 6, 5, out _, out _, out _, out _, out var descriptor) == 0, "Cannot inspect actual pipe security.");
        try {
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            var security = new RawSecurityDescriptor(bytes, 0);
            Check(security.Owner.Equals(user) && security.ControlFlags.HasFlag(ControlFlags.DiscretionaryAclProtected), "Pipe owner/DACL is unsafe.");
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            foreach (KnownAce ace in security.DiscretionaryAcl!)
                Check(ace.SecurityIdentifier.Equals(user) || ace.SecurityIdentifier.Equals(system), "Unexpected SID has pipe access.");
        } finally { LocalFree(descriptor); }
    }
}
