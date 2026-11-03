import { chmod, cp, readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const windowsEasyTierFiles = [
  "libgcc_s_seh-1.dll", "libwinpthread-1.dll", "Packet.dll", "WinDivert64.sys", "wintun.dll",
];

export async function copyEasyTierCompanions(binary, target, platform = process.platform) {
  const source = dirname(binary);
  const normalize = name => platform === "win32" ? name.toLowerCase() : name;
  const entries = new Map((await readdir(source)).map(name => [normalize(name), name]));
  const cli = "easytier-cli" + (platform === "win32" ? ".exe" : "");
  for (const name of [cli, ...(platform === "win32" ? windowsEasyTierFiles : [])]) {
    const entry = entries.get(normalize(name));
    if (!entry) continue;
    await cp(join(source, entry), join(target, name));
    if (platform !== "win32") await chmod(join(target, name), 0o755);
  }
}

async function binaryVersion(binary, { cwd, env = process.env } = {}) {
  try {
    const result = await run(binary, ["--version"], {
      cwd, env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
    });
    return (result.stdout || result.stderr).trim();
  } catch (error) {
    throw new Error(`发行组件无法启动：${binary}\n${error.message}`, { cause: error });
  }
}

function requireVersion(name, actual, expected) {
  if (actual.split(/\r?\n/u, 1)[0].trim() !== expected)
    throw new Error(`${name} 版本不符：期望 ${expected}，实际 ${actual.split(/\r?\n/u, 1)[0]}`);
}

export async function copyTailscaleBinaries(binary, target, version) {
  if (process.platform !== "linux") throw new Error("受管 Tailscale Funnel 目前支持 Linux");
  const source = dirname(resolve(binary));
  const binaries = { tailscaled: resolve(binary), tailscale: join(source, "tailscale") };
  // 先验证成对程序，再写入发行组件目录，避免混入不同版本的 CLI。
  for (const [name, path] of Object.entries(binaries))
    requireVersion(name, await binaryVersion(path, { cwd: source }), version);
  for (const [name, path] of Object.entries(binaries)) {
    await cp(path, join(target, name));
    await chmod(join(target, name), 0o755);
  }
}

export async function verifyComponentBinaries(directory, { tailscaleVersion } = {}) {
  const target = resolve(directory);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const entries = await readdir(target);
  const binaries = ["easytier-core", "tunnel-client"];
  if (entries.some(name => (process.platform === "win32" ? name.toLowerCase() : name) === "easytier-cli" + suffix)) {
    binaries.push("easytier-cli");
  }
  if (["tailscale", "tailscaled"].some(name => entries.includes(name + suffix))) {
    if (process.platform !== "linux") throw new Error("受管 Tailscale Funnel 目前支持 Linux");
    if (!["tailscale", "tailscaled"].every(name => entries.includes(name)))
      throw new Error("Tailscale 发行组件必须同时包含 tailscaled 和 tailscale CLI");
    tailscaleVersion ??= JSON.parse(await readFile(new URL("../components.lock.json", import.meta.url), "utf8")).tailscale.version;
    binaries.push("tailscaled", "tailscale");
  }
  const env = { ...process.env };
  if (process.platform === "win32") {
    // 排除构建工具目录，避免从编译机的 PATH 借到发行包遗漏的 DLL。
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.Path = join(process.env.SystemRoot, "System32") + ";" + process.env.SystemRoot;
  }
  const versions = {};
  for (const name of binaries) {
    const binary = join(target, name + suffix);
    versions[name] = await binaryVersion(binary, { cwd: target, env });
    if (name === "tailscale" || name === "tailscaled") requireVersion(name, versions[name], tailscaleVersion);
  }
  return versions;
}
