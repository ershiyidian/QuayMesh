import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { activityTimes } from "./activity.js";
import { SessionProjector } from "./projection.js";
import { SessionStore } from "./store.js";
import type { SessionEvent } from "./types.js";

test("task activity advances for recorded work and ignores observation-only changes", () => {
  const event = (type: SessionEvent["type"], at: number, member = "member-a"): SessionEvent => ({
    sequence: at, session_id: "session", task_id: "task", member_id: member,
    type, source_id: `${type}-${at}`, timestamp: new Date(at).toISOString(), payload: {},
  });
  const operations = [event("operation_started", 1000), event("operation_output", 2000), event("operation_finished", 3000)];
  assert.equal(activityTimes(operations).lastActivityAt, 3000);
  const changed = [...operations, event("file_changed", 4000), event("verification_recorded", 5000)];
  const before = activityTimes(changed);
  assert.equal(before.lastActivityAt, 5000);
  assert.equal(before.lastExecutionActivityAt, 3000);
  assert.deepEqual(activityTimes([...changed, event("host_changed", 6000), event("usage_changed", 7000)]), before);
  assert.deepEqual(activityTimes([...changed, event("operation_started", 8000, "member-b")], "member-a"), before);
  assert.equal(activityTimes([event("session_opened", 9000)]).lastActivityAt, null);
});

test("stored file activity survives member and Task projection without a command event", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-activity-recency-"));
  const root = join(directory, "project");
  await mkdir(root);
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const projector = new SessionProjector(store, join(directory, "state"));
  t.after(async () => {
    await projector.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const session = store.createSession("owner", "activity-projection", "Activity projection");
  const first = store.addMember(session.id, "worker-a", "workspace-a", root, "checkout", null);
  const second = store.addMember(session.id, "worker-b", "workspace-b", root, "checkout", null);
  const task = store.createTask(session.id, "Task with recorded file changes");
  const older = Date.now() - 20_000, newer = older + 5000;
  for (const [member, at] of [[first, older], [second, newer]] as const) {
    store.touchTaskMember(task.id, member.id);
    store.appendEvent({ session_id: session.id, task_id: task.id, member_id: member.id,
      type: "file_changed", source_id: `file-${member.id}`, timestamp: new Date(at).toISOString(),
      payload: { path: "changed.txt" } });
  }
  store.appendEvent({ session_id: session.id, task_id: task.id, member_id: first.id,
    type: "host_changed", source_id: "new-observation", timestamp: new Date().toISOString(),
    payload: { status: "connected" } });
  const memberSnapshot = await projector.materialize(session.id, first.id, task.id);
  assert.equal(memberSnapshot.lastActivityAt, older);
  assert.equal(memberSnapshot.lastExecutionActivityAt, null);
  const aggregate = await projector.readTask(task.id, -1);
  assert.equal(aggregate.snapshot?.lastActivityAt, newer);
  assert.equal(aggregate.snapshot?.lastExecutionActivityAt, null);
  assert.ok(aggregate.snapshot!.observedAt > newer);
});
