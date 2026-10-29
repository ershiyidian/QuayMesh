import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { traceMcpRequest } from "./mcp-request-diagnostics.js";
import { toolResultForTextClients } from "./mcp-tool-result.js";

const taskId = "task_abcdef123456", operationId = "qm:home:op_abcdef123456";
const secrets = {
  body: "PRIVATE_USER_BODY_请先审查日志",
  answer: "PRIVATE_ASSISTANT_REPLY_这不是完成回执",
  token: "PRIVATE_BEARER_TOKEN_abcd1234",
  owner: "PRIVATE_OWNER_person@example.test",
  entry: "PRIVATE_HOST_ENTRY_external-conversation",
  key: "PRIVATE_MESSAGE_KEY_retry-identity",
  delivery: "PRIVATE_DELIVERY_receiver-identity",
  detail: "PRIVATE_ERROR_DETAILS_/home/private/project",
};
type Fields = Record<string, unknown>;
type Event = { event: string; fields: Fields; level?: string };
type Reply = { result?: Fields; raw?: string; format?: "json" | "sse"; logThrows?: boolean };
type Exchange = { events: Event[]; wire: string; received: string; status: number };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function callBody(name: string, args: Fields = {}): Fields {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name, arguments: { task_id: taskId, ...args }, _meta: { "openai/session": secrets.entry },
  } };
}
function errorResult(code: string, effect = "not_started", retry = "fix_input"): Fields {
  return { isError: true, structuredContent: { task_id: taskId, operation_id: operationId,
    error_code: code, effect, retry_hint: retry, details: { body: secrets.body, token: secrets.token, path: secrets.detail } },
  content: [{ type: "text", text: `${secrets.body}: ${secrets.detail}\n[QuayMesh recovery: error_code=${code}; effect=${effect}; retry_hint=${retry}; operation_id=${operationId}]` }] };
}

/** Real Node HTTP responses exercise write/end/finish/close. Only verified middleware auth state is supplied here. */
async function fixture(t: TestContext) {
  let next: { reply: Reply; events: Event[]; wire: string } | null = null, sequence = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const current = next; next = null;
      assert.ok(current, "one fixture exchange per real request");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tracedRequest = Object.assign(req, { body, auth: {
        token: secrets.token, clientId: "test-client", scopes: [], extra: { owner_id: secrets.owner },
      } });
      const trace = traceMcpRequest(tracedRequest as unknown as Parameters<typeof traceMcpRequest>[0],
        res as unknown as Parameters<typeof traceMcpRequest>[1], `request-${++sequence}`, (event, fields, level) => {
          current.events.push({ event, fields, level });
          if (current.reply.logThrows) throw new Error(secrets.detail);
        });
      trace.authenticated(); trace.authenticated();
      res.setHeader("content-type", current.reply.format === "sse" ? "text/event-stream" : "application/json");
      res.writeHead(200);
      const wire = Buffer.from(current.wire);
      res.write(wire.subarray(0, 17));
      res.end(wire.subarray(17));
    })().catch(error => res.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closing;
  });
  const port = (server.address() as AddressInfo).port;
  return async (body: Fields, reply: Reply): Promise<Exchange> => {
    assert.equal(next, null);
    const envelope = JSON.stringify({ jsonrpc: "2.0", id: 1, result: reply.result ?? { content: [] } });
    const wire = reply.raw ?? (reply.format === "sse" ? `event: message\ndata: ${envelope}\n\n` : envelope);
    const events: Event[] = [];
    next = { reply, wire, events };
    const input = JSON.stringify(body);
    const result = await new Promise<{ status: number; received: string }>((resolve, reject) => {
      const client = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(input),
          authorization: `Bearer ${secrets.token}`, cookie: `private=${secrets.token}` } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode!, received: Buffer.concat(chunks).toString("utf8") }));
      });
      client.setTimeout(5_000, () => client.destroy(new Error("TEST_HTTP_TIMEOUT")));
      client.once("error", reject); client.end(input);
    });
    assert.equal(result.received, wire, "tracing never changes the wire response");
    return { events, wire, ...result };
  };
}

