import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import { SessionStore } from "./store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-binding-"));
  const root = join(directory, "project");
  await mkdir(root, { recursive: true });
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  return {
    root,
    store,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("workspace binding refuses an ambiguous session only when conversation identity is absent", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first = f.store.createSession("owner-a", "conversation-one", "first");
  const second = f.store.createSession("owner-a", "conversation-two", "second");
  const firstMember = f.store.addMember(first.id, "desktop", "workspace-shared", f.root, "checkout", null);
  const secondMember = f.store.addMember(second.id, "desktop", "workspace-shared", f.root, "checkout", null);

  assert.throws(
    () => f.store.resolveMemberForWorkspace({ ownerId: "owner-a", conversationId: null, workspaceIds: ["workspace-shared"] }),
    /SESSION_BINDING_AMBIGUOUS/,
  );

  const unique = f.store.resolveMemberForWorkspace({
    ownerId: "owner-a",
    conversationId: "conversation-two",
    workspaceIds: ["workspace-shared"],
  });
  assert.equal(unique?.sessionId, second.id);
  assert.equal(unique?.member.id, secondMember.id);

  const otherOwner = f.store.resolveMemberForWorkspace({
    ownerId: "owner-b",
    conversationId: null,
    workspaceIds: ["workspace-shared"],
  });
  assert.equal(otherOwner, null);

  const missing = f.store.resolveMemberForWorkspace({
    ownerId: "owner-a",
    conversationId: "conversation-three",
    workspaceIds: ["workspace-shared"],
  });
  assert.equal(missing, null);

  const remote = f.store.createSession("owner-a", "conversation-remote", "remote");
  const remoteMember = f.store.addMember(remote.id, "node-b", "workspace-shared", f.root, "checkout", null);
  const remoteMatch = f.store.resolveMemberForWorkspace({
    ownerId: "owner-a",
    conversationId: "conversation-remote",
    workspaceIds: ["node-b:workspace-shared", "workspace-shared"],
    nodeId: "node-b",
  });
  assert.equal(remoteMatch?.member.id, remoteMember.id);
  assert.notEqual(firstMember.id, remoteMember.id);
});
