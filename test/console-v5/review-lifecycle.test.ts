import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WorkLedger } from "../../src/work-ledger.js";
import { SessionStore } from "../../src/session/store.js";
import { readRunCheckpoint } from "../../src/session/run-checkpoints.js";
import { readRunDetail } from "../../src/console-workbench/detail.js";
import { readLocalPage } from "../../src/console-workbench/local-queries.js";
import { WorkbenchFeed } from "../../src/console-workbench/feed.js";
import { workspaceHandle } from "../../src/federation/routing.js";
import { canonicalWorkspaceRoot } from "../../src/roots.js";
import { callOpen, createRealTestServer, structured } from "../session-card/server-fixture.js";

type Detail = Awaited<ReturnType<typeof readRunDetail>>;

test("accepted work stays immutable after revert and continuation, and nested workspaces stay separate", { timeout: 90_000 }, async (t) => {
  const fixture = await createRealTestServer({ files: { "nested/README.md": "nested\n", "other/README.md": "other\n" } });
  const ledger = new WorkLedger(fixture.config.stateDir);
  const store = new SessionStore(ledger.db);
  t.after(async () => { ledger.close(); await fixture.dispose(); });
  const nodeId = fixture.config.federation?.nodeId ?? "local";
  const login = await fetch(fixture.baseUrl + "/console/api/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: fixture.baseUrl },
    body: JSON.stringify({ password: "test-owner-token-that-is-long-enough" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const { csrf } = await login.json() as { csrf: string };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(fixture.baseUrl + "/console/api/v4/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, Origin: fixture.baseUrl, "Content-Type": "application/json", "X-QuayMesh-CSRF": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value as T;
  }

  const meta = { "openai/session": "review-lifecycle" };
  const openedResponse=await callOpen(fixture.client,fixture.project,"review-lifecycle");
  const opened=structured(openedResponse);
  const sessionId=String(opened.session_id);
  const memberId=store.getSession(sessionId).selected_member_id;
  assert.ok(memberId,"opened workspace must select its actual session member");
  assert.equal((openedResponse._meta as {quaymesh?:{member_id?:string}}|undefined)?.quaymesh?.member_id,memberId);
  async function patch(text: string) {
    const result = await fixture.client.callTool({ name: "apply_patch", arguments: { workspace_id: opened.workspace_id, patch: text }, _meta: meta });
    assert.notEqual(result.isError, true, JSON.stringify(result));
  }
  await patch("*** Begin Patch\n*** Add File: first.ts\n+export const value = 1;\n*** End Patch");
  const linkedRuns=store.runIdsForMember(sessionId,memberId);
  assert.ok(linkedRuns.length>0,`apply_patch succeeded but run linkage is missing: session=${sessionId}, member=${memberId}`);
  const runId = linkedRuns[0]!;
  assert.ok(ledger.run(runId).id===runId,"linked run must exist in the authoritative WorkLedger");
  const reference = workspaceHandle(nodeId, runId);
  const detailPath = "runs/" + encodeURIComponent(reference);
  let detail = await api<Detail>(detailPath);
  for (let index = 0; index < 30 && !detail.files.length; index++) {
    await delay(50); detail = await api<Detail>(detailPath);
  }
  assert.equal(detail.files[0]?.path, "first.ts");
  assert.equal(detail.run.actions.complete, true);

  await t.test("explicit completion creates a durable checkpoint and replays the receipt", async () => {
    const request = { refs: [{ id: reference, expectedRevision: detail.run.revision, completeExecution: true }],
      verdict: "accept", note: "已核对文件内容", requestKey: "accept-first" };
    assert.equal(await readFile(join(fixture.project, "first.ts"), "utf8"), "export const value = 1;\n");
    const receipt = await api<{ results: Array<{ ok: boolean }> }>("runs/review", request);
    assert.equal(receipt.results[0].ok, true, JSON.stringify(receipt));
    assert.deepEqual(await api("runs/review", request), receipt);
    assert.equal(ledger.run(runId).acceptance, "passed");
    assert.ok(readRunCheckpoint(ledger.db, runId));
    assert.equal(store.getSession(sessionId).review_state, "passed");
  });

  const frozen = readRunCheckpoint(ledger.db, runId)!;
  const savedPatch = await readFile(frozen.files[0].patchRef, "utf8");
  await t.test("reverting an accepted file keeps the reviewed history", async () => {
    detail = await api<Detail>(detailPath);
    assert.equal(detail.run.actions.revert, true);
    const preview = await api<{ id: string; hash: string }>("runs/revert/preview", {
      id: reference, expectedRevision: detail.run.revision, files: [detail.files[0].id], requestKey: "preview-first",
    });
    const request = { previewId: preview.id, confirmationHash: preview.hash, requestKey: "revert-first" };
    const receipt = await api<{ status: string }>("runs/revert/commit", request);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(await api("runs/revert/commit", request), receipt);
    await assert.rejects(stat(join(fixture.project, "first.ts")), { code: "ENOENT" });
    const history = await api<Detail>(detailPath);
    assert.equal(history.files[0]?.path, "first.ts");
    assert.equal(history.run.actions.revert, false);
    const download = await api<{ patch: string }>(detailPath + "/patch");
    assert.equal(download.patch, savedPatch);
  });

  await t.test("new work resets review state without rewriting the preceding checkpoint", async () => {
    await patch("*** Begin Patch\n*** Add File: second.ts\n+export const next = 2;\n*** End Patch");
    const nextRun = store.runIdsForMember(sessionId, memberId)[0];
    assert.notEqual(nextRun, runId);
    assert.equal(ledger.run(nextRun).acceptance, "pending");
    assert.equal(store.getSession(sessionId).review_state, "unknown");
    assert.deepEqual(readRunCheckpoint(ledger.db, runId), frozen);
    const history = await api<Detail>(detailPath);
    assert.deepEqual(history.files.map((file) => file.path), ["first.ts"]);
    assert.equal(history.run.sessionId, sessionId);
    assert.equal((await api<{ patch: string }>(detailPath + "/patch")).patch, savedPatch);
  });

  await t.test("repository subdirectories keep exact roots and distinct sessions and projects", async () => {
    const childRoot = join(fixture.project, "nested");
    const siblingRoot = join(fixture.project, "other");
    const childResponse=await callOpen(fixture.client,childRoot,"nested-scope");
    const siblingResponse=await callOpen(fixture.client,siblingRoot,"nested-scope");
    const child={...structured(childResponse),member_id:(childResponse._meta as {quaymesh?:{member_id?:string}}|undefined)?.quaymesh?.member_id};
    const sibling={...structured(siblingResponse),member_id:(siblingResponse._meta as {quaymesh?:{member_id?:string}}|undefined)?.quaymesh?.member_id};
    assert.equal(child.session_id, sibling.session_id);
    assert.ok(child.member_id&&sibling.member_id,"each opened workspace must have a member receipt");
    assert.notEqual(child.member_id, sibling.member_id);
    const member = store.getMember(String(child.session_id), String(child.member_id));
    assert.equal(member.root, canonicalWorkspaceRoot(childRoot));
    const changed = await fixture.client.callTool({ name: "apply_patch", arguments: { workspace_id: child.workspace_id,
      patch: "*** Begin Patch\n*** Add File: inside.txt\n+inside child only\n*** End Patch" }, _meta: { "openai/session": "nested-scope" } });
    assert.notEqual(changed.isError, true, JSON.stringify(changed));
    assert.equal(await readFile(join(childRoot, "inside.txt"), "utf8"), "inside child only\n");
    await assert.rejects(stat(join(fixture.project, "inside.txt")), { code: "ENOENT" });
    const run = ledger.run(store.runIdsForMember(String(child.session_id), String(child.member_id))[0]);
    assert.equal(ledger.getProject(run.project_id).root, canonicalWorkspaceRoot(childRoot));
    assert.notEqual(run.project_id, ledger.run(runId).project_id);
    const foreign = { days: "0", project: workspaceHandle("other-node", run.project_id) };
    assert.equal(readLocalPage(fixture.config, foreign).total, 0);
    const feed = new WorkbenchFeed(fixture.config);
    assert.deepEqual((await feed.runs(foreign)).items, []);
    const task=(await feed.runs({ days: "0", project: workspaceHandle(nodeId, run.project_id) })).items[0];
    assert.ok(task.phaseRefs?.includes(workspaceHandle(nodeId,run.id)));
    assert.equal(task.root,canonicalWorkspaceRoot(childRoot));
    assert.equal(task.projectId,workspaceHandle(nodeId,run.project_id));
  });
});
