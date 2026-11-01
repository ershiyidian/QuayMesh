import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../../src/config.js";
import { WorkLedger } from "../../src/work-ledger.js";
import { SessionStore } from "../../src/session/store.js";
import { SessionChangeCollector } from "../../src/session/changes.js";

/** Real temporary SQLite state; no SessionRuntime, agent provider, HTTP listener or watchdog. */
export async function readonlyDetailFixture() {
  const directory = await mkdtemp(join(tmpdir(), "qm-read-detail-"));
  const stateDir = join(directory, "state"), root = join(directory, "workspace"), configDir = join(directory, "config");
  await Promise.all([mkdir(root), mkdir(configDir)]);
  const ledger = new WorkLedger(stateDir);
  const store = new SessionStore(ledger.db);
  const session = store.createSession("owner", null, "Fixture session");
  const member = store.addMember(session.id, "local", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Saved Task goal", "request_1");
  store.touchTaskMember(task.id, member.id);
  const run = ledger.begin({ root, workItemId: "task_1", runKey: "run_1", title: "Saved Task goal",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  store.linkRun(session.id, member.id, run.id, task.id);
  store.upsertContextRead({ sessionId: session.id, memberId: member.id, taskId: task.id,
    actorId: "host", path: "TASK-INSTRUCTIONS.md", kind: "instruction", state: "read", incrementRead: true });
  const changes = new SessionChangeCollector(store, stateDir);
  const config = { stateDir, configDir, allowedRoots: [root] } as ServerConfig;
  return { directory, root, config, ledger, store, session, member, task, run, changes,
    async close() { ledger.close(); await rm(directory, { recursive: true, force: true }); } };
}
