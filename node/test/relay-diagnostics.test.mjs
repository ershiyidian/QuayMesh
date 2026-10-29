import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { McpRelay } from "../relay.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha = value => createHash("sha256").update(value).digest("hex");
const secret = "PRIVATE_RELAY_MARKER_body_token_query_error";
const fakeTrace = "11111111-1111-4111-8111-111111111111";
const timeout = { timeout: 10000 };

async function waitUntil(predicate, label, limit = 2000) {
  const deadline = performance.now() + limit;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, handler, options = {}) {
  const events = [], failures = [], requests = [], responses = [];
  let successes = 0;
  const origin = http.createServer((req, res) => {
    requests.push(req); responses.push(res);
    Promise.resolve(handler(req, res)).catch(error => res.destroy(error));
  });
  origin.listen(0, "127.0.0.1"); await once(origin, "listening");
  let relay;
  t.after(async () => {
    await relay?.close();
    const closed = new Promise(resolve => origin.close(resolve));
    origin.closeAllConnections();
    await closed;
  });
  relay = await new McpRelay({ origin: `http://127.0.0.1:${origin.address().port}`, port: 0,
    onError: error => failures.push(error), onSuccess: () => { successes++; },
    ...options,
    onExchange(event, fields) {
      events.push({ event, nodeId: "fixture-node", ...fields });
      return options.onExchange?.(event, fields);
    },
  }).start();
  const relayResponses = [];
  relay.server.on("request", (_req, res) => relayResponses.push(res));
  return { relay, origin, events, failures, requests, responses, relayResponses, get successes() { return successes; } };
}

function requestResult(f, { path = "/mcp", method = "POST", headers = {}, body = "{}", onResponse } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, response;
    const chunks = [];
    const call = http.request({ host: "127.0.0.1", port: f.relay.port, path, method, agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, incoming => {
      response = incoming;
      incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
      incoming.once("error", () => {});
      incoming.once("end", finish); incoming.once("close", finish);
      onResponse?.(incoming, call);
    });
    const timer = setTimeout(() => {
      const error = new Error("TEST_REQUEST_TIMEOUT");
      call.destroy(error); response?.destroy(error); reject(error);
    }, 5000);
    function finish(error) {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ status: response?.statusCode ?? null, headers: response?.headers ?? {}, body: Buffer.concat(chunks),
        complete: response?.complete ?? false, errorCode: error?.code });
    }
    call.once("error", finish);
    call.end(body);
  });
}

async function terminal(f, count = 1) {
  await waitUntil(() => f.events.filter(row => row.event === "mcp_relay_finished").length === count, "one relay terminal event");
  assert.equal(f.events.length, count * 2, "fixed started/finished event budget");
  for (let index = 0; index < count; index++) {
    const [start, finish] = f.events.slice(index * 2, index * 2 + 2);
    assert.equal(start.event, "mcp_relay_started"); assert.equal(finish.event, "mcp_relay_finished");
    assert.match(start.relayTraceId, uuid); assert.equal(finish.relayTraceId, start.relayTraceId);
    assert.equal(finish.hostAcknowledgment, "unknown");
    assert.ok(Number.isFinite(Date.parse(start.ts)) && Number.isFinite(Date.parse(finish.ts)));
    assert.equal(Object.hasOwn(finish, "connectionId"), false);
  }
  assert.equal(JSON.stringify(f.events).includes(secret), false, "no body/header/query/raw error enters diagnostics");
  await waitUntil(() => f.relay.activeRequests === 0 && f.relay.requests.size === 0, "request lifecycle was released");
  return f.events.at(-1);
}

function assertComplete(row, body) {
  assert.equal(row.upstreamRequestCreated, true); assert.equal(row.httpStatus, 200); assert.equal(row.upstreamStatus, 200);
  assert.equal(row.upstreamComplete, true); assert.equal(row.upstreamReadableEnded, true); assert.equal(row.upstreamAborted, false);
  assert.equal(row.downstreamFinished, true); assert.equal(row.requestAborted, false); assert.equal(row.phase, "completed");
  assert.equal(row.upstreamBodyBytes, body.length); assert.equal(row.upstreamBodySha256, sha(body));
  assert.ok(row.upstreamHeadersMs >= 0 && row.firstResponseByteMs >= 0);
}

