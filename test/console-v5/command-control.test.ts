import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkLedger } from "../../src/work-ledger.js";
import { SessionStore } from "../../src/session/store.js";
import { taskReference } from "../../src/console-workbench/task-aggregation.js";
import { callOpen, createRealTestServer, structured } from "../session-card/server-fixture.js";

test("Console interrupt stops a real managed command and preserves the original request receipt", { timeout: 60_000 }, async t => {
  const fixture = await createRealTestServer({ prefix: "qm-console-command-control-" });
  const ledger = new WorkLedger(fixture.config.stateDir), store = new SessionStore(ledger.db);
  t.after(async () => { ledger.close(); await fixture.dispose(); });
  const meta = { "openai/session": "console-command-control" };
  const opened = structured(await callOpen(fixture.client, fixture.project, "console-command-control"));
  const script = join(fixture.project, "long-command.mjs");
  await writeFile(script, "process.stdout.write('started\\n'); setInterval(() => {}, 1000);\n");
  const response = await fixture.client.callTool({ name: "exec_command", arguments: { workspace_id: opened.workspace_id,
    cmd: `"${process.execPath}" "${script}"`, yield_time_ms: 100 }, _meta: meta });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const command = structured(response), operationId = String(command.operation_id);
  assert.ok(operationId.startsWith("op_"));
  const taskId = store.getSession(String(opened.session_id)).current_task_id!;
  const reference = taskReference(taskId);
  const login = await fetch(fixture.baseUrl + "/console/api/login", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: fixture.baseUrl }, body: JSON.stringify({ password: "test-owner-token-that-is-long-enough" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
  const { csrf } = await login.json() as { csrf: string };
  async function api(path: string, body?: unknown): Promise<any> {
    const response = await fetch(fixture.baseUrl + "/console/api/v4/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, Origin: fixture.baseUrl, "Content-Type": "application/json", "X-QuayMesh-CSRF": csrf },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  }
  let detail = await api(`runs/${encodeURIComponent(reference)}`);
  for (let attempt = 0; !detail.run.actions.interrupt && attempt < 40; attempt++) {
    await delay(50); detail = await api(`runs/${encodeURIComponent(reference)}`);
  }
  assert.equal(detail.run.actions.interrupt, true);
  const body = { action: "interrupt", expectedRevision: detail.run.revision, requestKey: "console-stop-command" };
  const receipt = await api(`runs/${encodeURIComponent(reference)}/control`, body);
  assert.ok(["accepted", "completed"].includes(receipt.status), JSON.stringify(receipt));
  let output: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await fixture.client.callTool({ name: "read_output", arguments: { workspace_id: opened.workspace_id,
      operation_id: operationId, wait_ms: 100, limit_bytes: 1024 }, _meta: meta });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    output = structured(result);
    if (output.operation_state === "cancelled" && output.process_done) break;
    await delay(50);
  }
  assert.equal(output.operation_state, "cancelled");
  assert.equal(output.process_done, true);
  assert.deepEqual(await api(`runs/${encodeURIComponent(reference)}/control`, body), receipt);
  const query = new URLSearchParams({ path: `/api/v4/runs/${encodeURIComponent(reference)}/control`, target: "" });
  const confirmed = await api(`receipts/${body.requestKey}?${query}`);
  assert.equal(confirmed.state, "completed");
  assert.equal(confirmed.response.status, "completed");
  assert.ok(confirmed.response.results.every((phase: any) => phase.status === "completed"
    && phase.targets.every((target: any) => target.status === "completed")));
  assert.deepEqual(await api(`runs/${encodeURIComponent(reference)}/control`, body), confirmed.response);
  assert.equal(store.getTask(taskId).state, "active");
});
