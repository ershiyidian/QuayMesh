import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { createModernMcpServerAdapter } from "./mcp-modern-server.js";
import { toolErrorResult } from "./session/outcome.js";

test("SDK 客户端发现输出 schema 后接受真实 ENOENT 错误并成功重读文件", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-sdk-error-contract-"));
  const servers: McpServer[] = [];
  const responses: Response[] = [];
  const handlerErrors: Error[] = [];
  const transportErrors: Error[] = [];
  let reads = 0;
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({ name: "file-contract-test", version: "1.0.0" });
    servers.push(adapter.server);
    adapter.registrationTarget.registerTool("read_fixture", {
      inputSchema: { name: z.literal("example.txt") },
      outputSchema: z.strictObject({ result: z.string() }),
      annotations: { readOnlyHint: true },
    }, async ({ name }) => {
      reads += 1;
      try {
        const result = await readFile(join(directory, name), "utf8");
        return { content: [{ type: "text", text: result }], structuredContent: { result } };
      } catch (error) {
        return toolErrorResult(error);
      }
    });
    return adapter.server;
  }, { legacy: "stateless", onerror: (error) => handlerErrors.push(error) });
  const transport = new StreamableHTTPClientTransport(new URL("http://mcp.example.invalid/mcp"), {
    // 使用 SDK 的正式 fetch 接口，原样传递真实 Request/Response，不监听端口。
    fetch: async (url, init) => {
      const response = await handler.fetch(new Request(url, init));
      responses.push(response);
      return response;
    },
  });
  const client = new Client({ name: "file-contract-client", version: "1.0.0" });
  client.onerror = (error) => transportErrors.push(error);
  t.after(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (close: () => Promise<unknown>) => {
      try { await close(); } catch (error) { cleanupErrors.push(error); }
    };
    // client.close 关闭其 transport；请求信号中止会结束 legacy 响应流。
    await cleanup(() => client.close());
    await cleanup(() => handler.close());
    for (const server of servers) await cleanup(() => server.close());
    for (const response of responses) {
      if (response.body && !response.body.locked) await cleanup(() => response.body!.cancel());
    }
    await cleanup(() => rm(directory, { recursive: true, force: true }));
    assert.deepEqual(cleanupErrors, []);
  });

  await client.connect(transport);
  // listTools 会在官方客户端内部编译并缓存输出校验器，后续使用正常 callTool。
  const listed = await client.listTools();
  assert.ok(listed.tools.find((tool) => tool.name === "read_fixture")?.outputSchema);

  const missing = await client.callTool({ name: "read_fixture", arguments: { name: "example.txt" } });
  assert.equal(missing.isError, true);
  assert.deepEqual(missing.structuredContent, {
    error_code: "ENOENT",
    effect: "not_started",
    retry_hint: "fix_input",
  });
  assert.ok(Array.isArray(missing.content));
  assert.ok(missing.content.some((item) => item.type === "text" && item.text.includes("ENOENT")));

  const contents = "File read through the actual MCP handler.\n";
  await writeFile(join(directory, "example.txt"), contents);
  const found = await client.callTool({ name: "read_fixture", arguments: { name: "example.txt" } });
  assert.notEqual(found.isError, true);
  assert.deepEqual(found.structuredContent, { result: contents });
  assert.deepEqual(found.content, [{ type: "text", text: contents }]);
  assert.equal(reads, 2);
  assert.deepEqual(handlerErrors, []);
  assert.deepEqual(transportErrors, []);
});
