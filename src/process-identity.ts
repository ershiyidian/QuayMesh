import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import koffi from "koffi";
import { pidAlive } from "./process-liveness.js";

const windows = process.platform === "win32" ? (() => {
  const kernel = koffi.load("kernel32.dll");
  return {
    open: kernel.func("void * __stdcall OpenProcess(uint32, int, uint32)"),
    times: kernel.func("int __stdcall GetProcessTimes(void *, void *, void *, void *, void *)"),
    close: kernel.func("int __stdcall CloseHandle(void *)"),
  };
})() : undefined;

// PID 会被系统复用；启动身份用于区分同一个 PID 的不同进程。
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return ticks && boot ? `linux:${boot}:${ticks}` : null;
    }
    if (windows) {
      const handle = windows.open(0x1000, 0, pid);
      if (!handle) return null;
      try {
        const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
        return windows.times(handle, created, exited, kernel, user)
          ? `win32:${created.readBigUInt64LE()}` : null;
      } finally { windows.close(handle); }
    }
  } catch { /* 权限不足时保留占用，等待明确的结束证据。 */ }
  return null;
}

export const processOwner = Object.freeze({
  token: randomUUID(), pid: process.pid, start: processStartIdentity(process.pid),
});

export function processOwnerAlive(owner: {owner_pid: number; process_start: string | null}): boolean {
  if (!pidAlive(owner.owner_pid)) return false;
  const current = processStartIdentity(owner.owner_pid);
  return owner.process_start === null || current === null || owner.process_start === current;
}
