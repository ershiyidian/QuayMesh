import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { WORKSPACE_APP_VERSION } from "../../session/card-contract.js";
import { previewSnapshot } from "./preview.js";
import { createMcpSource } from "./source.js";

for (const initialRevision of [-1, previewSnapshot.rev]) {
  test(`first live handshake fetches the current renderer shape after a legacy bootstrap (revision ${initialRevision})`, async () => {
    const initial = { ...previewSnapshot, taskState: "closed" as const, taskResult: "completed" as const };
    const authoritative = { ...initial, files: initial.files.map(file => ({ ...file, recordedAt: 1234 })) };
    const calls: Array<{name: string; arguments: Record<string, unknown>}> = [];
    const app = { getHostCapabilities: () => ({ serverTools: {} }),
      callServerTool: async (input: typeof calls[number]) => {
        calls.push(input);
        return { content: [], structuredContent: calls.length === 1
          ? { unchanged: false, rev: authoritative.rev, snapshot: authoritative }
          : { unchanged: true, rev: authoritative.rev } };
      },
    } as unknown as App;
    const source = createMcpSource(app, initial.sessionId, initial.taskId!, initial);
    try {
      const snapshot = await source.snapshot(initialRevision);
      assert.equal(calls[0].arguments.since_rev, -1);
      assert.equal(calls[0].arguments.resource_version, WORKSPACE_APP_VERSION);
      assert.equal(calls[0].arguments.file_recorded_at, true);
      assert.equal(snapshot!.files[0].recordedAt, 1234);
      await source.snapshot(authoritative.rev);
      assert.equal(calls[1].arguments.since_rev, authoritative.rev);
      assert.equal(Object.hasOwn(calls[1].arguments, "mount_id"), false);
      assert.equal(calls[1].arguments.file_recorded_at, true);
    } finally { source.dispose(); }
  });
}

for (const first of ["older", "unchanged", "wrong-task"] as const) {
  test(`an invalid first ${first} reply does not consume the renderer shape negotiation`, async () => {
    const initial = { ...previewSnapshot, rev: 9 };
    const current = { ...initial, files: initial.files.map(file => ({ ...file, recordedAt: 1234 })) };
    const calls: Array<{name: string; arguments: Record<string, unknown>}> = [];
    const app = { getHostCapabilities: () => ({ serverTools: {} }),
      callServerTool: async (input: typeof calls[number]) => {
        calls.push(input);
        const invalid = first === "unchanged" ? { unchanged: true, rev: initial.rev }
          : { unchanged: false, snapshot: { ...initial, ...(first === "older" ? {rev: 8} : {taskId: "other-task"}) } };
        return { content: [], structuredContent: calls.length === 1 ? invalid : { unchanged: false, snapshot: current } };
      },
    } as unknown as App;
    const source = createMcpSource(app, initial.sessionId, initial.taskId!, initial);
    try {
      await assert.rejects(source.snapshot(initial.rev), /FIRST_SNAPSHOT|IDENTITY_MISMATCH/);
      const snapshot = await source.snapshot(initial.rev);
      assert.deepEqual(calls.map(call => call.arguments.since_rev), [-1, -1]);
      assert.equal(calls[0].arguments.mount_id, calls[1].arguments.mount_id);
      assert.equal(snapshot!.files[0].recordedAt, 1234);
      await source.snapshot(initial.rev, undefined, undefined, '{"files":"last-file"}');
      assert.equal(calls[2].arguments.cursor, '{"files":"last-file"}');
      assert.equal(calls[2].arguments.file_recorded_at, true, "file pages retain the same explicit capability");
    } finally { source.dispose(); }
  });
}
