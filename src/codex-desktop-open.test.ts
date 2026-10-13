import assert from "node:assert/strict";
import test from "node:test";
import { desktopWorkspaceLink, ensureClientProject, type DesktopOpenRuntime } from "./codex-desktop-open.js";
import { DesktopMappingPendingError, DesktopProjectMissingError } from "./codex-desktop-catalog.js";

const root = "D:\\projects\\voice memory & prompt=not-an-instruction";
const catalog = { clientProjectId: "client", projectId: "server", threadIds: ["original"] };
function fixture(missing: number): { runtime: DesktopOpenRuntime; links: string[] } {
  let reads = 0, now = 0; const links: string[] = [];
  return { links, runtime: {
    read: async () => { if (reads++ < missing) throw new DesktopProjectMissingError(); return catalog; },
    open: async (link) => { links.push(link); }, pause: async () => { now += 250; }, now: () => now,
  } };
}
test("workspace link only opens a directory draft and encodes all path metacharacters", () => {
  const link = new URL(desktopWorkspaceLink(root));
  assert.equal(link.protocol, "codex:"); assert.equal(link.hostname, "threads");
  assert.equal(link.searchParams.get("path"), root);
  assert.deepEqual([...link.searchParams.keys()], ["path"]);
  assert.throws(() => desktopWorkspaceLink("relative/path"));
  assert.throws(() => desktopWorkspaceLink("D:\\bad\npath"));
});
test("missing client project opens once and requires real saved mapping before success", async () => {
  const f = fixture(3);
  const result = await ensureClientProject([root], f.runtime);
  assert.equal(result.creation, "requested_and_verified"); assert.deepEqual(result.catalog, catalog);
  assert.equal(f.links.length, 1);
  assert.equal((await ensureClientProject([root], f.runtime)).creation, "existing");
  assert.equal(f.links.length, 1);
});
test("schema/ambiguous mapping errors and missing multi-root projects never open a workspace", async () => {
  for (const error of [new Error("unsupported client schema"), new DesktopMappingPendingError()]) {
    const f = fixture(0); f.runtime.read = async () => { throw error; };
    await assert.rejects(ensureClientProject([root], f.runtime)); assert.equal(f.links.length, 0);
  }
  const f = fixture(100);
  await assert.rejects(ensureClientProject([root, "D:\\other"], f.runtime), /multi-root/);
  assert.equal(f.links.length, 0);
});
test("launcher success alone and a silent client never become registration success", async () => {
  const f = fixture(100);
  await assert.rejects(ensureClientProject([root], f.runtime, 500), /not yet verified/);
  assert.equal(f.links.length, 1);
});
