import { chmod, cp, readdir } from "node:fs/promises";
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

export async function verifyComponentBinaries(directory) {
  const target = resolve(directory);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const entries = await readdir(target);
  const binaries = ["easytier-core", "tunnel-client"];
  if (entries.some(name => (process.platform === "win32" ? name.toLowerCase() : name) === "easytier-cli" + suffix)) {
    binaries.push("easytier-cli");
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
    try {
      const result = await run(binary, ["--version"], {
        cwd: target, env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
      });
      versions[name] = (result.stdout || result.stderr).trim();
    } catch (error) {
      throw new Error(`发行组件无法启动：${binary}\n${error.message}`, { cause: error });
    }
  }
  return versions;
}
