import koffi from "koffi";

const readPowerStatus = process.platform === "win32" ? (() => {
  koffi.struct("QuayMeshSystemPowerStatus", {
    ACLineStatus: "uint8_t",
    BatteryFlag: "uint8_t",
    BatteryLifePercent: "uint8_t",
    SystemStatusFlag: "uint8_t",
    BatteryLifeTime: "uint32_t",
    BatteryFullLifeTime: "uint32_t",
  });
  return koffi.load("kernel32.dll").func(
    "int __stdcall GetSystemPowerStatus(_Out_ QuayMeshSystemPowerStatus *status)",
  ) as (status: { ACLineStatus?: number }) => number;
})() : null;

export function windowsOnAcPower(): boolean {
  if (!readPowerStatus) return true;
  const status: { ACLineStatus?: number } = {};
  if (!readPowerStatus(status)) throw new Error("GetSystemPowerStatus 读取电源状态失败");
  return status.ACLineStatus === 1;
}

/**
 * A background health heartbeat must not probe an NVIDIA dGPU on a Windows
 * laptop. Even on AC power, a periodic nvidia-smi call can wake an otherwise
 * sleeping hybrid-graphics dGPU and keep it in D0.
 *
 * Workstations/desktops with no system battery still get their GPU metrics.
 * In case of an unknown battery state, prefer preserving GPU sleep.
 */
export function windowsShouldPollGpu(): boolean {
  if (process.platform !== "win32") return true;
  if (!readPowerStatus) return false;
  try {
    const status: { ACLineStatus?: number; BatteryFlag?: number; BatteryLifePercent?: number } = {};
    if (!readPowerStatus(status)) return false;
    return status.BatteryFlag === 0x80;
  } catch {
    return false;
  }
}
