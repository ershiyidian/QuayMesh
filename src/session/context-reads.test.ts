import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../db/client.js";
import type { Workspace } from "../workspaces.js";
import { ContextReadRecorder } from "./context-reads.js";
import { createInvocationContext } from "./invocations.js";
import { SessionStore } from "./store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-context-"));
  const root = join(directory, "project");
  await mkdir(root, { recursive: true });
  const database = openDatabase(join(directory, "state"));
  const store = new SessionStore(database.sqlite);
  const session = store.createSession("owner-a", "conversation-context", "context");
  const member = store.addMember(session.id, "desktop", "workspace-a", root, "checkout", null);
  return {
    directory,
    root,
    database,
    store,
    session,
    member,
    async close() {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function workspace(root: string, skills: Array<{ name: string; filePath: string }>): Workspace {
  return {
    id: "workspace-a",
    root,
    canonicalRoot: root,
    mode: "checkout",
    skills: skills.map((skill) => ({ ...skill, filePath: skill.filePath, description: "A real skill." })) as Workspace["skills"],
    skillDiagnostics: [],
    agentProfiles: [],
  };
}

function modelContext(f: Awaited<ReturnType<typeof fixture>>, toolName: string) {
  return createInvocationContext({
    auth: { owner_id: "owner-a" },
    transport: { instance_id: "transport-context" },
    request: { id: toolName, conversation_id: "conversation-context", actor: "model", tool_name: toolName },
    session: { session_id: f.session.id, member_id: f.member.id, workspace_id: "workspace-a" },
  });
}

test("discovery records loaded and available instructions without claiming nested reads", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const globalFile = join(f.directory, "AGENTS.md");
  const rootFile = join(f.root, "AGENTS.md");
  const nestedFile = join(f.root, "src", "CLAUDE.md");
  await mkdir(join(f.root, "src"), { recursive: true });
  await writeFile(globalFile, "global rules\n");
  await writeFile(rootFile, "root rules\n");
  await writeFile(nestedFile, "nested rules\n");
  const recorder = new ContextReadRecorder(f.store);
  recorder.registerDiscovered({
    sessionId: f.session.id,
    memberId: f.member.id,
    workspace: workspace(f.root, []),
    loadedAgentsFiles: [
      { path: globalFile, content: "global rules\n" },
      { path: rootFile, content: "root rules\n" },
    ],
    availableAgentsFiles: [{ path: nestedFile }],
  });

  const instructions = recorder.instructions(f.session.id, f.member.id);
  assert.equal(instructions.find((item) => item.path === globalFile)?.status, "loaded");
  assert.equal(instructions.find((item) => item.path === rootFile)?.status, "loaded");
  assert.equal(instructions.find((item) => item.path === nestedFile)?.status, "available");
  const nested = f.store.contextReads(f.session.id, f.member.id).find((row) => row.path === nestedFile);
  assert.equal(nested?.state, "available");
  assert.equal(nested?.read_count, 0);
});

test("model reads count once for a complete read and ranges only update observation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const nestedFile = join(f.root, "CLAUDE.md");
  await writeFile(nestedFile, "nested rules\n");
  const recorder = new ContextReadRecorder(f.store);
  recorder.registerDiscovered({
    sessionId: f.session.id,
    memberId: f.member.id,
    workspace: workspace(f.root, []),
    loadedAgentsFiles: [],
    availableAgentsFiles: [{ path: nestedFile }],
  });
  const context = modelContext(f, "read");
  recorder.recordHostRead(context, nestedFile, "nested rules\n");
  let row = f.store.contextReads(f.session.id, f.member.id).find((item) => item.path === nestedFile && item.actor_id === "model");
  assert.equal(row?.state, "read");
  assert.equal(row?.read_count, 1);
  const hostRow = f.store.contextReads(f.session.id, f.member.id).find((item) => item.path === nestedFile && item.actor_id === "host");
  assert.equal(hostRow?.state, "available");
  assert.equal(hostRow?.read_count, 0);

  const partial = { ...context, invocation_id: "read-partial" };
  recorder.recordHostRead(partial, nestedFile, "nested", { start: 0, end: 6 });
  row = f.store.contextReads(f.session.id, f.member.id).find((item) => item.path === nestedFile && item.actor_id === "model");
  assert.equal(row?.state, "read");
  assert.equal(row?.read_count, 1);
});

