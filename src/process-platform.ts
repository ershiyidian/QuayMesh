import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import koffi from "koffi";

export interface ShellCommand {
  executable: string;
  args: string[];
}

/** Describes the shell actually selected by this server, not the host terminal. */
export function executionContract(tty = false) {
  return { platform: process.platform, shell: resolveShellCommand("").executable,
    transport: tty && process.platform !== "win32" ? "pty" as const : "pipe" as const,
    ptyCapability: process.platform === "win32" ? "pipe_fallback" as const : "optional_node_pty" as const };
}
export type ExecutionContract = ReturnType<typeof executionContract>;

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean | Promise<boolean>;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => new Promise<boolean>((resolve) => {
    // 系统进程查询变慢时也不能阻塞 MCP 的事件循环。
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    let settled = false;
    const complete = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killer.kill();
      complete(false);
    }, 3000);
    timer.unref();
    killer.once("error", () => complete(false));
    killer.once("close", code => complete(code === 0));
  }),
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
  pgid?: number,
): void | Promise<void> {
  if (runtime.platform === "win32" && child.pid) {
    const termination = runtime.killWindowsTree(child.pid);
    if (typeof termination !== "boolean") {
      return termination.then(stopped => { if (!stopped) signalRoot(child, signal); });
    }
    if (termination) return;
  } else {
    const targetPgid = pgid ?? (detached && child.pid ? child.pid : undefined);
    if (targetPgid) {
      try {
        runtime.killGroup(targetPgid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
  }

  signalRoot(child, signal);
}

function signalRoot(child: KillableProcess, signal: NodeJS.Signals): void {
  try { child.kill(signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export type StdioDrainDisposition = "waiting_for_descendants" | "incomplete_output" | "reconciliation_required";

/** 根进程已经退出、管道还开着时，下一步怎么处理。 */
export function stdioDrainDisposition(descendants: number[] | null): StdioDrainDisposition {
  if (descendants === null) return "reconciliation_required";
  if (descendants.length > 0) return "waiting_for_descendants";
  return "incomplete_output";
}

/** 列出 rootPid 的全部后代。查不到进程表时返回 null，不能把 null 当成没有子进程。 */
export function listDescendantPids(rootPid: number): number[] | null {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const parents = readProcessParents();
  if (!parents) return null;
  const children = new Map<number, number[]>();
  for (const [pid, parent] of parents) {
    const list = children.get(parent);
    if (list) list.push(pid);
    else children.set(parent, [pid]);
  }
  const found: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>([rootPid]);
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    for (const child of children.get(pid) ?? []) pending.push(child);
  }
  return found;
}

function readProcessParents(): Map<number, number> | null {
  if (process.platform === "win32") return readWindowsProcessParents();
  if (process.platform === "linux") return readLinuxProcessParents();
  return null;
}

function readLinuxProcessParents(): Map<number, number> | null {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return null;
  }
  const parents = new Map<number, number>();
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      continue;
    }
    const marker = stat.lastIndexOf(")");
    if (marker < 0) continue;
    const fields = stat.slice(marker + 2).split(" ");
    const ppid = Number(fields[1]);
    if (Number.isInteger(ppid) && ppid > 0) parents.set(pid, ppid);
  }
  return parents;
}

interface WindowsProcessEntry {
  dwSize: number;
  th32ProcessID?: number;
  th32ParentProcessID?: number;
}

let windowsProcessSnapshot: {
  create: (flags: number, pid: number) => unknown;
  first: (snapshot: unknown, entry: WindowsProcessEntry) => number;
  next: (snapshot: unknown, entry: WindowsProcessEntry) => number;
  close: (handle: unknown) => number;
  size: number;
} | undefined;

function windowsSnapshotApi() {
  if (windowsProcessSnapshot) return windowsProcessSnapshot;
  const kernel32 = koffi.load("kernel32.dll");
  const entryType = koffi.struct("QuayMeshProcessEntry32W", {
    dwSize: "uint32",
    cntUsage: "uint32",
    th32ProcessID: "uint32",
    th32DefaultHeapID: "uintptr",
    th32ModuleID: "uint32",
    cntThreads: "uint32",
    th32ParentProcessID: "uint32",
    pcPriClassBase: "int32",
    dwFlags: "uint32",
    szExeFile: koffi.array("char16", 260),
  });
  windowsProcessSnapshot = {
    create: kernel32.func("void * __stdcall CreateToolhelp32Snapshot(uint32, uint32)"),
    first: kernel32.func("int __stdcall Process32FirstW(void *snapshot, _Inout_ QuayMeshProcessEntry32W *entry)"),
    next: kernel32.func("int __stdcall Process32NextW(void *snapshot, _Inout_ QuayMeshProcessEntry32W *entry)"),
    close: kernel32.func("int __stdcall CloseHandle(void *handle)"),
    size: koffi.sizeof(entryType),
  };
  return windowsProcessSnapshot;
}

function readWindowsProcessParents(): Map<number, number> | null {
  const api = windowsSnapshotApi();
  const snapshot = api.create(0x00000002, 0);
  if (snapshot === null || snapshot === undefined) return null;
  const parents = new Map<number, number>();
  try {
    const entry: WindowsProcessEntry = { dwSize: api.size };
    let more = api.first(snapshot, entry);
    if (!more) return null;
    while (more) {
      const pid = entry.th32ProcessID;
      const parent = entry.th32ParentProcessID;
      if (typeof pid === "number" && pid > 0 && typeof parent === "number" && parent > 0) parents.set(pid, parent);
      more = api.next(snapshot, entry);
    }
  } catch {
    return null;
  } finally {
    try { api.close(snapshot); } catch { /* 快照句柄关闭失败时，已经读到的表仍然可用 */ }
  }
  return parents.size > 0 ? parents : null;
}
