import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";
import { twoNodes } from "./fixture.js";

test("双节点新目标复用原工作区时保留两端成员关系与原工作区指令", { timeout: 60_000 }, async t => {
  const { cloud, worker } = await twoNodes(t, { git: false });
  await writeFile(join(worker.project, "AGENTS.md"), "Keep workspace context across task changes.\n");
  const meta = { "openai/session": randomUUID() };
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = await cloud.client.callTool({ name, arguments: args, _meta: meta });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent, JSON.stringify(result));
    return result.structuredContent as Record<string, any>;
  };
  const first = await call("start_session", { title: "First goal", request_key: randomUUID() });
  const workspace = await call("open_workspace", { root_id: "worker/main" });
  const selected = await call("task_resume", { action: "inspect", task_id: first.task_id });
  const next = await call("start_session", { title: "Reuse workspace", request_key: randomUUID(), new_goal: true,
    expected_binding_revision: selected.binding.binding_revision });
  assert.notEqual(next.task_id, first.task_id);
  await call("read", { workspace_id: workspace.workspace_id, path: "README.md" });
  for (const node of [cloud, worker]) {
    const database = openDatabase(node.config.stateDir), store = new SessionStore(database.sqlite);
    try {
      const members = store.taskMemberIds(next.task_id);
      assert.equal(members.length, 1, `${node.config.federation?.nodeId}: the new Task must include the reused workspace`);
      assert.equal(store.getMember(next.session_id, members[0]).node_id, "worker");
      const recorded = database.sqlite.prepare("SELECT context_inherited FROM qm_task_members WHERE task_id=? AND member_id=?")
        .get(next.task_id, members[0]) as { context_inherited: number };
      assert.equal(recorded.context_inherited, 1);
      if (node === worker) assert.ok(store.contextReads(next.session_id, members[0], next.task_id)
        .some(context => context.actor_id === "host" && context.path.endsWith("AGENTS.md")));
      assert.deepEqual(store.taskMemberIds(first.task_id), members);
    } finally { database.close(); }
  }
});