function finished(exchange: Exchange): Fields {
  assert.equal(exchange.status, 200);
  assert.deepEqual(exchange.events.map(row => row.event), [
    "mcp_exchange_started", "mcp_exchange_authenticated", "mcp_exchange_finished",
  ], "duplicate authentication and response close do not increase the existing event count");
  const row = exchange.events[2].fields;
  assert.equal(row.responseBytes, Buffer.byteLength(exchange.wire));
  assert.equal(row.responseSha256, sha256(exchange.wire));
  assert.equal(row.ownerHash, sha256(secrets.owner));
  assert.equal(row.hostAcknowledgment, "unknown");
  assert.equal(row.aborted, false);
  assert.match(String(row.argumentFingerprint), /^[a-f0-9]{64}$/);
  const log = JSON.stringify(exchange.events);
  for (const value of Object.values(secrets)) assert.equal(log.includes(value), false, `private value reached logs: ${value}`);
  return row;
}

test("Task mailbox and resume surfaces retain exact tool/action metadata through real JSON and SSE requests", async t => {
  const exchange = await fixture(t);
  const cases: Array<{ tool: string; action?: string; args?: Fields }> = [
    { tool: "task_messages", action: "history", args: { filter: "awaiting_reply" } },
    { tool: "task_messages", action: "receive", args: { request_key: secrets.key } },
    { tool: "task_messages", action: "ack", args: { delivery_id: secrets.delivery, message_ids: ["message-1"] } },
    { tool: "task_messages", action: "reply", args: { message_key: secrets.key, reply_to: ["message-1"], body: secrets.body } },
    { tool: "task_resume", action: "inspect" },
    { tool: "task_resume", action: "resume", args: { expected_binding_revision: 3, request_key: secrets.key } },
    { tool: "qm_task_messages", args: { limit: 20 } },
    { tool: "qm_task_message_enqueue", args: { message_key: secrets.key, body: secrets.body } },
  ];
  for (const [index, value] of cases.entries()) {
    const input = callBody(value.tool, { ...value.args, ...(value.action ? { action: value.action } : {}) });
    const result = await exchange(input, { format: index % 2 ? "sse" : "json", result: {
      content: [{ type: "text", text: secrets.answer }], structuredContent: { task_id: taskId,
        messages: [{ body: secrets.body }], token: secrets.token, details: secrets.detail },
    } });
    const row = finished(result);
    assert.equal(row.tool, value.tool); assert.equal(row.action, value.action ?? "other");
    assert.equal(row.taskId, taskId); assert.equal(row.outcome, "success");
    assert.equal(row.source, value.tool.startsWith("qm_") ? "card" : "model");
    assert.equal(row.sourceEvidence, "tool_surface");
    assert.equal(row.conversationHash, sha256(JSON.stringify(secrets.entry)).slice(0, 24));
    assert.equal(row.requestBytes, Buffer.byteLength(JSON.stringify(input)));
  }
});

