import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultConfigDir, loadNodeConfig } from "../node/config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {file: {type: "string"}, config: {type: "string"}},
});
const file = resolve(values.file || resolve(root, "config/tool-annotations.json"));
const nodeConfig = resolve(values.config || resolve(defaultConfigDir(), "node.json"));
const document = JSON.parse(await readFile(file, "utf8"));
const loaded = await loadNodeConfig(nodeConfig);
const token = loaded.env[loaded.cluster.tokenEnv];
const response = await fetch(`http://127.0.0.1:${loaded.node.corePort}/internal/quaymesh/tool-annotations`, {
  method: "POST",
  headers: {"content-type": "application/json", authorization: `Bearer ${token}`},
  body: JSON.stringify(document),
  signal: AbortSignal.timeout(60_000),
});
const result = await response.json();
console.log(JSON.stringify({source:file, ...result}, null, 2));
if (!response.ok || Object.keys(result.failed || {}).length > 0) process.exitCode = 1;