test("real HTTP JSON and SSE preserve wire bytes and overwrite untrusted relay correlation", timeout, async t => {
  const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 42, result: { value: secret, operation_id: "op_abcdef123456" } }));
  let next = response, format = "application/json";
  const inputBodies = [];
  const f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    inputBodies.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": format, "x-private-response": secret });
    res.write(next.subarray(0, 7)); res.end(next.subarray(7));
  });
  const input = JSON.stringify({ method: "tools/call", params: { name: "read", arguments: { value: secret, operation_key: secret } } });
  for (let index = 0; index < 2; index++) {
    if (index) { next = Buffer.from(`: alive\n\nevent: message\ndata: ${response}\n\n`); format = "text/event-stream; charset=utf-8"; }
    const result = await requestResult(f, { path: `${index ? "/mcp/" : "/mcp"}?private=${secret}`, body: input,
      headers: { authorization: `Bearer ${secret}`, cookie: `private=${secret}`, "x-private": secret,
        "x-quaymesh-relay-trace": fakeTrace, connection: "keep-alive, x-quaymesh-relay-trace" } });
    assert.equal(result.status, 200); assert.equal(result.complete, true); assert.deepEqual(result.body, next);
    assert.equal(result.headers["x-private-response"], secret, "diagnostics do not rewrite response headers");
    const row = await terminal(f, index + 1); assertComplete(row, next);
    assert.equal(row.responseFormat, index ? "sse" : "json"); assert.equal(row.contentEncoding, "identity");
    assert.equal(f.requests[index].headers["x-quaymesh-relay-trace"], row.relayTraceId);
    assert.notEqual(row.relayTraceId, fakeTrace);
    assert.equal(f.requests[index].headers.authorization, `Bearer ${secret}`);
    assert.equal(inputBodies[index], input);
  }
  assert.notEqual(f.events[0].relayTraceId, f.events[2].relayTraceId);
  assert.equal(f.successes, 2); assert.equal(f.failures.length, 0);
  t.diagnostic(JSON.stringify({ measurement: "relay_json_sse_log_bytes", responseBytes: [response.length, next.length],
    jsonLinesBytes: [0, 2].map(index => Buffer.byteLength(f.events.slice(index, index + 2).map(row => JSON.stringify(row) + "\n").join(""))) }));
});

test("real slow reader preserves backpressure and the full response with bounded diagnostic size", timeout, async t => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
  payload.write("last-byte-proof", payload.length - 15);
  let writeBackpressure = 0, incoming;
  const f = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
    for (let offset = 0; offset < payload.length; offset += 65536) {
      if (!res.write(payload.subarray(offset, offset + 65536))) { writeBackpressure++; await once(res, "drain"); }
    }
    res.end();
  });
  const pending = requestResult(f, { onResponse(response) { incoming = response; response.pause(); } });
  await waitUntil(() => incoming && f.relayResponses[0]?.writableLength > 0, "actual relay output remains buffered while client is paused");
  const buffered = f.relayResponses[0].writableLength;
  assert.equal(f.relayResponses[0].writableFinished, false); assert.ok(writeBackpressure > 0);
  incoming.resume();
  const result = await pending;
  assert.equal(result.complete, true); assert.equal(result.body.length, payload.length); assert.equal(sha(result.body), sha(payload));
  const row = await terminal(f); assertComplete(row, payload);
  const bytes = Buffer.byteLength(f.events.map(event => JSON.stringify(event) + "\n").join(""));
  assert.ok(bytes < 2048, "large response does not enlarge diagnostic payload");
  t.diagnostic(JSON.stringify({ measurement: "relay_backpressure", responseBytes: payload.length,
    bufferedBytesObserved: buffered, upstreamWriteBackpressureCount: writeBackpressure, jsonLinesBytes: bytes }));
});

test("real incomplete upstream SSE logs partial bytes once and keeps existing abort behavior", timeout, async t => {
  const partial = Buffer.from(": started\n\n");
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write(partial);
    const timer = setTimeout(() => res.destroy(Object.assign(new Error(secret), { code: secret })), 30);
    res.once("close", () => clearTimeout(timer));
  });
  const result = await requestResult(f);
  assert.equal(result.complete, false);
  const row = await terminal(f);
  assert.equal(row.upstreamComplete, false); assert.equal(row.upstreamAborted, true); assert.equal(row.downstreamFinished, false);
  assert.equal(row.upstreamBodyBytes, partial.length); assert.equal(row.upstreamBodySha256, sha(partial));
  assert.ok(["upstream_incomplete", "upstream_response"].includes(row.phase));
  assert.equal(f.successes, 0);
});

