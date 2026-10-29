import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as z from "zod/v4";
import { openDatabase } from "../db/client.js";
import { SessionFeed } from "../federation/session-feed.js";
import type { FederationRuntime } from "../federation/runtime.js";
import type { SessionFeedRequest, SessionFeedUpdate } from "../federation/session-types.js";
import { SessionProjector } from "./projection.js";
import { commandSchema, fileSchema } from "./schema.js";
import type { SessionService, TaskOwnerReceipt } from "./service.js";
import { SessionStore } from "./store.js";

const readers = [
  { peer: "legacy", command_identity: false, file_recorded_at: false },
  { peer: "command-only", command_identity: true, file_recorded_at: false },
  { peer: "file-only", command_identity: false, file_recorded_at: true },
  { peer: "current", command_identity: true, file_recorded_at: true },
];
const oldFile = fileSchema.omit({ recordedAt: true }).strict();
const oldStoredFile = oldFile.extend({ patchRef: z.string(), versionRef: z.string() }).strict();
const oldCommand = commandSchema.omit({ invocation_id: true, effect: true }).strict();

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "qm-file-time-feed-")), root = join(directory, "project"), stateDir = join(directory, "state");
  await mkdir(root);
  const database = openDatabase(stateDir), store = new SessionStore(database.sqlite);
  const projector = new SessionProjector(store, stateDir, null, undefined, "worker");
  let feed: SessionFeed | undefined;
  t.after(async () => { await feed?.close(); await projector.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const session = store.createSession("owner", "file-wire", "File wire");
  const member = store.addMember(session.id, "worker", "workspace", root, "checkout", null);
  const task = store.createTask(session.id, "Task file wire", "task-file-wire");
  store.touchTaskMember(task.id, member.id);
  store.putChangeBaseline({ session_id: session.id, member_id: member.id, repo_root: root,
    baseline_ref: "base", latest_ref: "current", coverage: "partial" }, task.id);
  store.replaceFileSummaries(session.id, member.id, "current", [{
    id: "file-a", member_id: member.id, path: "a.txt", from: null, status: "M", hash: "hash-a",
    additions: 1, removals: 0, binary: false, large: false, coverage: "partial", revertible: false,
    patchRef: join(stateDir, "patch"), recordedAt: 1234,
  }], task.id);
  for (const [type, payload] of [
    ["operation_started", { operation_id: "operation-a", invocation_id: "invocation-a", kind: "command", label: "Command", actor: "model" }],
    ["operation_finished", { operation_id: "operation-a", invocation_id: "invocation-a", status: "succeeded", effect: "completed", exit_code: 0 }],
  ] as const) store.appendEvent({ session_id: session.id, task_id: task.id, member_id: member.id,
    type, source_id: type, timestamp: new Date().toISOString(), payload });
  const snapshot = await projector.materialize(session.id, member.id, task.id);
  assert.equal(snapshot.files[0].recordedAt, 1234);
  const receipt: TaskOwnerReceipt = { taskId: task.id, nodeId: "worker", backgroundRuns: [], activeWork: 0,
    snapshots: [{ memberId: member.id, revision: snapshot.rev, snapshot, files: store.fileSummaries(session.id, member.id, task.id) }] };
  const notifications = new Map<string, SessionFeedUpdate[]>();
  const links = new Map(readers.map(reader => [reader.peer, { notify(_method: string, value: SessionFeedUpdate) {
    const values = notifications.get(reader.peer) ?? []; values.push(value); notifications.set(reader.peer, values);
  } }]));
  const runtime = Object.assign(new EventEmitter(), { localId: "worker", config: {},
    transport: Object.assign(new EventEmitter(), { links }), setSessionFeed() {} });
  const service = { setRemoteFinalizer() {}, setRemoteArchiver() {}, finishOwnedTask: async () => receipt, archiveOwnedTask: async () => receipt };
  feed = new SessionFeed(runtime as unknown as FederationRuntime, store, projector, service as unknown as SessionService);
  const request = { session_id: session.id, member_id: member.id, task_id: task.id };
  return { feed, store, snapshot, receipt, notifications, request, session, member, task };
}

function checkSnapshot(update: SessionFeedUpdate, reader: typeof readers[number]) {
  const snapshot = update.snapshot!;
  assert.ok(snapshot);
  if (reader.file_recorded_at) assert.equal(snapshot.files[0].recordedAt, 1234);
  else { oldFile.parse(snapshot.files[0]); assert.equal(Object.hasOwn(snapshot.files[0], "recordedAt"), false); }
  if (reader.command_identity) assert.equal(snapshot.commands[0].invocation_id, "invocation-a");
  else oldCommand.parse(snapshot.commands[0]);
}

test("file evidence time negotiates independently from command identity for snapshots and pushes", async t => {
  const f = await fixture(t);
  for (const reader of readers) {
    const request: SessionFeedRequest = { ...f.request, kind: "subscribe",
      ...(reader.command_identity ? { command_identity: true } : {}),
      ...(reader.file_recorded_at ? { file_recorded_at: true } : {}),
    };
    checkSnapshot(await f.feed.handleRequest(request, reader.peer) as SessionFeedUpdate, reader);
  }
  const publish = f.feed as unknown as { publishLocalChange(sessionId: string, memberId: string, revision: number, taskId: string): void };
  publish.publishLocalChange(f.session.id, f.member.id, f.snapshot.rev, f.task.id);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  for (const reader of readers) {
    assert.ok(f.notifications.get(reader.peer)?.length);
    checkSnapshot(f.notifications.get(reader.peer)![0], reader);
  }
  assert.equal(f.store.taskData.projection(f.task.id, f.member.id)!.snapshot.files[0].recordedAt, 1234);
});

test("finalize/archive receipts adapt both the snapshot and stored-file arrays without mutating owner evidence", async t => {
  const f = await fixture(t);
  for (const kind of ["finalize", "archive"] as const) for (const reader of readers) {
    const reply = await f.feed.handleRequest({ ...f.request, kind, owner_id: "owner", status: "completed", summary: "done",
      command_identity: reader.command_identity, file_recorded_at: reader.file_recorded_at }, reader.peer) as TaskOwnerReceipt;
    const saved = reply.snapshots[0];
    checkSnapshot({ snapshot: saved.snapshot } as SessionFeedUpdate, reader);
    if (reader.file_recorded_at) assert.equal(saved.files[0].recordedAt, 1234);
    else { oldStoredFile.parse(saved.files[0]); assert.equal(Object.hasOwn(saved.files[0], "recordedAt"), false); }
  }
  assert.equal(f.receipt.snapshots[0].snapshot.files[0].recordedAt, 1234);
  assert.equal(f.receipt.snapshots[0].files[0].recordedAt, 1234);
});
