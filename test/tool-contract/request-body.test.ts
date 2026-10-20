import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath } from "../../src/db/client.js";
import { MCP_REQUEST_BODY_LIMIT_BYTES } from "../../src/mcp-http-app.js";
import { fixture, until } from "./fixture.js";

test("真实 MCP 接收超过 100 KiB 的补丁，同 key 仅重放原操作", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false });
  const text = "A".repeat(110 * 1024), key = randomUUID();
  const input = { ...f.scope, operation_key: key,
    patch: `*** Begin Patch\n*** Add File: large.txt\n+${text}\n*** End Patch` };
  const bytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(bytes > 100 * 1024 && bytes < MCP_REQUEST_BODY_LIMIT_BYTES);
  const first = await f.call("apply_patch", input);
  assert.equal(typeof first.operation_id, "string");
  await until(async () => (await f.call("workspace_context", {
    ...f.scope, action: "status", operation_id: first.operation_id,
  })).operation_state === "succeeded");
  const target = join(f.project, "large.txt");
  assert.equal(await readFile(target, "utf8"), text + "\n");
  const db = new Database(databasePath(f.config.stateDir), { readonly: true, fileMustExist: true });
  try {
    const rows = () => db.prepare("SELECT * FROM qm_invocations WHERE json_extract(arguments_json,'$.operation_key')=?").all(key) as Array<Record<string, unknown>>;
    const original = rows();
    assert.equal(original.length, 1);
    assert.equal(original[0].operation_id, first.operation_id);
    assert.equal(original[0].state, "succeeded");
    // 若回放误执行，Add File 会失败或覆盖此后独立写入的内容。
    await writeFile(target, "changed after original operation\n");
    const replay = await f.call("apply_patch", input);
    assert.equal(replay.operation_id, first.operation_id);
    assert.deepEqual(rows(), original);
    assert.equal(await readFile(target, "utf8"), "changed after original operation\n");
    const finishes = db.prepare("SELECT count(*) AS count FROM qm_events WHERE event_type='operation_finished' AND json_extract(data_json,'$.operation_id')=?")
      .get(first.operation_id) as { count: number };
    assert.equal(finishes.count, 1);
  } finally { db.close(); }
  await f.client.ping();
});

