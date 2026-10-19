import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { createModernMcpServerAdapter } from "./mcp-modern-server.js";
import { primeMcpSseResponse } from "./mcp-sse-response.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function call(port: number, label: string) {
  const started = performance.now();
  const observation = { label, status: 0, firstByteMs: Infinity, durationMs: 0, body: "", error: "" };
  const first = gate();
  let finish!: () => void;
  const done = new Promise<typeof observation>(resolve => {
    finish = () => { observation.durationMs = performance.now() - started; resolve(observation); first.resolve(); };
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: label, method: "tools/call", params: {
    name: "probe", arguments: { label }, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  } });
  const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false, headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "probe",
    "content-length": Buffer.byteLength(body),
  } }, response => {
    observation.status = response.statusCode ?? 0;
    response.on("data", (chunk: Buffer) => {
      if (!Number.isFinite(observation.firstByteMs)) {
        observation.firstByteMs = performance.now() - started;
        first.resolve();
      }
      observation.body += chunk.toString("utf8");
    });
    response.on("end", finish);
    response.on("error", error => { observation.error = error.message; finish(); });
  });
  req.on("error", error => { observation.error = error.message; finish(); });
  req.setTimeout(8_000, () => req.destroy(new Error("test request timeout")));
  req.end(body);
  return { observation, first: first.promise, done, abort: () => req.destroy() };
}

async function fixture(t: TestContext, extraResponse?: (request: Request) => Response | undefined) {
  const blocked = new Map<string, ReturnType<typeof gate>>();
  const completed = new Set<string>();
  const errors: Error[] = [];
  const handler = createMcpHandler(() => {
    const adapter = createModernMcpServerAdapter({ name: "sse-fixture", version: "1" });
    adapter.registrationTarget.registerTool("probe", { inputSchema: { label: z.string() } }, async ({ label }) => {
      await blocked.get(label)?.promise;
      completed.add(label);
      return { content: [{ type: "text", text: label }] };
    });
    return adapter.server;
  }, { legacy: "stateless", responseMode: "sse", keepAliveMs: 5_000, onerror: error => errors.push(error) });
  const nodeHandler = toNodeHandler({
    fetch: async (request, options) => primeMcpSseResponse(extraResponse?.(request) ?? await handler.fetch(request, options)),
  }, { onerror: error => errors.push(error) });
  const server = createServer((req, res) => { void nodeHandler(req, res); });
  const port = await listen(server);
  t.after(async () => {
    for (const waiting of blocked.values()) waiting.resolve();
    await close(server);
    await handler.close();
  });
  return { port, blocked, completed, errors };
}

