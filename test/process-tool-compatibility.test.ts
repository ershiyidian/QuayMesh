import assert from "node:assert/strict";
import test from "node:test";
import { callOpen, createRealTestServer, structured } from "./session-card/server-fixture.js";

test("exec_command exposes a stable operation id and a numeric write_stdin compatibility handle", { timeout: 60_000 }, async (t) => {
  const fixture = await createRealTestServer({ prefix: "quaymesh-process-compat-" });
  t.after(() => fixture.dispose());
  const opened = structured(await callOpen(fixture.client, fixture.project, "process compatibility"));
  const workspaceId = String(opened.workspace_id);

  const tools = (await fixture.client.listTools()).tools;
  const writeTool = tools.find((tool) => tool.name === "write_stdin");
  const executeTool = tools.find((tool) => tool.name === "exec_command");
  assert.ok(writeTool);
  assert.ok(executeTool);
  const advertised = JSON.stringify(writeTool.inputSchema);
  assert.match(advertised, /"type":"string"/);
  assert.match(advertised, /"type":"integer"/);
  assert.match(JSON.stringify(executeTool.outputSchema), /write_stdin_session_id/);

  const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
  const started = structured(await fixture.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: `${node} -e "setTimeout(() => console.log('compatibility-ok'), 120)"`,
      yield_time_ms: 5,
    },
  }));
  assert.equal(started.running, true);
  assert.equal(typeof started.session_id, "number");
  assert.equal(typeof started.operation_id, "string");
  assert.equal(started.session_id, started.write_stdin_session_id);
  assert.equal(typeof started.write_stdin_session_id, "number");

  const finished = structured(await fixture.client.callTool({
    name: "write_stdin",
    arguments: {
      workspace_id: workspaceId,
      session_id: started.write_stdin_session_id,
      chars: "",
      yield_time_ms: 2_000,
    },
  }));
  assert.equal(finished.running, false);
  assert.equal(finished.exit_code, 0);
  assert.match(String(finished.result), /compatibility-ok/);
  assert.equal(finished.operation_id, started.operation_id);
});
