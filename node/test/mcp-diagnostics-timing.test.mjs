import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { traceMcpRequest } from "../../src/mcp-request-diagnostics.ts";

test("MCP 诊断记录真实响应头、首字节和最终流时长，不记录敏感数据", async t => {
  const rows = [];
  const server = createServer((req, res) => {
    req.body = { method: "tools/call", params: { name: "exec_command",
      arguments: { cmd: "sensitive-code", workspace_id: "ws_abcdef" } } };
    traceMcpRequest(req, res, "test-request", (event, fields) => rows.push({ event, ...fields }));
    res.setHeader("content-type", "text/event-stream");
    res.writeHead(200);
    res.flushHeaders();
    setTimeout(() => res.write(": ping\n\n"), 30);
    setTimeout(() => res.end('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'), 75);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`);
  assert.match(await response.text(), /result/);
  const finished = rows.find(row => row.event === "mcp_exchange_finished");
  assert.equal(finished.requestId, "test-request");
  assert.equal(finished.aborted, false);
  assert.ok(finished.responseHeadersMs < 25, JSON.stringify(finished));
  assert.ok(finished.firstResponseByteMs >= 20, JSON.stringify(finished));
  assert.ok(finished.durationMs >= 60, JSON.stringify(finished));
  assert.ok(finished.responseBytes > 30);
  assert.ok(!JSON.stringify(rows).includes("sensitive-code"));
});
