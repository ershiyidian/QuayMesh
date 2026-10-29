import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { traceMcpRequest } from "./mcp-request-diagnostics.js";

type Row = { event: string; fields: Record<string, unknown> };
const relayTrace = "12345678-1234-4234-8234-123456789abc";
const privateValue = "PRIVATE_CORE_RELAY_BODY_HEADER_QUERY";
const operationId = "op_abcdef123456", taskId = "task_abcdef123456";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(t: TestContext, relayRows?: Row[]) {
  let sequence = 0;
  let pending: { authenticated: boolean; rows: Row[]; requestId: string } | undefined;
  const wire = JSON.stringify({ jsonrpc: "2.0", id: 0, result: {
    content: [{ type: "text", text: privateValue }], structuredContent: { task_id: taskId, operation_id: operationId },
  } });
  const server = createServer((req, res) => {
    void (async () => {
      const current = pending; pending = undefined; assert.ok(current);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const traced = Object.assign(req, { body: JSON.parse(Buffer.concat(chunks).toString()),
        ...(current.authenticated ? { auth: { token: privateValue, clientId: "fixture-client", scopes: [], extra: { owner_id: privateValue } } } : {}),
      });
      const observer = traceMcpRequest(traced as unknown as Parameters<typeof traceMcpRequest>[0],
        res as unknown as Parameters<typeof traceMcpRequest>[1], current.requestId,
        (event, fields) => current.rows.push({ event, fields }));
      observer.authenticated();
      res.setHeader("content-type", "application/json"); res.writeHead(200);
      res.write(wire.slice(0, 9)); res.end(wire.slice(9));
    })().catch(error => res.destroy(error));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
  });
  let port = (server.address() as AddressInfo).port;
  if (relayRows) {
    const { McpRelay } = await import(new URL("../node/relay.mjs", import.meta.url).href);
    const relay = await new McpRelay({ origin: `http://127.0.0.1:${port}`, port: 0,
      onExchange: (event: string, fields: Record<string, unknown>) => relayRows.push({ event, fields }),
    }).start();
    t.after(() => relay.close()); port = relay.port;
  }
  return async (header: string | string[] | undefined, authenticated = true) => {
    const rows: Row[] = [], requestId = `http-fixture-${++sequence}`;
    pending = { authenticated, rows, requestId };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: {
      name: "task_resume", arguments: { action: "inspect", task_id: taskId, private: privateValue },
    } });
    const result = await new Promise<{ status: number; wire: string }>((resolve, reject) => {
      const call = request({ host: "127.0.0.1", port, path: `/mcp?private=${privateValue}`, method: "POST", agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${privateValue}`,
          ...(header === undefined ? {} : { "x-quaymesh-relay-trace": header }) } }, response => {
        const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode!, wire: Buffer.concat(chunks).toString() }));
      });
      call.setTimeout(3000, () => call.destroy(new Error("TEST_HTTP_TIMEOUT")));
      call.once("error", reject); call.end(body);
    });
    assert.equal(result.status, 200); assert.equal(result.wire, wire);
    assert.equal(rows.at(-1)?.fields.responseSha256, sha(wire));
    assert.equal(rows.at(-1)?.fields.responseBytes, Buffer.byteLength(wire));
    assert.equal(rows.at(-1)?.fields.operationId, operationId);
    assert.equal(rows.at(-1)?.fields.hostAcknowledgment, "unknown");
    assert.equal(JSON.stringify(rows).includes(privateValue), false);
    for (const row of rows) assert.equal(row.fields.requestId, requestId, "Relay correlation never replaces Core HTTP identity");
    return { rows, requestId, wire };
  };
}

test("real HTTP Core diagnostics correlate a Relay UUID without changing request, Task or operation identity", { timeout: 10000 }, async t => {
  const exchange = await fixture(t);
  const result = await exchange(relayTrace.toUpperCase());
  assert.deepEqual(result.rows.map(row => row.event), ["mcp_exchange_started", "mcp_exchange_authenticated", "mcp_exchange_finished"]);
  for (const { fields } of result.rows) {
    assert.equal(fields.relayTraceId, relayTrace); assert.notEqual(fields.requestId, fields.relayTraceId);
    assert.equal(fields.taskId, taskId); assert.equal(fields.tool, "task_resume"); assert.equal(fields.action, "inspect");
  }
  assert.equal(result.rows.at(-1)?.fields.ownerHash, sha(privateValue));
});

test("actual Relay and Core HTTP hops share the generated trace and exact response digest", { timeout: 10000 }, async t => {
  const relayRows: Row[] = [];
  const exchange = await fixture(t, relayRows);
  const result = await exchange(relayTrace);
  assert.deepEqual(relayRows.map(row => row.event), ["mcp_relay_started", "mcp_relay_finished"]);
  const id = relayRows[0].fields.relayTraceId;
  assert.notEqual(id, relayTrace, "Relay replaces the caller's otherwise well-formed UUID");
  for (const { fields } of result.rows) assert.equal(fields.relayTraceId, id);
  const core = result.rows.at(-1)!.fields, relay = relayRows.at(-1)!.fields;
  assert.equal(core.responseBytes, relay.upstreamBodyBytes);
  assert.equal(core.responseSha256, relay.upstreamBodySha256);
  assert.equal(relay.downstreamFinished, true);
  assert.equal(relay.hostAcknowledgment, "unknown");
});

test("invalid or duplicate Relay headers are omitted without echoing arbitrary caller data", { timeout: 10000 }, async t => {
  const exchange = await fixture(t);
  for (const header of [undefined, privateValue, `${relayTrace},${relayTrace}`,
    [relayTrace, relayTrace], "12345678-1234-1234-8234-123456789abc", privateValue.repeat(100)]) {
    const result = await exchange(header);
    assert.equal(result.rows.length, 3);
    for (const { fields } of result.rows) assert.equal(Object.hasOwn(fields, "relayTraceId"), false);
  }
});

test("a valid Relay trace and Bearer header do not manufacture authenticated state", { timeout: 10000 }, async t => {
  const exchange = await fixture(t);
  const result = await exchange(relayTrace, false);
  assert.deepEqual(result.rows.map(row => row.event), ["mcp_exchange_started", "mcp_exchange_finished"]);
  assert.equal(result.rows[0].fields.relayTraceId, relayTrace);
  for (const { fields } of result.rows) assert.equal(Object.hasOwn(fields, "ownerHash"), false);
});

test("Core correlation adds only one fixed field per existing event and no extra events", { timeout: 10000 }, async t => {
  const exchange = await fixture(t);
  const result = await exchange(relayTrace);
  const additionalBytes = result.rows.reduce((sum, row) => {
    const withoutTrace = { ...row.fields }; delete withoutTrace.relayTraceId;
    return sum + Buffer.byteLength(JSON.stringify(row.fields)) - Buffer.byteLength(JSON.stringify(withoutTrace));
  }, 0);
  assert.equal(result.rows.length, 3); assert.ok(additionalBytes <= 180);
  t.diagnostic(JSON.stringify({ measurement: "core_relay_trace_metadata", existingEvents: result.rows.length, additionalJsonBytes: additionalBytes }));
});