test("real downstream cancellation closes the upstream stream and produces one terminal record", timeout, async t => {
  let upstreamClosed = false;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": start\n\n");
    const timer = setInterval(() => res.write(": alive\n\n"), 10);
    res.once("close", () => { clearInterval(timer); upstreamClosed = true; });
  });
  const result = await requestResult(f, { onResponse(response) { response.once("data", () => response.destroy()); } });
  assert.equal(result.complete, false);
  const row = await terminal(f);
  await waitUntil(() => upstreamClosed, "cancel propagates to origin");
  assert.equal(row.downstreamFinished, false); assert.equal(row.phase, "downstream_closed");
  assert.equal(row.requestAborted, false, "normal completed upload is not misclassified as request abort");
  assert.equal(f.successes, 0);
});

test("aborted partial upload is distinguished from a normal request EOF", timeout, async t => {
  const f = await fixture(t, (req, _res) => { req.resume(); });
  const call = http.request({ host: "127.0.0.1", port: f.relay.port, path: "/mcp", method: "POST", agent: false,
    headers: { "content-length": 1000000 } });
  call.on("error", () => {});
  call.write("partial");
  t.after(() => call.destroy());
  await waitUntil(() => f.requests.length === 1, "partial upload reached real upstream");
  call.destroy();
  const row = await terminal(f);
  assert.equal(row.requestAborted, true); assert.equal(row.downstreamFinished, false); assert.equal(row.phase, "request_aborted");
  assert.equal(row.upstreamStatus, null); assert.equal(row.upstreamBodyBytes, 0);
});

test("maintenance rejections are visible without an upstream dispatch or extra events", timeout, async t => {
  const f = await fixture(t, (_req, res) => res.end("unexpected"));
  f.relay.setAccepting(false);
  for (const [index, headers] of [{}, { authorization: `Bearer ${secret}` }].entries()) {
    const result = await requestResult(f, { headers });
    assert.equal(result.status, index ? 503 : 401);
    const row = await terminal(f, index + 1);
    assert.equal(row.upstreamRequestCreated, false); assert.equal(row.upstreamStatus, null); assert.equal(row.upstreamComplete, null);
    assert.equal(row.downstreamFinished, true); assert.equal(row.phase, "local_admission"); assert.equal(row.upstreamBodyBytes, 0);
  }
  assert.equal(f.requests.length, 0); assert.equal(f.failures.length, 0);
});

test("diagnostic exceptions and rejected callbacks never change the real HTTP result", timeout, async t => {
  const body = Buffer.from('{"ok":true}');
  for (const onExchange of [() => { throw new Error(secret); }, async () => { throw new Error(secret); }]) {
    const f = await fixture(t, (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(body), { onExchange });
    const result = await requestResult(f); assert.deepEqual(result.body, body); assert.equal(result.complete, true);
    assertComplete(await terminal(f), body);
  }
});

test("existing final-result deadline is diagnosed without an additional timer or retry", timeout, async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": start\n\n");
    const timer = setInterval(() => res.write(": alive\n\n"), 10);
    res.once("close", () => clearInterval(timer));
  }, { mcpResponseTimeoutMs: 100 });
  const result = await requestResult(f); assert.equal(result.complete, false);
  const row = await terminal(f);
  assert.equal(row.phase, "final_result_timeout"); assert.equal(row.errorCode, "MCP_RESPONSE_TIMEOUT");
  assert.equal(f.requests.length, 1); assert.equal(f.failures[0]?.code, "MCP_RESPONSE_TIMEOUT"); assert.equal(f.successes, 0);
});

test("diagnostics only cover exact MCP POST paths and exclude other request surfaces", timeout, async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  for (const options of [{ method: "GET", path: "/mcp" }, { path: "/token" }, { path: "/mcp/extra" }]) {
    const result = await requestResult(f, options); assert.equal(result.status, 200); assert.equal(result.complete, true);
  }
  assert.deepEqual(f.events, []);
});