test("frozen Task access, mailbox, binding and finish error contracts remain diagnosable without their text or details", async t => {
  const exchange = await fixture(t);
  // Codes emitted by task-access, task-mailbox/messages, task-binding/resume and the finalization fence.
  const codes = [
    "MISSING_AUTHENTICATED_OWNER", "MISSING_AUTHENTICATED_CLIENT", "TASK_ACCESS_INVALID_ID", "TASK_ACCESS_DENIED",
    "TASK_ACCESS_METADATA_INVALID", "TASK_ACCESS_OWNER_SOURCE_INVALID", "TASK_ACCESS_TRANSACTION_REQUIRED",
    "TASK_MAILBOX_AUTHORITY_REQUIRED", "TASK_MAILBOX_ENTRY_REQUIRED", "TASK_MAILBOX_INVALID_ACTION", "TASK_MAILBOX_INVALID_ID",
    "TASK_MAILBOX_INVALID_BODY", "TASK_MAILBOX_INVALID_CLAIM", "TASK_MAILBOX_INVALID_ACK", "TASK_MAILBOX_INVALID_REPLY",
    "TASK_MAILBOX_INVALID_CURSOR", "TASK_MAILBOX_INVALID_FILTER", "TASK_MAILBOX_INVALID_SEQUENCE", "TASK_MAILBOX_IDEMPOTENCY_CONFLICT",
    "TASK_MAILBOX_TASK_CLOSED", "TASK_MAILBOX_TASK_FINISHING", "TASK_MAILBOX_BATCH_LIMIT", "TASK_MAILBOX_RECEIVER_MISMATCH",
    "TASK_MAILBOX_MESSAGE_NOT_OFFERED", "TASK_MAILBOX_DELIVERY_SUPERSEDED", "TASK_MAILBOX_LEASE_EXPIRED", "TASK_MAILBOX_ACK_OUT_OF_ORDER",
    "TASK_MAILBOX_REPLY_NOT_ACKNOWLEDGED", "TASK_MAILBOX_MESSAGE_NOT_FOUND", "TASK_MAILBOX_DELIVERY_NOT_FOUND",
    "TASK_MAILBOX_CORRUPT_DELIVERY", "TASK_MAILBOX_TRANSACTION_REQUIRED", "TASK_MAILBOX_CHANGED", "TASK_MAILBOX_INPUT_PENDING",
    "TASK_ENTRY_REQUIRED", "TASK_BINDING_AUTHORITY_REQUIRED", "TASK_BINDING_INVALID_INPUT", "TASK_BINDING_REPLY_TOO_LARGE",
    "TASK_START_SELECTION_REQUIRED", "TASK_BINDING_KEY_CONFLICT", "TASK_BINDING_REVISION_REQUIRED", "TASK_BINDING_REQUEST_KEY_REQUIRED", "TASK_BINDING_CHANGED",
    "TASK_BINDING_REPLAY_SUPERSEDED", "TASK_FINISHING", "TASK_HANDOFF_NOT_TERMINAL", "TASK_REVISION_REQUIRED", "TASK_REVISION_CONFLICT",
    "TASK_FINALIZATION_SUPERSEDED", "TASK_FINALIZATION_CONFLICT", "TASK_FINALIZATION_ALREADY_CONFIRMED",
    "TASK_FINALIZATION_WRITE_TRANSACTION_REQUIRED", "TASK_OWNER_FINALIZATION_UNCONFIRMED",
  ];
  for (const [index, code] of codes.entries()) {
    const effect = code === "TASK_OWNER_FINALIZATION_UNCONFIRMED" ? "unknown" : "not_started";
    const hint = effect === "unknown" ? "query_original" : "fix_input";
    const result = await exchange(callBody("task_resume", { action: "resume", request_key: secrets.key }), {
      format: index % 2 ? "sse" : "json", result: errorResult(code, effect, hint),
    });
    const row = finished(result);
    assert.equal(row.toolErrorCode, code, code); assert.equal(row.recoveryTextErrorCode, code, code);
    assert.equal(row.errorCodeConsistent, true); assert.equal(row.effect, effect); assert.equal(row.retryHint, hint);
    assert.equal(row.operationId, operationId); assert.equal(row.outcome, "tool_error");
    assert.equal(result.events[2].level, "warn");
  }
});

test("peer binding and copy failures retain their exact codes through real HTTP without logging private scope", async t => {
  const exchange = await fixture(t);
  const cases: Array<{ code: string; tool: string; action?: string; effect?: string; hint?: string }> = [
    { code: "TASK_BINDING_COORDINATOR_REQUIRED", tool: "open_workspace" },
    { code: "TASK_BINDING_CAPABILITY_INVALID", tool: "open_workspace" },
    { code: "TASK_BINDING_PEER_UPGRADE_REQUIRED", tool: "open_workspace" },
    { code: "TASK_BINDING_VERSION_UNSUPPORTED", tool: "open_workspace" },
    { code: "TASK_BINDING_SCOPE_REQUIRED", tool: "open_workspace" },
    { code: "TASK_SCOPE_MISMATCH", tool: "open_workspace" },
    { code: "TASK_MEMBER_REQUIRED", tool: "copy_artifact", action: "start" },
    { code: "TASK_REMOTE_HISTORY_UNAVAILABLE", tool: "workspace_context", action: "recovery" },
    { code: "TASK_REMOTE_SCOPE_MISMATCH", tool: "open_workspace", effect: "unknown", hint: "query_original" },
    { code: "COPY_REQUEST_KEY_REQUIRED", tool: "copy_artifact", action: "start" },
    { code: "COPY_REQUEST_KEY_REUSED", tool: "copy_artifact", action: "start" },
    { code: "COPY_TASK_CONTEXT_REQUIRED", tool: "copy_artifact", action: "start" },
    { code: "COPY_RECEIPT_LOOKUP_FAILED", tool: "copy_artifact", action: "start" },
    { code: "COPY_ARGUMENT_REQUIRED", tool: "copy_artifact", action: "start" },
  ];
  for (const [index, item] of cases.entries()) {
    const effect = item.effect ?? "not_started", hint = item.hint ?? "fix_input";
    const result = await exchange(callBody(item.tool, { action: item.action, request_key: secrets.key,
      source_path: secrets.detail, body: secrets.body }), {
      format: index % 2 ? "sse" : "json", result: errorResult(item.code, effect, hint),
    });
    const row = finished(result);
    assert.equal(row.tool, item.tool); assert.equal(row.action, item.action ?? "other");
    assert.equal(row.toolErrorCode, item.code); assert.equal(row.recoveryTextErrorCode, item.code);
    assert.equal(row.errorCodeConsistent, true); assert.equal(row.effect, effect); assert.equal(row.retryHint, hint);
    assert.equal(row.outcome, "tool_error"); assert.equal(result.events[2].level, "warn");
  }
});

