import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkLedger } from "../work-ledger.js";
import { SessionProjector } from "./projection.js";
import { SessionStore } from "./store.js";

test("persisted Task projection contains intrinsic eligibility while per-entry selection is checked at the app boundary", async t => {
  const directory = await mkdtemp(join(tmpdir(), "qm-task-continuation-projection-"));
  const ledger = new WorkLedger(directory);
  const store = new SessionStore(ledger.db);
  const projector = new SessionProjector(store, directory);
  t.after(async () => { await projector.close(); ledger.close(); await rm(directory, { recursive: true, force: true }); });
  const session = store.createSession("owner", "entry", "Independent goals");
  const first = store.createTask(session.id, "Goal A", "a");
  const firstView = (await projector.readTask(first.id, -1)).snapshot!;
  assert.equal(firstView.agents.length, 0);
  assert.equal(firstView.capabilities.continue, true, "no background agent does not mean the Task is closed");

  const second = store.createTask(session.id, "Goal B", "b");
  assert.equal(store.getTask(first.id).state, "active");
  assert.equal((await projector.readTask(first.id, -1)).snapshot!.capabilities.continue, true,
    "one entry selecting another goal must not cache a global inability to continue this open Task");
  assert.equal((await projector.readTask(second.id, -1)).snapshot!.capabilities.continue, true);

  store.taskData.requestFinalization(second.id, "completed", "Goal B completed", undefined, 0);
  assert.equal((await projector.readTask(second.id, -1)).snapshot!.capabilities.continue, false,
    "pending finalization has the same guard in display and execution");
  store.closeTask(second.id, "completed", "Goal B completed");
  assert.equal((await projector.readTask(second.id, -1)).snapshot!.capabilities.continue, false);
  assert.equal((await projector.readSession(session.id, -1)).snapshot!.capabilities.continue, false,
    "a legacy Session-only view cannot initiate an action missing an explicit Task");
});
