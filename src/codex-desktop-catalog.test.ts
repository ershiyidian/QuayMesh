import assert from "node:assert/strict";
import test from "node:test";
import { inspectDesktopCatalog } from "./codex-desktop-catalog.js";
import { projectPathKey, registerProject } from "./codex-projects.js";

const home = "C:\\Users\\fixture\\.codex", root = "D:\\projects\\voice-memory";
const state = { "local-projects": { client: { id: "client", name: "voice-memory", rootPaths: [root], createdAt: 1, updatedAt: 1 } },
  "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { client: "canonical" } },
  "thread-project-assignments": { original: { projectKind: "local", projectId: "client" } }, future: "preserve" };

test("app-server registration is not Desktop client registration", () => {
  assert.throws(() => inspectDesktopCatalog({ "local-projects": {} }, [root], home, projectPathKey), /has not saved/);
  assert.throws(() => inspectDesktopCatalog({ "local-projects": [] }, [root], home, projectPathKey));
  assert.throws(() => inspectDesktopCatalog({ ...state, "app-server-project-id-by-legacy-project-id-by-host": {} }, [root], home, projectPathKey), /mapping/);
  assert.deepEqual(inspectDesktopCatalog(state, ["d:/projects/voice-memory"], home, projectPathKey),
    { clientProjectId: "client", projectId: "canonical", threadIds: ["original"] });
  assert.equal(state.future, "preserve");
});

test("a saved parent project covers a nested QuayMesh workspace without opening another Desktop project", () => {
  const parent = "E:\\Projects";
  const nested = "E:\\Projects\\quaymesh-main";
  const value = {
    "local-projects": { parent: { id: "parent", name: "Projects", rootPaths: [parent], createdAt: 1, updatedAt: 1 } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { parent: "canonical-parent" } },
  };
  assert.deepEqual(inspectDesktopCatalog(value, [nested], home, projectPathKey),
    { clientProjectId: "parent", projectId: "canonical-parent", threadIds: [] });
});

test("client assignment disambiguates an earlier server-only registration without creating or deleting projects", async () => {
  const projects = ["server-only", "canonical"].map(id => ({ id, name: "voice-memory", roots: [{ path: root }], createdAt: 1, updatedAt: 1, position: 0, metadata: {} }));
  const thread = { id: "original", cwd: root, projectId: "server-only" };
  const methods: string[] = [];
  const receipt = await registerProject({ home, command: "fixture", close: async () => {}, request: async (method, params: any) => {
    methods.push(method);
    if (method === "project/list") return { data: projects, nextCursor: null };
    if (method === "project/read") return { project: projects.find(p=>p.id===params.projectId) };
    if (method === "thread/read") return { thread: { ...thread } };
    if (method === "thread/metadata/update") { thread.projectId = params.projectId; return {}; }
    throw new Error("Unexpected mutation");
  } }, { roots: [root], expectedHome: home, threadIds: ["original"], desktopCatalog: inspectDesktopCatalog(state, [root], home, projectPathKey) });
  assert.equal(receipt.status, "persisted_registration");
  assert.equal(receipt.clientRegistration, "verified");
  assert.equal(receipt.projectId, "canonical");
  assert.equal(thread.projectId, "canonical");
  assert(!methods.includes("project/create"));
});