test("card instruction reads do not increment model reads or skill uses", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const skillPath = join(f.root, "skills", "reviewer", "SKILL.md");
  const instructionPath = join(f.root, "AGENTS.md");
  await mkdir(join(f.root, "skills", "reviewer"), { recursive: true });
  await writeFile(skillPath, "reviewer skill\n");
  await writeFile(instructionPath, "workspace rules\n");
  const recorder = new ContextReadRecorder(f.store);
  recorder.registerDiscovered({
    sessionId: f.session.id,
    memberId: f.member.id,
    workspace: workspace(f.root, [{ name: "reviewer", filePath: skillPath }]),
    loadedAgentsFiles: [{ path: instructionPath, content: "workspace rules\n" }],
    availableAgentsFiles: [],
  });

  const instruction = await recorder.readForCard(f.session.id, f.member.id, instructionPath);
  const skill = await recorder.readForCard(f.session.id, f.member.id, skillPath);
  assert.equal(instruction?.content, "workspace rules\n");
  assert.equal(skill?.content, "reviewer skill\n");
  const instructionRow = f.store.contextReads(f.session.id, f.member.id).find((row) => row.path === instructionPath && row.actor_id === "host");
  const skillRow = f.store.contextReads(f.session.id, f.member.id).find((row) => row.path === skillPath && row.actor_id === "host");
  assert.equal(instructionRow?.read_count, 0);
  assert.equal(skillRow?.read_count, 0);
  assert.equal(recorder.skills(f.session.id, f.member.id).find((skill) => skill.actor_id === "host")?.uses, null);
});

test("historical task context stays fixed after the underlying file changes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const instructionPath = join(f.root, "AGENTS.md");
  await writeFile(instructionPath, "rules v1\n");
  const task = f.store.createTask(f.session.id, "first task");
  const recorder = new ContextReadRecorder(f.store);
  recorder.registerDiscovered({
    sessionId: f.session.id,
    memberId: f.member.id,
    workspace: workspace(f.root, []),
    loadedAgentsFiles: [{ path: instructionPath, content: "rules v1\n" }],
    availableAgentsFiles: [],
  });
  f.store.archiveTask(task.id,"superseded");
  await writeFile(instructionPath, "rules v2\n");
  assert.equal((await recorder.readForCard(f.session.id, f.member.id, instructionPath, task.id))?.content, "rules v1\n");
});

test("model skill reads increment a truthful read count and empty discoveries stay empty", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const skillPath = join(f.root, "skills", "reviewer", "SKILL.md");
  await mkdir(join(f.root, "skills", "reviewer"), { recursive: true });
  await writeFile(skillPath, "reviewer skill\n");
  const recorder = new ContextReadRecorder(f.store);
  recorder.registerDiscovered({
    sessionId: f.session.id,
    memberId: f.member.id,
    workspace: workspace(f.root, [{ name: "reviewer", filePath: skillPath }]),
    loadedAgentsFiles: [],
    availableAgentsFiles: [],
  });
  const context = modelContext(f, "read-skill");
  recorder.recordHostRead(context, skillPath, "reviewer skill\n");
  recorder.recordHostRead({ ...context, invocation_id: "read-skill-2" }, skillPath, "reviewer skill\n");
  const skill = recorder.skills(f.session.id, f.member.id).find((entry) => entry.actor_id === "model");
  assert.equal(skill?.state, "read");
  assert.equal(skill?.uses, 2);

  const empty = await fixture();
  t.after(() => empty.close());
  const emptyRecorder = new ContextReadRecorder(empty.store);
  emptyRecorder.registerDiscovered({
    sessionId: empty.session.id,
    memberId: empty.member.id,
    workspace: workspace(empty.root, []),
    loadedAgentsFiles: [],
    availableAgentsFiles: [],
  });
  assert.deepEqual(emptyRecorder.instructions(empty.session.id, empty.member.id), []);
  assert.deepEqual(emptyRecorder.skills(empty.session.id, empty.member.id), []);
});

test("existing skill symlinks and targets are not changed by discovery", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const target = join(f.directory, "skill-target");
  const link = join(f.root, "skill-link");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), "linked skill\n");
  await symlink(target, link, "junction");
  const recorder = new ContextReadRecorder(f.store);
  recorder.registerDiscovered({
    sessionId: f.session.id,
    memberId: f.member.id,
    workspace: workspace(f.root, [{ name: "linked", filePath: join(link, "SKILL.md") }]),
    loadedAgentsFiles: [],
    availableAgentsFiles: [],
  });
  assert.equal(await readFile(join(link, "SKILL.md"), "utf8"), "linked skill\n");
  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "linked skill\n");
});
