import process from "node:process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 使用仓库自带的 MCP SDK 完成 initialize、工具分页和资源读取。
// 这条脚本不自己解析 SSE，也不把 HTTP 200 当成协议成功。
const bundle = resolve(process.env.QUAYMESH_BUNDLE || process.cwd());
const baseUrl = process.argv[2] || process.env.QUAYMESH_MCP_URL;
if (!baseUrl) throw new Error("用法：node scripts/verify-mcp-host.mjs <MCP URL>");
const require = createRequire(join(bundle, "package.json"));
const clientModule = require.resolve("@modelcontextprotocol/sdk/client/index.js");
const transportModule = require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { Client } = await import(pathToFileURL(clientModule).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(transportModule).href);

const headers = process.env.QUAYMESH_BEARER ? { authorization: `Bearer ${process.env.QUAYMESH_BEARER}` } : {};
const client = new Client({ name: "quaymesh-verifier", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers } });
const requiredTools = ["start_session", "finish_task", "workspace_catalog", "open_workspace", "read", "exec_command", "write_stdin"];
try {
  await client.connect(transport);
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  const names = new Set(tools.map(tool => tool.name));
  const missing = requiredTools.filter(name => !names.has(name));
  if (missing.length) throw new Error(`缺少工具：${missing.join(", ")}`);
  if (tools.length === 0) throw new Error("tools/list 返回零个工具");
  for (const tool of tools) {
    if (!tool.inputSchema || typeof tool.inputSchema !== "object") throw new Error(`工具 ${tool.name} 缺少 inputSchema`);
  }
  const resources = [];
  cursor = undefined;
  do {
    const page = await client.listResources(cursor ? { cursor } : {});
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  const cardUri = tools
    .map(tool => tool._meta?.ui?.resourceUri ?? tool._meta?.["ui/resourceUri"] ?? tool._meta?.["openai/outputTemplate"])
    .find(uri => typeof uri === "string");
  let cardBytes = 0;
  if (cardUri) {
    const resource = await client.readResource({ uri: cardUri });
    const html = resource.contents.find(item => typeof item.text === "string" && item.mimeType?.includes("text/html"));
    if (!html?.text?.length) throw new Error(`卡片资源 ${cardUri} 没有返回 HTML`);
    cardBytes = Buffer.byteLength(html.text, "utf8");
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    endpointOrigin: new URL(baseUrl).origin,
    toolCount: tools.length,
    toolNames: [...names],
    resourceCount: resources.length,
    cardUri: cardUri ?? null,
    cardBytes,
    protocolReadCheck: "PASS",
  }, null, 2));
} finally {
  await client.close();
}
