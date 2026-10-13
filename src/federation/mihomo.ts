import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import type { FederationConfig } from "./types.js";
import { expandHomePath } from "../roots.js";
export async function resolveMihomoProxy(config: FederationConfig): Promise<string> {
  if (!config.egress.mihomoConfig) return config.egress.proxyUrl;
  const source = parse(await readFile(resolve(expandHomePath(config.egress.mihomoConfig)), "utf8"));
  const port = source?.["mixed-port"] || source?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("mihomo 配置需要 mixed-port 或 HTTP port");
  const proxy = new URL(config.egress.proxyUrl); proxy.port = String(port);
  return proxy.href;
}
export async function importMihomoConfig(config: FederationConfig, text: string, reload: boolean): Promise<unknown> {
  const source = parse(text);
  const port = source?.["mixed-port"] || source?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("请选择包含有效 mixed-port/port 的 mihomo config.yaml");
  if (!config.egress.mihomoConfig) throw new Error("请先设置该节点的 mihomo 配置文件路径");
  const file = resolve(expandHomePath(config.egress.mihomoConfig));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + ".quaymesh.tmp", text, { mode: 0o600 }); await rename(file + ".quaymesh.tmp", file);
  if (reload) {
    const base = config.egress.controllerUrl ?? (source["external-controller"] ? `http://${source["external-controller"]}` : undefined);
    if (!base) return { saved: true, reloaded: false, note: "文件已同步；请在 mihomo 中重载配置。" };
    const secret = process.env[config.egress.controllerSecretEnv] ?? source.secret;
    try {
      const controller = new URL(base);
      if (controller.hostname === "0.0.0.0" || controller.hostname === "[::]") controller.hostname = "127.0.0.1";
      const response = await fetch(new URL("/configs?force=true", controller), { method: "PUT", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ path: file }) });
      if (!response.ok) return { saved: true, reloaded: false, note: `文件已同步；mihomo 重载返回 HTTP ${response.status}。` };
      return { saved: true, reloaded: true };
    } catch (error) {
      return { saved: true, reloaded: false, note: `文件已同步；mihomo 重载失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { saved: true, reloaded: false };
}
