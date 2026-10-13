import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import * as z from "zod/v4";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createModernMcpServerAdapter } from "./mcp-modern-server.js";
import { traceMcpRequest } from "./mcp-request-diagnostics.js";

test("real modern HTTP MCP diagnostics separate schema/tool errors from successful HTTP and omit secrets", async (t) => {
  const rows: Record<string, any>[] = [];
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({ name: "fixture", version: "1" });
    adapter.registrationTarget.registerTool("work_task", { inputSchema: { action: z.enum(["get", "snapshot", "finish"]), workspaceId: z.string() } }, async ({ action }) => ({
      isError: action === "finish", content: [{ type: "text", text: JSON.stringify(action === "finish"
        ? { code: "WORK_STATE", message: "secret-error" }
        : { workRunId: "run_abcdef", summary: "secret-response", acceptanceStatus: "pending" }) }],
    }));
    return adapter.server;
  }, { legacy: "stateless" });
  const app = express(); app.use(express.json());
  app.all("/mcp", (req, res) => { traceMcpRequest(req, res, "fixture", (event, fields) => rows.push({ event, ...fields }));
    return toNodeHandler(handler)(req, res, req.body); });
  const http = app.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(async () => { await handler.close(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  const call = async (action: string) => {
    const response = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", "mcp-method": "tools/call", "mcp-name": "work_task", "mcp-protocol-version": "2026-07-28", authorization: "Bearer secret-header" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "secret-id", method: "tools/call", params: { name: "work_task",
        arguments: { action, workspaceId: "ws_abcdef", prompt: "secret-prompt" },
        _meta: { "openai/session": "secret-session", "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } }) });
    const text = await response.text();
    const row = rows.at(-1)!;
    assert.equal(row.responseBytes, Buffer.byteLength(text));
    assert.equal(row.responseSha256, createHash("sha256").update(text).digest("hex"));
    return { response, row };
  };
  const success = await call("snapshot"); assert.equal(success.response.status, 200);
  assert.equal(success.row.receiptPresent, true); assert.equal(success.row.toolError, false);
  const failed = await call("finish"); assert.equal(failed.response.status, 200); assert.equal(failed.row.toolError, true);
  assert.equal(failed.row.toolErrorCode, "WORK_STATE"); assert(failed.row.errorFingerprint);
  const rejected = await call("unknown-secret-action");
  assert(rejected.row.rpcErrorCode || rejected.row.toolError, "Schema rejection must be visible even if no handler ran");
  assert.equal(rejected.row.action, "other");
  assert(!JSON.stringify(rows).includes("secret-"));
});

test("streamed/oversized/aborted responses and logging failures preserve HTTP semantics", async (t) => {
  const rows: Record<string, any>[] = [];
  const app = express(); app.use(express.json());
  app.post("/mcp", (req, res) => {
    traceMcpRequest(req, res, "fixture", (event, fields) => { rows.push({ event, ...fields }); if (req.body.failLogger) throw new Error("logger failure"); });
    if (req.body.mode === "abort") { res.writeHead(200); res.write("partial-secret"); res.destroy(); return; }
    if (req.body.mode === "large") { res.end("secret-".repeat(20000)); return; }
    res.setHeader("content-type", "text/event-stream");
    res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
    res.end('data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"secret-body"}]}}\n\n');
  });
  const http = app.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  for (const mode of ["sse", "large", "abort"]) {
    try { const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, failLogger: true }) }); await res.text(); }
    catch { assert.equal(mode, "abort"); }
  }
  const finished = rows.filter((row) => row.event === "mcp_exchange_finished");
  assert.equal(finished.length, 3); assert.equal(finished[0]!.resultInspection, "inspected");
  assert.equal(finished[1]!.resultInspection, "over_limit"); assert.equal(finished[1]!.responseBytes, 140000);
  assert.equal(finished[2]!.aborted, true); assert(!JSON.stringify(rows).includes("secret"));
});