test("真实 HTTP 超限和非法 JSON 明确未执行，仅记录安全拒绝元数据", { timeout: 30_000 }, async t => {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const f = await fixture(t, { git: false, diagnostics: {
    record: (event, fields = {}) => { events.push({ event, fields }); },
  } });
  const headers = { authorization: `Bearer ${f.accessToken}`, "content-type": "application/json",
    accept: "application/json, text/event-stream" };
  const marker = `private-request-${randomUUID()}`, key = randomUUID();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 987, method: "tools/call", params: {
    name: "apply_patch", _meta: f.meta, arguments: { ...f.scope, operation_key: key,
      patch: `*** Begin Patch\n*** Add File: must-not-exist.txt\n+${marker}${"A".repeat(MCP_REQUEST_BODY_LIMIT_BYTES)}\n*** End Patch` },
  } });
  const db = new Database(databasePath(f.config.stateDir), { readonly: true, fileMustExist: true });
  try {
    const count = () => (db.prepare("SELECT count(*) AS count FROM qm_invocations").get() as { count: number }).count;
    const before = count();
    const response = await fetch(f.baseUrl + "/mcp", { method: "POST", headers, body });
    assert.equal(response.status, 413);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
    const refused = await response.json() as Record<string, any>;
    assert.equal(refused.id, null);
    assert.equal(refused.error.code, -32600);
    assert.equal(refused.error.data.error_code, "REQUEST_BODY_TOO_LARGE");
    assert.equal(refused.error.data.effect, "not_started");
    assert.equal(refused.error.data.retry_hint, "fix_input");
    assert.equal(refused.error.data.limit_bytes, MCP_REQUEST_BODY_LIMIT_BYTES);
    assert.equal(typeof refused.error.data.request_id, "string");
    assert.equal(count(), before);
    await assert.rejects(stat(join(f.project, "must-not-exist.txt")), { code: "ENOENT" });
    const plaintext = await fetch(f.baseUrl + "/mcp", { method: "POST",
      headers: { ...headers, "content-type": "text/plain" }, body });
    assert.equal(plaintext.status, 413);
    const plaintextRefused = await plaintext.json() as Record<string, any>;
    assert.equal(plaintextRefused.error.data.error_code, "REQUEST_BODY_TOO_LARGE");
    assert.equal(plaintextRefused.error.data.effect, "not_started");
    assert.equal(plaintextRefused.error.data.limit_bytes, MCP_REQUEST_BODY_LIMIT_BYTES);
    assert.equal(count(), before);
    await assert.rejects(stat(join(f.project, "must-not-exist.txt")), { code: "ENOENT" });
    await f.client.ping();

    const invalid = await fetch(f.baseUrl + "/mcp", { method: "POST", headers,
      body: `{"private":"${marker}", malformed` });
    assert.equal(invalid.status, 400);
    const malformed = await invalid.json() as Record<string, any>;
    assert.equal(malformed.error.code, -32700);
    assert.equal(malformed.error.data.error_code, "INVALID_JSON");
    assert.equal(malformed.error.data.effect, "not_started");
    assert.equal(malformed.error.data.retry_hint, "fix_input");
    assert.equal(count(), before);
    const rejected = events.filter(event => event.event === "mcp_request_rejected");
    assert.equal(rejected.length, 3);
    assert.equal(rejected[0].fields.requestId, refused.error.data.request_id);
    assert.equal(rejected[0].fields.requestBytes, Buffer.byteLength(body));
    assert.equal(rejected[0].fields.limitBytes, MCP_REQUEST_BODY_LIMIT_BYTES);
    assert.equal(rejected[1].fields.requestId, plaintextRefused.error.data.request_id);
    assert.equal(rejected[1].fields.requestBytes, Buffer.byteLength(body));
    assert.equal(rejected[1].fields.httpStatus, 413);
    assert.equal(rejected[2].fields.requestId, malformed.error.data.request_id);
    for (const { fields } of rejected) {
      assert.equal(fields.stage, "request_body");
      assert.equal(fields.effect, "not_started");
      assert.deepEqual(Object.keys(fields).sort(), ["effect", "errorCode", "httpStatus", "limitBytes", "receivedBytes", "requestBytes", "requestId", "stage"]);
    }
    const visible = JSON.stringify({ rejected, refused, plaintextRefused, malformed });
    assert.equal(visible.includes(marker), false);
    assert.equal(visible.includes(f.accessToken), false);
    assert.equal(visible.includes(f.scope.workspace_id), false);
    assert.equal(visible.includes(key), false);

    const unauthenticated = await fetch(f.baseUrl + "/mcp", { method: "POST",
      headers: { "content-type": "application/json", accept: headers.accept },
      body: JSON.stringify({ jsonrpc: "2.0", id: 988, method: "ping" }) });
    assert.equal(unauthenticated.status, 401);
    await unauthenticated.text();
    assert.equal((await hostResponse(f.baseUrl, "rejected.invalid")).status, 403);
    await f.client.ping();
  } finally { db.close(); }
});

test("未显式列出 allowedHosts 时仍保留 SDK localhost Host 校验", { timeout: 30_000 }, async t => {
  const f = await fixture(t, { git: false, configure: async config => ({ ...config, allowedHosts: ["*"] }) });
  assert.equal((await hostResponse(f.baseUrl, "localhost")).status, 200);
  assert.equal((await hostResponse(f.baseUrl, "rejected.invalid")).status, 403);
  const missing = await hostResponse(f.baseUrl);
  // Node 可在进入 Express 前直接拒绝缺少 Host 的 HTTP/1.1 请求。
  assert.ok([400, 403].includes(missing.status));
  if (missing.status === 403) assert.match(missing.body, /Missing Host header/u);
  await f.client.ping();
});

function hostResponse(baseUrl: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL("/healthz", baseUrl), { setHost: false, headers: host ? { host } : {} }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}
