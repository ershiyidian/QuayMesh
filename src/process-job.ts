import koffi from "koffi";

const pointerBytes = process.arch === "ia32" ? 4 : 8;
const api = process.platform === "win32" ? (() => {
  const kernel = koffi.load("kernel32.dll");
  const basic = koffi.struct("QuayMeshJobBasicLimits", {
    PerProcessUserTimeLimit: "int64", PerJobUserTimeLimit: "int64", LimitFlags: "uint32",
    MinimumWorkingSetSize: "size_t", MaximumWorkingSetSize: "size_t", ActiveProcessLimit: "uint32",
    Affinity: "uintptr", PriorityClass: "uint32", SchedulingClass: "uint32",
  });
  const io = koffi.struct("QuayMeshJobIoCounters", {
    ReadOperationCount: "uint64", WriteOperationCount: "uint64", OtherOperationCount: "uint64",
    ReadTransferCount: "uint64", WriteTransferCount: "uint64", OtherTransferCount: "uint64",
  });
  const extended = koffi.struct("QuayMeshJobExtendedLimits", {
    BasicLimitInformation: basic, IoInfo: io, ProcessMemoryLimit: "size_t", JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t", PeakJobMemoryUsed: "size_t",
  });
  return {
    extended,
    create: kernel.func("void * __stdcall CreateJobObjectW(void *, const char16_t *)"),
    limits: kernel.func("int __stdcall SetInformationJobObject(void *, int, QuayMeshJobExtendedLimits *, uint32)"),
    open: kernel.func("void * __stdcall OpenProcess(uint32, int, uint32)"),
    assign: kernel.func("int __stdcall AssignProcessToJobObject(void *, void *)"),
    query: kernel.func("int __stdcall QueryInformationJobObject(void *, int, void *, uint32, void *)"),
    terminate: kernel.func("int __stdcall TerminateJobObject(void *, uint32)"),
    close: kernel.func("int __stdcall CloseHandle(void *)"),
    error: kernel.func("uint32 __stdcall GetLastError()"),
  };
})() : null;

export class WindowsCommandJob {
  private handle: unknown;
  constructor() {
    if (!api) throw new Error("Windows 作业组只在 Windows 创建");
    this.handle = api.create(null, null);
    if (!this.handle) throw new Error(`CreateJobObjectW failed: ${api.error()}`);
    const values = {
      BasicLimitInformation: { PerProcessUserTimeLimit: 0, PerJobUserTimeLimit: 0, LimitFlags: 0x2000,
        MinimumWorkingSetSize: 0, MaximumWorkingSetSize: 0, ActiveProcessLimit: 0,
        Affinity: 0, PriorityClass: 0, SchedulingClass: 0 },
      IoInfo: { ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0,
        ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0 },
      ProcessMemoryLimit: 0, JobMemoryLimit: 0, PeakProcessMemoryUsed: 0, PeakJobMemoryUsed: 0,
    };
    if (!api.limits(this.handle, 9, values, koffi.sizeof(api.extended))) {
      const code = api.error(); this.close(); throw new Error(`SetInformationJobObject failed: ${code}`);
    }
  }

  assign(pid: number): void {
    if (!api || !this.handle) throw new Error("作业组已经关闭");
    const processHandle = api.open(0x101, 0, pid);
    if (!processHandle) throw new Error(`OpenProcess failed: ${api.error()}`);
    try {
      if (!api.assign(this.handle, processHandle)) throw new Error(`AssignProcessToJobObject failed: ${api.error()}`);
    } finally { api.close(processHandle); }
  }

  alivePids(): number[] {
    if (!api || !this.handle) return [];
    let capacity = 16;
    for (;;) {
      const buffer = Buffer.alloc(8 + capacity * pointerBytes);
      if (api.query(this.handle, 3, buffer, buffer.length, null)) {
        const count = buffer.readUInt32LE(4);
        return Array.from({ length: count }, (_, i) => pointerBytes === 8
          ? Number(buffer.readBigUInt64LE(8 + i * pointerBytes)) : buffer.readUInt32LE(8 + i * pointerBytes));
      }
      const error = api.error();
      if (error !== 234) throw new Error(`QueryInformationJobObject failed: ${error}`);
      capacity = Math.max(capacity * 2, buffer.readUInt32LE(0) + 8);
    }
  }

  terminate(exitCode = 1): void {
    if (api && this.handle && !api.terminate(this.handle, exitCode)) throw new Error(`TerminateJobObject failed: ${api.error()}`);
  }

  close(): void {
    if (api && this.handle) { api.close(this.handle); this.handle = undefined; }
  }
}

const watches = new Set<() => void>();
let monitor: NodeJS.Timeout | undefined;

export function watchOwnedProcesses(check: () => void): () => void {
  watches.add(check);
  if (!monitor) {
    monitor = setInterval(() => { for (const action of [...watches]) action(); }, 250);
    monitor.unref();
  }
  return () => {
    watches.delete(check);
    if (!watches.size && monitor) { clearInterval(monitor); monitor = undefined; }
  };
}

export function processGroupAlive(pgid: number): boolean | null {
  try { process.kill(-pgid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return null;
  }
}
