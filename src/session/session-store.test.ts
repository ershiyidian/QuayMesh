import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { createInvocationContext, executeRecorded } from "./invocations.js";
import { RecoveryService } from "./recovery.js";
import { SessionProjector } from "./projection.js";
import { SessionStore } from "./store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-session-"));
  const root = join(directory, "project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { recursive: true }));
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  return {
    directory,
    root,
    database,
    store,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("session identity reuses one conversation per owner and isolates owners", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first = f.store.createSession("owner-a", "conversation-1", "first");
  const reused = f.store.createSession("owner-a", "conversation-1", "ignored");
  const other = f.store.createSession("owner-b", "conversation-1", "other");
  assert.equal(reused.id, first.id);
  assert.notEqual(other.id, first.id);
  assert.equal(f.store.findByConversation("owner-a", "conversation-1")?.id, first.id);
  assert.equal(f.store.findByConversation("owner-b", "conversation-1")?.id, other.id);
});

test("duplicate event identity does not advance revisions and persistence survives reopen", async (t) => {
  const f = await fixture();
  const stateDir = join(f.directory, "state");
  const session = f.store.createSession("owner-a", "conversation-2", "persistence");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const event = {
    session_id: session.id,
    member_id: member.id,
    type: "session_opened" as const,
    source_id: "open-once",
    timestamp: new Date().toISOString(),
    payload: { workspace_id: "workspace-a" },
  };
  const first = f.store.appendEvent(event);
  const duplicate = f.store.appendEvent(event);
  assert.equal(first.sessionRevision, 1);
  assert.equal(duplicate.sessionRevision, 1);
  assert.equal(f.store.getSession(session.id).revision, 1);
  f.database.close();

  const reopened = openDatabase(stateDir);
  try {
    const store = new SessionStore(reopened.sqlite);
    const restored = store.requireSession("owner-a", session.id);
    assert.equal(restored.title, "persistence");
    assert.equal(restored.members.length, 1);
    assert.equal(store.eventsForSession(session.id).length, 1);
  } finally {
    reopened.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("long sessions keep later events and bounded reads return the newest window", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.store.createSession("owner-a", "conversation-long", "long");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const task = f.store.createTask(session.id, "long task");
  for (let index = 0; index < 1005; index++) {
    f.store.appendEvent({
      session_id: session.id,
      task_id: task.id,
      member_id: member.id,
      type: "host_changed",
      source_id: `long-${index}`,
      timestamp: new Date(Date.now() + index).toISOString(),
      payload: { index },
    });
  }
  assert.equal(f.store.eventsForSession(session.id).length, 1005);
  const latest = f.store.eventsForSession(session.id, 25);
  assert.equal(latest.length, 25);
  assert.equal(latest[0]?.payload.index, 980);
  assert.equal(latest.at(-1)?.payload.index, 1004);
});

test("recorded invocation executes once for one transport request and allows a new request", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.store.createSession("owner-a", "conversation-3", "invocation");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const file = join(f.root, "writes.txt");
  const base = {
    auth: { owner_id: "owner-a" },
    transport: { instance_id: "transport-1" },
    request: { id: 7, conversation_id: "conversation-3", actor: "model" as const, tool_name: "append" },
    session: { session_id: session.id, member_id: member.id, workspace_id: "workspace-a" },
  };
  const context = createInvocationContext(base);
  const operation = () => appendFile(file, "line\n", "utf8");
  const first = await executeRecorded(f.store, context, { text: "line" }, { invoke: operation });
  const duplicate = await executeRecorded(f.store, context, { text: "line" }, { invoke: operation });
  assert.equal(first.replay, false);
  assert.equal(duplicate.replay, true);
  assert.equal(await readFile(file, "utf8"), "line\n");

  await assert.rejects(
    executeRecorded(f.store, context, { text: "different" }, { invoke: operation }),
    /REQUEST_ID_REUSED/,
  );
  assert.equal(await readFile(file, "utf8"), "line\n");

  const nextContext = createInvocationContext({
    ...base,
    request: { ...base.request, id: 8 },
  });
  const next = await executeRecorded(f.store, nextContext, { text: "line" }, { invoke: operation });
  assert.equal(next.replay, false);
  assert.equal(await readFile(file, "utf8"), "line\nline\n");
});

test("recovery export writes bounded JSON and Markdown and can be reopened", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.store.createSession("owner-a", "conversation-4", "recovery");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const operationId = "op_recovery_test";
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_finished",
    source_id: `${operationId}-finish`,
    timestamp: new Date().toISOString(),
    payload: { operation_id: operationId, kind: "command", label: "npm test", status: "succeeded", effect: "completed" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "file_changed",
    source_id: "change-1",
    timestamp: new Date().toISOString(),
    payload: { path: "src/example.ts" },
  });
  const recovery = new RecoveryService(f.store, join(f.directory, "state"));
  await recovery.exportRoot(f.root);
  const json = JSON.parse(await readFile(join(f.root, ".quaymesh", "sessions.json"), "utf8")) as { sessions: Array<Record<string, unknown>> };
  const markdown = await readFile(join(f.root, ".quaymesh", "Sessions.md"), "utf8");
  assert.equal(json.sessions.length, 1);
  assert.equal(json.sessions[0]?.session_id, session.id);
  assert.match(markdown, /npm test/);
  assert.match(markdown, /src\/example\.ts/);
  assert.deepEqual(await recovery.readLocalHistoricalTable(f.root), json.sessions);
});

test("recent recovery includes a newly created session before its timestamp advances", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.store.createSession("owner-a", "conversation-same-ms", "same millisecond");
  f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const fixed = new Date().toISOString();
  f.database.sqlite.prepare("UPDATE qm_sessions SET created_at = ?, last_activity_at = ? WHERE id = ?").run(fixed, fixed, session.id);

  const rows = f.store.recentRecoveryRows("owner-a", f.root);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]?.session_id, session.id);
});

test("projection materializes a stored snapshot and returns unchanged for the same revision", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.store.createSession("owner-a", "conversation-5", "projection");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "session_opened",
    source_id: "projection-open",
    timestamp: new Date().toISOString(),
    payload: {},
  });
  const projector = new SessionProjector(f.store, join(f.directory, "state"));
  const snapshot = await projector.materialize(session.id, member.id);
  assert.equal(snapshot.sessionId, session.id);
  assert.equal(snapshot.rev, f.store.getMember(session.id, member.id).revision);
  const unchanged = projector.read(session.id, member.id, snapshot.rev);
  assert.equal(unchanged.unchanged, true);
  await projector.close();
});

test("projection never performs local revert checks for a remote member", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const session = f.store.createSession("owner-a", "conversation-remote-projection", "remote");
  const member = f.store.upsertRemoteMember({
    id: "remote-member",
    sessionId: session.id,
    nodeId: "worker",
    workspaceId: "workspace-remote",
    root: "/remote-only/path",
    sourceRoot: null,
    mode: "checkout",
    online: true,
    revision: 0,
  });
  let calls = 0;
  const projector = new SessionProjector(
    f.store,
    join(f.directory, "state"),
    null,
    async () => { calls += 1; throw new Error("must not run for remote members"); },
    "entry",
  );
  const snapshot = await projector.materialize(session.id, member.id);
  assert.equal(calls, 0);
  assert.equal(snapshot.workspace?.node_id, "worker");
  assert.equal(snapshot.capabilities.revert, false);
  await projector.close();
});
