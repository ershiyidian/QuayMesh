import assert from "node:assert/strict";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import express from "express";
import { chromium } from "@playwright/test";
import { createTwoFilesPatch } from "diff";
import { diffPage } from "../../src/console-workbench/diff.js";
import { ProcessSessionManager } from "../../src/process-sessions.js";
import { WorkLedger } from "../../src/work-ledger.js";
import { workspaceHandle } from "../../src/federation/routing.js";
import { callOpen, createRealTestServer, structured, freePort, waitForFixture, waitForRecordedTool } from "../session-card/server-fixture.js";

test("Console v5 reads all recorded tasks and renders real file, command and review data", { timeout: 120_000 }, async (t) => {
  const fixture = await createRealTestServer({ prefix: "quaymesh-console-v5-", files: { "AGENTS.md": "使用当前项目的数据。\n" } });
  const ledger = new WorkLedger(fixture.config.stateDir);
  const manager=new ProcessSessionManager({stateDir:fixture.config.stateDir});
  t.after(async () => { await manager.shutdown(); ledger.close(); await fixture.dispose(); });
  const origin = { entryPoint: "console" as const, evidence: "server_entry" as const };
  const early = ledger.begin({ root: fixture.project, workItemId: "early", runKey: "early", title: "较早开始的工作", origin });
  const oldTime = new Date(Date.now() - 40 * 86400000).toISOString();
  ledger.db.prepare("UPDATE console_work_runs SET created_at=? WHERE id=?").run(oldTime, early.id);
  for (let index = 0; index < 65; index++) {
    const run = ledger.begin({ root: fixture.project, workItemId: `record-${index}`, runKey: `record-${index}`, title: `已完成记录 ${index}`, origin });
    ledger.finish(run.id, { status: "completed", acceptance: "not_applicable", summary: "保存任务记录", evidence: [] });
  }
  const login = await fetch(fixture.baseUrl + "/console/api/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: fixture.baseUrl }, body: JSON.stringify({ password: "test-owner-token-that-is-long-enough" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const auth = await login.json() as { csrf: string; contract: string };
  assert.equal(auth.contract, "quaymesh.console.v4");
  async function api(path: string, body?: unknown) {
    const response = await fetch(fixture.baseUrl + "/console/api/v4/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, Origin: fixture.baseUrl, "Content-Type": "application/json", "X-QuayMesh-CSRF": auth.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }

  const silent=join(fixture.root,"silent-early.mjs");
  await writeFile(silent,"setInterval(()=>{},1000);");
  await manager.start({workspaceId:"early",cwd:fixture.project,workspaceRoot:fixture.project,workRunId:early.id,
    command:`"${process.execPath}" "${silent}"`,yieldTimeMs:0});
  await t.test("active tasks are independent of recent rows, and pages cover the full history", async () => {
    const overview = await api("overview?tz=Asia%2FShanghai");
    assert.equal(overview.runningCount, 1);
    assert.equal(overview.active[0].localId, early.id);
    const first = await api("runs?days=0&limit=25");
    assert.equal(first.total, 66);
    const ids = first.items.map((item: any) => item.id);
    for (let cursor = first.nextCursor; cursor;) {
      const page = await api("runs?days=0&limit=25&cursor=" + cursor);
      ids.push(...page.items.map((item: any) => item.id)); cursor = page.nextCursor;
    }
    assert.equal(new Set(ids).size, 66);
    const olderActive = await api("runs?days=1&status=running");
    assert.equal(olderActive.items[0].localId, early.id);
    assert.equal((await api("runs?days=0&q=" + encodeURIComponent("较早开始"))).total, 1);
  });

  await manager.shutdown();

  await t.test("a large saved patch is paged as complete display rows", () => {
    const next = Array.from({ length: 1200 }, (_, index) => `中文代码行 ${index}`).join("\n") + "\n";
    const patch = createTwoFilesPatch("a/large.txt", "b/large.txt", "", next);
    let cursor: string | undefined;
    const text: string[] = [];
    do {
      const page = diffPage(patch, cursor);
      assert.ok(page.rows.length <= 400);
      text.push(...page.rows.map((row) => row.text));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(text.join("\n") + "\n", next);
  });

  const meta = { "openai/session": "console-v5-real-work" };
  const opened = structured(await callOpen(fixture.client, fixture.project, "console-v5-real-work"));
  const scope = { sessionId: String(opened.session_id), workspaceId: String(opened.workspace_id),
    conversationId: "console-v5-real-work", paths: ["owned-a.ts", "owned-b.ts", "command.mjs"] };
  const patch = ["*** Begin Patch", "*** Add File: owned-a.ts", "+export const answer = 42;", "*** Add File: owned-b.ts", "+export const preserved = true;", "*** End Patch"].join("\n");
  const changed = await fixture.client.callTool({ name: "apply_patch", arguments: { workspace_id: opened.workspace_id, patch }, _meta: meta });
  await waitForRecordedTool(fixture, scope, changed);
  await writeFile(join(fixture.project, "command.mjs"), "process.stdout.write('真实命令输出\\n');\n");
  const command = `"${process.execPath}" "${join(fixture.project, "command.mjs")}"`;
  const executed = await fixture.client.callTool({ name: "exec_command", arguments: { workspace_id: opened.workspace_id, cmd: command, yield_time_ms: 1000 }, _meta: meta });
  await waitForRecordedTool(fixture, scope, executed);
  const link = ledger.db.prepare("SELECT run_id FROM qm_run_links WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(opened.session_id) as { run_id: string };
  assert.ok(link);
  const runId = workspaceHandle(fixture.config.federation?.nodeId ?? "local", link.run_id);
  const detail = await waitForFixture(fixture, scope, "settled file capture and completed command in run detail",
    () => api("runs/" + encodeURIComponent(runId)), value =>
      ["owned-a.ts", "owned-b.ts"].every(path => value.files.some((file: any) => file.path === path))
      && value.commands.some((row: any) => row.status === "done")
      && value.changeCaptures.length > 0
      && value.changeCaptures.every((capture: any) => capture.state === "idle"));

  await t.test("saved changes, output and selected-file revert use the real run and member", async () => {
    assert.equal(detail.commands.length, 1);
    assert.equal(detail.commands[0].command, command);
    assert.equal(detail.commands[0].exit, 0);
    const output = await api(`runs/${encodeURIComponent(runId)}/commands/${encodeURIComponent(detail.commands[0].id)}?cursor=0`);
    assert.equal(output.chunk, "真实命令输出\n");
    const file = detail.files.find((file: any) => file.path === "owned-a.ts");
    assert.ok(file, JSON.stringify(detail.files));
    const diff = await api(`runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(file.id)}`);
    assert.ok(diff.file.rows.some((row: any) => row.text.includes("answer = 42")));
    const fileLink = structured(await fixture.client.callTool({ name: "qm_file_url", arguments: {
      session_id: opened.session_id, member_id: opened.member_id, path: file.path,
    } }));
    assert.equal(new URLSearchParams(new URL(String(fileLink.url)).hash.split('?')[1]).get('run'), runId);
    assert.ok(detail.instructions.some((entry: any) => entry.path.endsWith("AGENTS.md")));
    const preview = await api("runs/revert/preview", { id: runId, expectedRevision: detail.run.revision, files: [file.id], requestKey: "console-preview" });
    const receipt = await api("runs/revert/commit", { previewId: preview.id, confirmationHash: preview.hash, requestKey: "console-revert" });
    assert.equal(receipt.status, "completed");
    await assert.rejects(stat(join(fixture.project, "owned-a.ts")), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.project, "owned-b.ts"), "utf8"), "export const preserved = true;\n");
  });

  if (process.env.QUAYMESH_CONSOLE_UI_DIR) await t.test("production Console layout reads real APIs without demo data", async () => {
    const app = express();
    app.use("/console", (_req, res, next) => { res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'"); next(); });
    app.use("/console", express.static(resolve(process.env.QUAYMESH_CONSOLE_UI_DIR!), { index: "console.html" }));
    app.use(fixture.running.app);
    const port = await freePort();
    const server = app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/console/`);
      await page.locator('input[name="password"]').fill("test-owner-token-that-is-long-enough");
      await page.locator('#login-form button[type="submit"]').click();
      await page.locator('.overview-page h1').waitFor();
      assert.equal(await page.evaluate(() => (window as any).QuayMesh.getState().mode), "live");
      await page.locator('[data-action="nav"][data-view="tasks"]').first().click();
      await page.locator('.run-table tbody tr').first().waitFor();
      await page.locator('#query-search').fill("较早开始");
      await page.waitForFunction(() => document.querySelectorAll('.run-table tbody tr').length === 1);
      await page.locator('.run-table .run-title').first().click();
      await page.locator('.inspector .session-heading h2').waitFor();
      for (const view of ["machines", "workspaces", "sessions", "activity", "usage", "settings", "overview"]) {
        await page.locator(`#sidebar nav [data-view="${view}"]`).click();
        await page.waitForFunction((view) => (window as any).QuayMesh.getState().route.view === view, view);
        await page.waitForTimeout(150);
      }
      await page.locator('.overview-page .metric').first().waitFor();
      assert.deepEqual(errors, []);
      assert.equal(await page.locator('text=演示数据').count(), 0);
      const directory = resolve(".planning/console-v5-20260928");
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: join(directory, "console-v5-real-api.png"), fullPage: true });
      const legacy = new URLSearchParams({ view: "changes", node: fixture.config.federation?.nodeId ?? "local", run: link.run_id, tab: "diff" });
      await page.goto(`http://127.0.0.1:${port}/console/?${legacy}`);
      await page.locator('.file-header').first().waitFor();
      assert.equal(await page.evaluate(() => (window as any).QuayMesh.getState().route.p.run), runId);
      await page.screenshot({ path: join(directory, "console-v5-real-diff.png"), fullPage: true });
      const sessionLink = new URLSearchParams({ session: String(opened.session_id), root: detail.run.root, file: "owned-b.ts" });
      await page.goto(`http://127.0.0.1:${port}/console/?${sessionLink}`);
      await page.locator('.file-header').first().waitFor();
      assert.equal(await page.evaluate(() => (window as any).QuayMesh.getState().route.p.run), runId);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
