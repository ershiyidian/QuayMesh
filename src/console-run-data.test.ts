import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { applyPatch } from "./apply-patch.js";
import { WorkLedger } from "./work-ledger.js";
import { trackedWork } from "./tool-surfaces/work-task.js";
import { recordPatchChanges } from "./console-run-data.js";
import { createProjectConsoleRouter } from "./project-console-router.js";
import type { ServerConfig } from "./config.js";

async function removeStateDir(directory: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw last;
}


test("actual edits retain per-operation patches, statistics and HTTP task details", { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-console-edits-"));
  const root = join(directory, "project");
  const stateDir = join(directory, "state");
  await mkdir(join(root, ".git"), { recursive: true });
  const ledger = new WorkLedger(stateDir);
  let httpServer: import("node:http").Server | undefined;
  let consoleApi: ReturnType<typeof createProjectConsoleRouter> | undefined;
  t.after(async () => {
    httpServer?.closeAllConnections();
    if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    consoleApi?.close();
    try { ledger.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* already closed */ }
    ledger.close();
    await removeStateDir(directory);
  });
  const run = ledger.begin({ root, workspaceId: "ws-console-test", workItemId: "edits", runKey: "first", title: "修改实际测试文件",
    origin: { entryPoint: "console", evidence: "server_entry" } });
  const edit = (patch: string, requestKey: string) => trackedWork(stateDir, run.id, { root, workspaceId: "ws-console-test" }, "apply_patch",
    () => applyPatch(root, patch), { argumentFingerprint: requestKey, selectionCount: 0, requestKey,
      recordResult: (result, operationId) => recordPatchChanges(stateDir, operationId, result) });
  const firstPatch = "*** Begin Patch\n*** Add File: greeting.txt\n+hello\n+world\n*** Add File: count.txt\n+1\n*** End Patch";
  await edit(firstPatch, "first");
  assert.equal(await readFile(join(root, "greeting.txt"), "utf8"), "hello\nworld\n");
  let detail = ledger.detail(run.project_id, run.id);
  assert.deepEqual(detail.diffStat, { files: 2, additions: 3, deletions: 0 });
  assert.equal(detail.createdAt, run.created_at);
  assert.equal(detail.changeSets.length, 1);
  const originalPatch = detail.changeSets[0]!.patch;
  assert.match(originalPatch, /\+hello/);
  await edit("*** Begin Patch\n*** Update File: greeting.txt\n@@\n-hello\n+welcome\n world\n*** Delete File: count.txt\n*** End Patch", "second");
  detail = ledger.detail(run.project_id, run.id);
  assert.deepEqual(detail.diffStat, { files: 2, additions: 4, deletions: 2 });
  assert.equal(detail.changeSets.length, 2);
  assert.equal(detail.changes, null);
  assert.equal(detail.changeSets[0]!.patch, originalPatch);
  assert(detail.events.some((event) => event.type === "file_change"));
  await writeFile(join(root, "greeting.txt"), "later external edit\n");
  assert.equal(ledger.detail(run.project_id, run.id).changeSets[0]!.patch, originalPatch);
  await assert.rejects(edit(firstPatch, "first"), /RECORDED_OPERATION/);
  assert.equal(await readFile(join(root, "greeting.txt"), "utf8"), "later external edit\n");
  const password = randomUUID();
  const config = { stateDir, allowedRoots: [root], publicBaseUrl: "https://localhost", oauth: { ownerToken: password },
    console: { enabled: true, allowRemote: false, sessionTtlSeconds: 300 } } as ServerConfig;
  consoleApi = createProjectConsoleRouter(config, { assetDirectory: resolve("src/ui") });
  const app = express();
  app.use("/console", consoleApi.router);
  httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const path = `/console/api/projects/${run.project_id}/runs/${run.id}`;
  assert.equal((await fetch(base + path)).status, 401);
  const login = await fetch(base + "/console/api/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const response = await fetch(base + path, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy")!, /style-src 'self' 'unsafe-inline'/);
  assert.match(response.headers.get("content-security-policy")!, /script-src 'self';/);
  const saved = await response.json() as typeof detail;
  assert.equal(saved.changeSets.length, 2);
  assert.deepEqual(saved.diffStat, detail.diffStat);
  assert.equal(saved.changeSets[0]!.patch, originalPatch);
  const overviewResponse = await fetch(base + "/console/api/overview", { headers: { Cookie: cookie } });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json() as { counters: { projects: number; tasks: number }; recentRuns: unknown[] };
  assert.equal(overview.counters.projects, 1);
  assert.equal(overview.counters.tasks, 1);
  assert.equal(overview.recentRuns.length, 1);
  const denied = await fetch(base + "/console/api/logout", { method: "POST", headers: { Origin: base, Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 403);
});

test("older tasks without stored edits remain unknown", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-console-history-"));
  const ledger = new WorkLedger(join(directory, "state"));
  try {
    const run = ledger.begin({ root: directory, workspaceId: "ws-history", workItemId: "history", runKey: "first", title: "历史任务",
      origin: { entryPoint: "console", evidence: "server_entry" } });
    const detail = ledger.detail(run.project_id, run.id);
    assert.equal(detail.diffStat, null);
    assert.equal(detail.changes, null);
    assert.deepEqual(detail.changeSets, []);
    assert.equal(detail.events[0]!.time, run.created_at);
    assert.equal(ledger.listRuns(run.project_id).entries[0]!.createdAt, detail.createdAt);
  } finally {
    try { ledger.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* already closed */ }
    ledger.close();
    await removeStateDir(directory);
  }
});
