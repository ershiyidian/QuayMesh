import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { RecoveryService } from "./recovery.js";
import { SessionStore } from "./store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-recovery-"));
  const root = join(directory, "project");
  await mkdir(root, { recursive: true });
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const recovery = new RecoveryService(store, join(directory, "state"));
  return {
    directory,
    root,
    database,
    store,
    recovery,
    async close() {
      await recovery.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("recovery export writes a short real table with operation and file facts", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  const session = f.store.createSession("owner-a", "conversation-recovery", "Login repair");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  const now = new Date().toISOString();
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_finished",
    source_id: "op-ok-finish",
    timestamp: now,
    payload: {
      operation_id: "op-ok",
      kind: "command",
      label: "pnpm test",
      status: "succeeded",
      effect: "completed",
      result_ref: "output:op-ok",
      stdout: "this raw stdout must not be exported",
      environment: { API_KEY: "super-secret-value" },
    },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_finished",
    source_id: "op-fail-finish",
    timestamp: now,
    payload: { operation_id: "op-fail", kind: "command", label: "pnpm build", status: "failed", effect: "completed", error_code: "EXIT_1" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_started",
    source_id: "op-running",
    timestamp: now,
    payload: { operation_id: "op-running", kind: "command", label: "pnpm dev", status: "running" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "file_changed",
    source_id: "file-login",
    timestamp: now,
    payload: { path: "src/login.ts" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "agent_changed",
    source_id: "agent-1",
    timestamp: now,
    payload: { agent_id: "agent-1", state: "working", name: "reviewer" },
  });
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "verification_recorded",
    source_id: "review-1",
    timestamp: now,
    payload: { decision: "passed" },
  });

  await f.recovery.exportRoot(f.root);

  const jsonText = await readFile(join(f.root, ".quaymesh", "sessions.json"), "utf8");
  const markdown = await readFile(join(f.root, ".quaymesh", "Sessions.md"), "utf8");
  const parsed = JSON.parse(jsonText) as { sessions: Array<Record<string, unknown>> };
  assert.equal(parsed.sessions.length, 1);
  const row = parsed.sessions[0]!;
  assert.equal(row.session_id, session.id);
  assert.equal(row.title, "Login repair");
  assert.deepEqual(row.files, ["src/login.ts"]);
  assert.deepEqual(row.commands, {
    succeeded: 1,
    failed: 1,
    running: 1,
    last_summary: "pnpm build",
  });
  assert.deepEqual(row.agents, { completed: 0, running: 1, failed: 0 });
  assert.equal(row.verification, "passed");
  assert.equal(row.execution_state, "idle");

  assert.match(markdown, /Login repair/);
  assert.match(markdown, /pnpm build/);
  assert.match(markdown, /src\/login\.ts/);
  assert.doesNotMatch(jsonText, /super-secret-value/);
  assert.doesNotMatch(markdown, /super-secret-value/);
  assert.doesNotMatch(jsonText, /raw stdout must not be exported/);
  assert.doesNotMatch(jsonText, /AGENTS\.md content/);

  const reopened = await f.recovery.readLocalHistoricalTable(f.root);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0]?.session_id, session.id);
});

test("recovery summary is bounded to five rows and detail is bounded to twenty operations", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  for (let index = 0; index < 7; index += 1) {
    const session = f.store.createSession("owner-a", `conversation-${index}`, `task-${index}`);
    const member = f.store.addMember(session.id, "desktop", `workspace-${index}`, f.root, "checkout", null);
    for (let operation = 0; operation < 25; operation += 1) {
      f.store.appendEvent({
        session_id: session.id,
        member_id: member.id,
        type: "operation_finished",
        source_id: `op-${index}-${operation}-finish`,
        timestamp: new Date(Date.now() - 60_000 + operation).toISOString(),
        payload: {
          operation_id: `op-${index}-${operation}`,
          kind: "command",
          label: `command-${index}-${operation}`,
          status: operation % 2 === 0 ? "succeeded" : "failed",
          effect: "completed",
          result_ref: `output:op-${index}-${operation}`,
        },
      });
    }

    const summary = f.recovery.summaryForOpen("owner-a", f.root);
    assert.ok(summary.length <= 5);

    const detail = f.recovery.detail("owner-a", f.root, session.id);
    assert.equal(detail.operations.length, 20);
    assert.equal(detail.operations.at(-1)?.label, `command-${index}-24`);
    assert.equal(detail.operations.at(0)?.label, `command-${index}-5`);
    assert.ok(detail.row.files.length <= 5);
  }
});

test("recovery keeps an interrupted session observable after the database is reopened", async (t) => {
  const f = await fixture();
  const stateDir = join(f.directory, "state");
  const session = f.store.createSession("owner-a", "conversation-interrupted", "Interrupted work");
  const member = f.store.addMember(session.id, "desktop", "workspace-a", f.root, "checkout", null);
  f.store.appendEvent({
    session_id: session.id,
    member_id: member.id,
    type: "operation_started",
    source_id: "op-unknown",
    timestamp: new Date().toISOString(),
    payload: { operation_id: "op-unknown", kind: "command", label: "long command", status: "running" },
  });
  f.store.setExecutionState(session.id, "interrupted" as never);
  await f.recovery.exportRoot(f.root);
  f.database.close();

  const reopened = openDatabase(stateDir);
  const store = new SessionStore(reopened.sqlite);
  const recovery = new RecoveryService(store, stateDir);
  try {
    const rows = recovery.summaryForOpen("owner-a", f.root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.execution_state, "interrupted");
    assert.match(rows[0]?.next_step ?? "", /核对结果未知的操作/);
    const detail = recovery.detail("owner-a", f.root, session.id);
    assert.equal(detail.operations.length, 1);
    assert.equal(detail.operations[0]?.state, "running");
  } finally {
    await recovery.close();
    reopened.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