test("near-match names and arbitrary codes stay other; free error text cannot impersonate a recovery suffix", async t => {
  const exchange = await fixture(t);
  const unknown = "TASK_MAILBOX_PRIVATE_UNREGISTERED", unknownAction = `resume-${secrets.key}`;
  const result = await exchange(callBody(`task_messages-${secrets.key}`, { action: unknownAction,
    body: secrets.body, token: secrets.token }), { result: { ...errorResult(unknown),
    structuredContent: { error_code: unknown, effect: secrets.body, retry_hint: secrets.key, details: secrets.detail } } });
  const row = finished(result);
  assert.equal(row.tool, "other"); assert.equal(row.action, "other");
  assert.equal(row.toolErrorCode, "other"); assert.equal(row.recoveryTextErrorCode, "other");
  assert.equal(row.effect, "other"); assert.equal(row.retryHint, "other");
  assert.equal(JSON.stringify(result.events).includes(unknown), false);

  for (const code of ["TASK_BINDING_PEER_UPGRADE_REQUIRED_PRIVATE", "COPY_PRIVATE_UNREGISTERED"]) {
    const rejected = await exchange(callBody("copy_artifact", { action: "start", request_key: secrets.key }), {
      result: errorResult(code),
    });
    const metadata = finished(rejected);
    assert.equal(metadata.toolErrorCode, "other"); assert.equal(metadata.recoveryTextErrorCode, "other");
    assert.equal(JSON.stringify(rejected.events).includes(code), false);
  }

  const plain = finished(await exchange(callBody("task_messages", { action: "reply", body: secrets.body }), {
    result: { isError: true, content: [{ type: "text", text: `TASK_FINISHING: ${secrets.detail}` }] },
  }));
  assert.equal(plain.toolErrorCode, undefined); assert.equal(plain.recoveryTextErrorCode, undefined);
  assert.equal(plain.outcome, "tool_error");
});

test("JSON text errors retain only known codes and fingerprints; mismatched receipt layers remain visible", async t => {
  const exchange = await fixture(t);
  const jsonText = finished(await exchange(callBody("task_resume", { action: "resume", request_key: secrets.key }), {
    format: "sse", result: { isError: true, content: [{ type: "text", text: JSON.stringify({
      code: "TASK_BINDING_REPLAY_SUPERSEDED", message: secrets.detail, token: secrets.token,
    }) }] },
  }));
  assert.equal(jsonText.toolErrorCode, "TASK_BINDING_REPLAY_SUPERSEDED");
  assert.equal(jsonText.errorFingerprint, sha256(secrets.detail).slice(0, 16));

  const mismatched = errorResult("TASK_MAILBOX_CHANGED");
  (mismatched.structuredContent as Fields).error_code = "TASK_REVISION_CONFLICT";
  const row = finished(await exchange(callBody("finish_task", { message_sequence: 1 }), { result: mismatched }));
  assert.equal(row.toolErrorCode, "TASK_REVISION_CONFLICT");
  assert.equal(row.recoveryTextErrorCode, "TASK_MAILBOX_CHANGED");
  assert.equal(row.errorCodeConsistent, false);
});

test("single text mirrors retain strict recovery diagnostics through JSON and SSE without logging notes", async t => {
  const exchange = await fixture(t);
  for (const format of ["json", "sse"] as const) {
    for (const code of ["TASK_MAILBOX_CHANGED", "TASK_MAILBOX_PRIVATE_UNREGISTERED"]) {
      const original = errorResult(code);
      Object.assign(original.structuredContent as Fields, {
        _quaymesh_text_notes: (errorResult("TASK_ACCESS_DENIED").content as Array<{ text: string }>).map(block => block.text),
        _quaymesh_text_notes_2: [secrets.answer],
      });
      const normalized = toolResultForTextClients(original);
      const blocks = normalized.content as Array<{ type: string; text: string; _meta?: Fields }>;
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]._meta?.["quaymesh/structured-text"], "_quaymesh_text_notes_3");
      const row = finished(await exchange(callBody("task_resume", { action: "resume" }), { format, result: normalized }));
      const expected = code === "TASK_MAILBOX_CHANGED" ? code : "other";
      assert.equal(row.toolErrorCode, expected); assert.equal(row.recoveryTextErrorCode, expected);
      assert.equal(row.errorCodeConsistent, true); assert.equal(row.operationId, operationId);
    }
    const mismatch = errorResult("TASK_MAILBOX_CHANGED");
    (mismatch.structuredContent as Fields).error_code = "TASK_REVISION_CONFLICT";
    const row = finished(await exchange(callBody("finish_task"), {
      format, result: toolResultForTextClients(mismatch),
    }));
    assert.equal(row.toolErrorCode, "TASK_REVISION_CONFLICT");
    assert.equal(row.recoveryTextErrorCode, "TASK_MAILBOX_CHANGED"); assert.equal(row.errorCodeConsistent, false);
  }
});

