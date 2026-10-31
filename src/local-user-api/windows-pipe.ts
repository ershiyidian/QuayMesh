import {spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio} from "node:child_process";
import {win32} from "node:path";
import {Duplex} from "node:stream";

type PipeFailureCode = "LOCAL_API_ENDPOINT_UNSAFE" | "LOCAL_API_CONNECTION_FAILED" | "LOCAL_API_UNAVAILABLE";
const failure = (code: PipeFailureCode) => Object.assign(new Error(code), {code});
const endpointPattern = /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/;
const readyLine = "QM_PIPE_READY";
const errorPrefix = "QM_PIPE_ERROR ";

/** Fixed C# 5 helper: it never accepts a user-selected executable, expected SID,
 * PID or authentication method. Only the pipe endpoint is read before the
 * connected server process has been authenticated as this Windows user. */
export const WINDOWS_LOCAL_PIPE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

public static class QuayMeshVerifiedLocalPipe {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverProcessId);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, uint length, out uint needed);

  static string Header(Stream input) {
    using (var bytes = new MemoryStream()) {
      while (bytes.Length < 512) {
        int value = input.ReadByte();
        if (value < 0) throw new IOException();
        if (value == 10) return new UTF8Encoding(false, true).GetString(bytes.ToArray());
        bytes.WriteByte((byte)value);
      }
    }
    throw new IOException();
  }

  static IntPtr VerifyServer(NamedPipeClientStream pipe) {
    uint pid, secondPid;
    IntPtr process = IntPtr.Zero, token = IntPtr.Zero, information = IntPtr.Zero;
    bool accepted = false;
    try {
      if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid) || pid == 0)
        throw new UnauthorizedAccessException();
      // Hold this exact process object until the pipe is closed. The SID check
      // applies to the already-connected server; there is no preflight/reopen.
      process = OpenProcess(0x00100000 | 0x00001000, false, pid);
      if (process == IntPtr.Zero || WaitForSingleObject(process, 0) != 258
          || !OpenProcessToken(process, 0x0008, out token)) throw new UnauthorizedAccessException();
      uint size;
      GetTokenInformation(token, 1, IntPtr.Zero, 0, out size);
      if (size == 0 || size > 65536) throw new UnauthorizedAccessException();
      information = Marshal.AllocHGlobal((int)size);
      if (!GetTokenInformation(token, 1, information, size, out size)) throw new UnauthorizedAccessException();
      var serverSid = new SecurityIdentifier(Marshal.ReadIntPtr(information));
      using (var current = WindowsIdentity.GetCurrent()) {
        if (current.User == null || !serverSid.Equals(current.User)) throw new UnauthorizedAccessException();
      }
      if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out secondPid)
          || secondPid != pid || WaitForSingleObject(process, 0) != 258) throw new UnauthorizedAccessException();
      accepted = true;
      return process;
    } finally {
      if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (!accepted && process != IntPtr.Zero) CloseHandle(process);
    }
  }

  static async Task Pump(Stream input, Stream output) {
    var buffer = new byte[8192];
    int count;
    while ((count = await input.ReadAsync(buffer, 0, buffer.Length)) != 0) {
      await output.WriteAsync(buffer, 0, count);
      await output.FlushAsync();
    }
  }

  public static int Run() {
    IntPtr serverProcess = IntPtr.Zero;
    NamedPipeClientStream pipe = null;
    try {
      Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
      string endpoint = Header(input);
      if (!Regex.IsMatch(endpoint, @"\A\\\\\.\\pipe\\[A-Za-z0-9._-]+\z")) throw new UnauthorizedAccessException();
      pipe = new NamedPipeClientStream(".", endpoint.Substring(9), PipeDirection.InOut,
        PipeOptions.Asynchronous, TokenImpersonationLevel.Anonymous);
      pipe.Connect(5000);
      serverProcess = VerifyServer(pipe);
      Console.Error.WriteLine("QM_PIPE_READY"); Console.Error.Flush();
      // stdin contains no application frame before the verified READY signal.
      // Both directions stream bounded buffers without accumulating a watch.
      Task upstream = Pump(input, pipe), downstream = Pump(pipe, output);
      Task.WhenAny(upstream, downstream).GetAwaiter().GetResult().GetAwaiter().GetResult();
      return 0;
    } catch (UnauthorizedAccessException) {
      Console.Error.WriteLine("QM_PIPE_ERROR LOCAL_API_ENDPOINT_UNSAFE"); return 1;
    } catch {
      Console.Error.WriteLine("QM_PIPE_ERROR LOCAL_API_CONNECTION_FAILED"); return 1;
    } finally {
      if (pipe != null) pipe.Dispose();
      if (serverProcess != IntPtr.Zero) CloseHandle(serverProcess);
    }
  }
}
'@
  $result = [QuayMeshVerifiedLocalPipe]::Run()
  exit $result
} catch {
  [Console]::Error.WriteLine('QM_PIPE_ERROR LOCAL_API_UNAVAILABLE')
  exit 1
}
`;

export interface WindowsLocalPipeOptions {
  env?: NodeJS.ProcessEnv;
  /** Test-only process boundary; production always uses the fixed helper. */
  spawn?: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}

/** A transparent Duplex whose connect event means the same open pipe's server
 * SID was verified. Early writes stay in this process until that event. */
export function createWindowsLocalPipe(endpoint: string, options: WindowsLocalPipeOptions = {}): Duplex {
  if (typeof endpoint !== "string" || endpoint.length > 500 || !endpointPattern.test(endpoint)) throw failure("LOCAL_API_ENDPOINT_UNSAFE");
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key, value]) =>
    value !== undefined && !/^QUAYMESH_/i.test(key) && !/^(NODE_OPTIONS|NODE_PATH)$/i.test(key)));
  const program = win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_LOCAL_PIPE_SCRIPT, "utf16le").toString("base64")];
  const child = (options.spawn ?? ((file, argv, settings) => spawn(file, argv, {...settings, stdio: ["pipe", "pipe", "pipe"]})))(program, args,
    {env, windowsHide: true});
  let ready = false, controls = "", pending: {bytes: Buffer; callback: (error?: Error | null) => void} | undefined;
  let startupTimer: ReturnType<typeof setTimeout>;
  const send = (bytes: Buffer, callback: (error?: Error | null) => void) => {
    child.stdin.write(bytes, error => callback(error ? failure("LOCAL_API_CONNECTION_FAILED") : undefined));
  };
  const stream = new Duplex({
    allowHalfOpen: false,
    read() {child.stdout.resume();},
    write(bytes: Buffer, _encoding, callback) {
      if (ready) send(bytes, callback);
      else pending = {bytes, callback};
    },
    final(callback) {child.stdin.end(callback);},
    destroy(error, callback) {
      clearTimeout(startupTimer);
      if (pending) {const waiting = pending; pending = undefined; waiting.callback(error ?? failure("LOCAL_API_CONNECTION_FAILED"));}
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (child.exitCode === null && !child.killed) child.kill();
      callback(error);
    },
  });
  const stop = (code: PipeFailureCode) => {if (!stream.destroyed) stream.destroy(failure(code));};
  startupTimer = setTimeout(() => stop("LOCAL_API_UNAVAILABLE"), 10_000);
  child.once("error", () => stop("LOCAL_API_UNAVAILABLE"));
  child.stdin.on("error", () => stop("LOCAL_API_CONNECTION_FAILED"));
  child.stdout.on("error", () => stop("LOCAL_API_CONNECTION_FAILED"));
  child.stderr.on("error", () => stop("LOCAL_API_UNAVAILABLE"));
  child.stdout.on("data", (bytes: Buffer) => {
    if (!ready) {stop("LOCAL_API_ENDPOINT_UNSAFE"); return;}
    if (!stream.push(bytes)) child.stdout.pause();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    controls += text;
    if (controls.length > 4096) {stop("LOCAL_API_UNAVAILABLE"); return;}
    let end: number;
    while ((end = controls.indexOf("\n")) >= 0) {
      const line = controls.slice(0, end).replace(/\r$/, ""); controls = controls.slice(end + 1);
      if (line === readyLine && !ready) {
        ready = true; clearTimeout(startupTimer); stream.emit("connect");
        if (pending) {const waiting = pending; pending = undefined; send(waiting.bytes, waiting.callback);}
      } else if (line.startsWith(errorPrefix)) {
        const code = line.slice(errorPrefix.length);
        stop(code === "LOCAL_API_ENDPOINT_UNSAFE" || code === "LOCAL_API_CONNECTION_FAILED" ? code : "LOCAL_API_UNAVAILABLE");
      } else stop("LOCAL_API_UNAVAILABLE");
    }
  });
  child.once("close", code => {
    clearTimeout(startupTimer);
    if (!stream.destroyed) {if (code !== 0 || !ready) stop("LOCAL_API_CONNECTION_FAILED"); else stream.push(null);}
  });
  // Only a non-secret local endpoint reaches the helper before verification.
  child.stdin.write(endpoint + "\n", error => {if (error) stop("LOCAL_API_CONNECTION_FAILED");});
  return stream;
}