async function proxy(t: TestContext, upstreamPort: number) {
  const server = createServer((incoming, outgoing) => {
    const forwarded = request({ host: "127.0.0.1", port: upstreamPort, path: incoming.url,
      method: incoming.method, headers: incoming.headers, agent: false }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      outgoing.on("close", () => { if (!outgoing.writableFinished) response.destroy(); });
    });
    forwarded.on("error", () => outgoing.destroy());
    incoming.on("aborted", () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  const port = await listen(server);
  t.after(() => close(server));
  return port;
}

for (const viaProxy of [false, true]) {
  test(`silent MCP SSE sends a comment before completion ${viaProxy ? "through a streaming proxy" : "over Node HTTP"}`, async t => {
    const server = await fixture(t);
    const port = viaProxy ? await proxy(t, server.port) : server.port;
    const waiting = gate(); server.blocked.set("silent", waiting);
    const pending = call(port, "silent");
    try {
      await pending.first;
      assert.equal(pending.observation.status, 200);
      assert.ok(pending.observation.firstByteMs < 1_000, JSON.stringify(pending.observation));
      assert.equal(pending.observation.body, ": connected\n\n");
      assert.equal(server.completed.has("silent"), false, "comment must precede actual completion");
      const quick = await Promise.all(Array.from({ length: 12 }, (_, index) => call(port, `fast-${index}`).done));
      for (const response of quick) {
        assert.equal(response.status, 200);
        assert.ok(response.durationMs < 1_000, JSON.stringify(response));
        const messages = response.body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        assert.equal(messages.length, 1, "priming must not invent a JSON-RPC notification");
        assert.equal(messages[0].id, response.label);
        assert.equal(messages[0].result.content[0].text, response.label);
      }
      waiting.resolve();
      const final = await pending.done;
      assert.match(final.body, /"text":"silent"/);
      assert.equal(server.errors.length, 0);
      t.diagnostic(JSON.stringify({ viaProxy, firstByteMs: final.firstByteMs,
        fastestCallMs: Math.min(...quick.map(row => row.durationMs)), slowestCallMs: Math.max(...quick.map(row => row.durationMs)) }));
    } finally { waiting.resolve(); pending.abort(); }
  });
}

test("a disconnected observer releases its stream while independent MCP calls complete", async t => {
  const server = await fixture(t);
  const waiting = gate(); server.blocked.set("disconnect", waiting);
  const pending = call(server.port, "disconnect");
  await pending.first;
  assert.ok(pending.observation.firstByteMs < 1_000);
  pending.abort();
  await pending.done;
  const independent = await call(server.port, "independent").done;
  assert.equal(independent.status, 200);
  assert.ok(independent.durationMs < 1_000, JSON.stringify(independent));
  waiting.resolve();
  await delay(20);
  assert.ok(server.completed.has("disconnect"), "transport closure must not fabricate cancellation of independent work");
  assert.equal(server.errors.length, 0);
});

test("a paused real HTTP consumer preserves source backpressure and forwards cancellation", async t => {
  const total = 128;
  let pulled = 0, cancellations = 0;
  const cancelled = gate();
  const chunk = new TextEncoder().encode(`: ${"x".repeat(64 * 1024)}\n\n`);
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
      if (pulled === total) controller.close();
    },
    cancel() { cancellations += 1; cancelled.resolve(); },
  }, { highWaterMark: 0 });
  const server = await fixture(t, request => new URL(request.url).pathname === "/large"
    ? new Response(source, { headers: { "content-type": "text/event-stream" } }) : undefined);
  const req = request({ host: "127.0.0.1", port: server.port, path: "/large", agent: false });
  req.on("error", () => { /* Closing the test observer may reset its socket. */ });
  t.after(() => req.destroy());
  req.end();
  const [response] = await once(req, "response");
  response.on("error", () => { /* The observer intentionally abandons this response. */ });
  response.pause();
  await delay(100);
  assert.ok(pulled > 0 && pulled < total, `paused reader eagerly consumed ${pulled}/${total} chunks`);
  const atPause = pulled;
  const quick = await Promise.all(Array.from({ length: 8 }, (_, index) => call(server.port, `while-paused-${index}`).done));
  assert.ok(quick.every(row => row.status === 200 && row.durationMs < 1_000));
  response.destroy(); req.destroy();
  await Promise.race([cancelled.promise, delay(1_000).then(() => assert.fail("source cancellation was not forwarded"))]);
  assert.equal(cancellations, 1);
  assert.equal(source.locked, false);
  t.diagnostic(JSON.stringify({ pausedAfterChunks: atPause, totalChunks: total, cancellations }));
});

test("SSE wrapper cancels a pending pull and releases the source reader", async () => {
  const entered = gate(), release = gate();
  let cancellation: unknown;
  const source = new ReadableStream<Uint8Array>({
    async pull() { entered.resolve(); await release.promise; },
    cancel(reason) { cancellation = reason; release.resolve(); },
  }, { highWaterMark: 0 });
  const reader = primeMcpSseResponse(new Response(source, { headers: { "content-type": "text/event-stream" } })).body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
  const pending = reader.read();
  await entered.promise;
  await reader.cancel("observer left");
  assert.equal((await pending).done, true);
  assert.equal(cancellation, "observer left");
  assert.equal(source.locked, false);
  reader.releaseLock();
});

test("SSE priming preserves JSON/errors, source failures, and response headers", async () => {
  const json = Response.json({ error: "denied" }, { status: 401 });
  const empty = new Response(null, { status: 202 });
  assert.equal(primeMcpSseResponse(json), json);
  assert.equal(primeMcpSseResponse(empty), empty);
  const expected = new Error("source failed");
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(expected); } }, { highWaterMark: 0 });
  const primed = primeMcpSseResponse(new Response(source, { headers: {
    "content-type": "text/event-stream; charset=utf-8", "content-length": "1",
    "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
  } }));
  assert.equal(primed.headers.has("content-length"), false);
  assert.equal(primed.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(primed.headers.get("x-accel-buffering"), "no");
  const reader = primed.body!.getReader();
  await reader.read();
  await assert.rejects(reader.read(), error => error === expected);
  assert.equal(source.locked, false);
  reader.releaseLock();
});