test("only marked mirror notes expose recovery tails; arbitrary JSON fields and incomplete tails remain private", async t => {
  const exchange = await fixture(t);
  const tail = (errorResult("TASK_MAILBOX_CHANGED").content as Array<{ text: string }>)[0].text;
  const key = "_quaymesh_text_notes", marker = { "quaymesh/structured-text": key };
  const cases: Array<{ value: Fields; meta?: Fields; structured?: Fields }> = [
    { value: { [key]: [tail] } },
    { value: { [key]: [tail] }, meta: { "quaymesh/structured-text-near-match": key } },
    { value: { result: [tail] }, meta: { "quaymesh/structured-text": "result" } },
    { value: { [key]: [tail] }, meta: marker, structured: { [key]: [tail] } },
    { value: { [key]: tail }, meta: marker },
    { value: { [key]: [tail, { body: secrets.body }] }, meta: marker },
    { value: { result: { [key]: [tail] } }, meta: marker },
    { value: { [key]: [tail + "\nnot a recovery tail"] }, meta: marker },
    { value: { [key]: [tail.slice(0, -1)] }, meta: marker },
  ];
  for (const [index, item] of cases.entries()) {
    const row = finished(await exchange(callBody("read"), { format: index % 2 ? "sse" : "json", result: {
      isError: true, structuredContent: { error_code: "TASK_MAILBOX_CHANGED", ...item.structured },
      content: [{ type: "text", text: JSON.stringify(item.value), ...(item.meta ? { _meta: item.meta } : {}) }],
    } }));
    assert.equal(row.toolErrorCode, "TASK_MAILBOX_CHANGED");
    assert.equal(row.recoveryTextErrorCode, undefined, `case ${index}`);
    assert.equal(row.errorCodeConsistent, undefined, `case ${index}`);
  }
});

test("the 64 KiB inspection boundary keeps full wire hashes and never logs oversized message bodies", async t => {
  const exchange = await fixture(t);
  const encoded = (padding: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
    isError: true, structuredContent: { error_code: "TASK_MAILBOX_TASK_CLOSED" },
    content: [{ type: "text", text: secrets.body + "x".repeat(padding) }],
  } });
  const budget = 64 * 1024, padding = budget - Buffer.byteLength(encoded(0));
  const exact = encoded(padding), oversized = encoded(padding + 1);
  assert.equal(Buffer.byteLength(exact), budget);
  const accepted = finished(await exchange(callBody("qm_task_messages"), { raw: exact }));
  assert.equal(accepted.resultInspection, "inspected"); assert.equal(accepted.toolErrorCode, "TASK_MAILBOX_TASK_CLOSED");
  const limited = await exchange(callBody("qm_task_messages"), { raw: oversized });
  const row = finished(limited);
  assert.equal(row.resultInspection, "over_limit"); assert.equal(row.outcome, "uninspected");
  assert.equal(row.toolErrorCode, undefined); assert.equal(row.toolError, undefined);
  assert.ok(JSON.stringify(limited.events).length < 4_000, "payload size does not grow the logged metadata");
});

test("the existing resource URI truncation and non-fatal logging boundary remain unchanged", async t => {
  const exchange = await fixture(t);
  const uri = "ui://public-resource/" + "a".repeat(600) + secrets.detail;
  const result = await exchange({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } }, {
    logThrows: true, result: { content: [{ type: "text", text: secrets.answer }] },
  });
  const row = finished(result);
  assert.equal(row.resourceUri, uri.slice(0, 512));
  assert.equal(row.method, "resources/read"); assert.equal(row.source, "protocol");
  assert.equal(row.outcome, "success");
});
