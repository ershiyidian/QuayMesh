import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "@playwright/test";
import { createRealTestServer, freePort, structured } from "../../test/session-card/server-fixture.js";
import { translateScreenshot } from "./screenshot-language.js";

const output = resolve("docs/assets/screenshots");
const showcase = resolve("docs/assets/showcase");
const debugOutput = resolve(".quaymesh", "docs-screenshots");
const demoTemp = process.env.QUAYMESH_DOCS_TEMP ?? join(tmpdir(), "quaymesh-readme-demo");
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalToken = process.env.QUAYMESH_CLUSTER_TOKEN;
const untranslated: Record<string, string[]> = {};
process.env.TEMP = demoTemp;
process.env.TMP = demoTemp;
process.env.QUAYMESH_CLUSTER_TOKEN = "docs-" + randomUUID();

type ToolClient = Awaited<ReturnType<typeof createRealTestServer>>["client"];

async function call(client: ToolClient, conversation: string, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({
    name, arguments: args, _meta: { "openai/session": conversation },
  });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  return structured(response);
}

async function recordTask(client: ToolClient, root: string, title: string, file: string, lines: string[], command: string) {
  const conversation = "documentation-showcase";
  const task = await call(client, conversation, "start_session", { title, request_key: randomUUID() });
  const workspace = await call(client, conversation, "open_workspace", { path: root });
  await call(client, conversation, "apply_patch", {
    workspace_id: workspace.workspace_id,
    patch: ["*** Begin Patch", "*** Add File: " + file, ...lines.map(line => "+" + line), "*** End Patch"].join("\n"),
  });
  const commandResult = await call(client, conversation, "exec_command", {
    workspace_id: workspace.workspace_id, cmd: command, yield_time_ms: 1000,
  });
  if (commandResult.running) {
    let cursor = 0;
    let finished = false;
    for (let index = 0; index < 45; index++) {
      const status = await call(client, conversation, "read_output", {
        workspace_id: workspace.workspace_id, operation_id: commandResult.operation_id,
        cursor, wait_ms: 1000,
      });
      cursor = Number(status.next_cursor ?? cursor);
      if (status.done || status.process_done) { finished = true; break; }
    }
    assert.ok(finished, "Command is still running");
  }
  await call(client, conversation, "finish_task", {
    task_id: task.task_id, status: "completed",
    summary: "Completed " + title.toLowerCase() + " and saved its command output.",
  });
}

async function login(page: Page, base: string, token: string) {
  await page.goto(base + "/console/", { waitUntil: "domcontentloaded" });
  await page.locator("#login-form input[name=password]").fill(token);
  await page.locator("#login-form [type=submit]").click();
  await page.locator(".summary-grid").waitFor({ timeout: 25000 });
}

async function visit(page: Page, base: string, view: string) {
  await page.goto(base + "/console/#/" + view, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((value) =>
    (window as unknown as { QuayMesh: { getState(): { route: { view: string } } } })
      .QuayMesh?.getState()?.route?.view === value,
    view.split("?")[0],
  );
  await delay(500);
}

async function visibleChinese(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const texts = new Set<string>();
    const tree = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = tree.nextNode(); node; node = tree.nextNode()) {
      const value = node.textContent?.trim();
      if (value && /[\u3400-\u9fff]/u.test(value) && value.length < 120) texts.add(value);
    }
    for (const element of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
      for (const key of ["title", "placeholder", "aria-label"]) {
        const value = element.getAttribute(key);
        if (value && /[\u3400-\u9fff]/u.test(value) && value.length < 120) texts.add(value);
      }
    }
    return [...texts].sort();
  });
}

async function capture(page: Page, label: string, contentOnly = false) {
  const original = await visibleChinese(page);
  const target = label === "fleet" ? page.locator(".node-grid") : contentOnly ? page.locator("#view") : page;
  // 保留完整截图用于放大，README 展示只截取功能内容，保证正文宽度下仍能读清文字。
  const showcaseClips: Record<string, { x: number; y: number; width: number; height: number }> = {
    overview: { x: 195, y: 55, width: 1225, height: 565 },
    changes: { x: 519, y: 53, width: 906, height: 293 },
    commands: { x: 520, y: 53, width: 905, height: 257 },
    sessions: { x: 195, y: 45, width: 1225, height: 410 },
    workspaces: { x: 195, y: 48, width: 1225, height: 365 },
  };
  const screenshotOptions = label === "task-detail"
    ? { clip: { x: 0, y: 0, width: 1440, height: 585 } }
    : label === "changes"
      ? { clip: { x: 0, y: 0, width: 1440, height: 410 } }
      : label === "workspaces"
        ? { clip: { x: 0, y: 0, width: 1440, height: 455 } }
      : label === "commands" || label === "sessions"
        ? { clip: { x: 0, y: 0, width: 1440, height: 605 } }
      : {};
  await target.screenshot({
    path: resolve(output, "zh-CN", label + ".png"),
    animations: "disabled", ...screenshotOptions,
  });
  if (showcaseClips[label]) {
    await page.screenshot({
      path: resolve(showcase, "zh-CN", label + ".png"),
      animations: "disabled", clip: showcaseClips[label],
    });
  } else if (label === "fleet") {
    await target.screenshot({ path: resolve(showcase, "zh-CN", label + ".png"), animations: "disabled" });
  }
  untranslated[label] = await translateScreenshot(page);
  await target.screenshot({
    path: resolve(output, "en", label + ".png"),
    animations: "disabled", ...screenshotOptions,
  });
  if (showcaseClips[label]) {
    await page.screenshot({
      path: resolve(showcase, "en", label + ".png"),
      animations: "disabled", clip: showcaseClips[label],
    });
  } else if (label === "fleet") {
    await target.screenshot({ path: resolve(showcase, "en", label + ".png"), animations: "disabled" });
  }
  // 完整重新载入原始界面，保证下一张中文截图不保留英语标签。
  await page.reload({ waitUntil: "domcontentloaded" });
  await delay(400);
  return original;
}

async function main() {
  await mkdir(demoTemp, { recursive: true });
  await mkdir(resolve(output, "zh-CN"), { recursive: true });
  await mkdir(resolve(output, "en"), { recursive: true });
  await mkdir(resolve(showcase, "zh-CN"), { recursive: true });
  await mkdir(resolve(showcase, "en"), { recursive: true });
  await mkdir(debugOutput, { recursive: true });

  const workerPort = await freePort();
  const worker = await createRealTestServer({
    prefix: "quaymesh-doc-worker-",
    federation: {
      nodeId: "worker", nickname: "Workspace worker", priority: 100,
      capabilities: { coordinator: false, worker: true, discovery: false, egress: false,
        meshRelay: false, desktopUi: false, consoleRelay: false },
      port: workerPort, ingressPort: await freePort(),
      peers: [{ id: "hub", url: "" }],
    },
  });
  const hub = await createRealTestServer({
    prefix: "quaymesh-doc-hub-",
    federation: {
      nodeId: "hub", nickname: "Coordinator", priority: 0,
      capabilities: { coordinator: true, worker: false, discovery: false, egress: false,
        meshRelay: true, desktopUi: false, consoleRelay: false },
      port: await freePort(), ingressPort: await freePort(),
      peers: [{ id: "worker", url: "http://127.0.0.1:" + workerPort }],
    },
  });
  const standalone = await createRealTestServer({
    prefix: "quaymesh-doc-local-", git: true, uiEnabled: true,
    configure: async config => ({
      ...config,
      federation: {
        ...config.federation,
        roots: [
          { id: "source", nickname: "Application source", path: config.allowedRoots[0]!,
            description: "Application source code", tags: ["code"], enabled: true },
          { id: "notes", nickname: "Project documentation", path: config.allowedRoots[1]!,
            description: "Project documentation", tags: ["docs"], enabled: true },
        ],
      },
    }),
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const deadline = Date.now() + 15000;
    while (!hub.running.federation?.nodes().some(node => node.id === "worker" && node.online)) {
      assert.ok(Date.now() < deadline, "Workspace worker did not connect");
      await delay(200);
    }
    const node = "node";
    await recordTask(standalone.client, standalone.project, "Add a workspace health check",
      "health.mjs", ['export const health = () => ({ status: "ready", service: "quaymesh-demo" });'],
      node + " -e \"import('./health.mjs').then(m => console.log(JSON.stringify(m.health())))\"");
    await recordTask(standalone.client, standalone.project, "Document the command workflow",
      "docs/command-workflow.md", ["# Command workflow", "", "1. Open a workspace.",
        "2. Run a command and retain its output.", "3. Review file changes."],
      node + " -e \"const fs=require('node:fs'); for (const file of ['health.mjs','docs/command-workflow.md']) { console.log(file, fs.existsSync(file) ? 'present' : 'missing'); }\"");
    await recordTask(standalone.client, standalone.project, "Verify a utility function",
      "checksum.mjs", ['export const checksum = (value) => value.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0);',
        'if (checksum("abc") !== 294) process.exitCode = 1;',
        'else console.log("Verification passed: checksum(abc) = 294");'],
      node + " checksum.mjs");
    await recordTask(standalone.client, standalone.secondRoot, "Write project documentation",
      "README.md", ["# Project documentation", "", "Documentation alongside source projects."],
      node + " --version");

    const page = await browser.newPage({
      viewport: { width: 1440, height: 800 }, deviceScaleFactor: 1,
      locale: "zh-CN", colorScheme: "dark",
    });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await login(page, standalone.baseUrl, standalone.config.oauth.ownerToken!);
    const apiDiagnostics = await page.evaluate(async () => {
      const paths = ["fleet/status", "overview", "projects", "roots", "runs?days=0"];
      return Object.fromEntries(await Promise.all(paths.map(async (path) => {
        const response = await fetch("/console/api/v4/" + path);
        const body = await response.json();
        return [path, { status: response.status, body }];
      })));
    });
    await writeFile(resolve(debugOutput, "diagnostics.json"), JSON.stringify(apiDiagnostics, null, 2) + "\n");
    const visible: Record<string, string[]> = {};
    await visit(page, standalone.baseUrl, "overview");
    visible.overview = await capture(page, "overview");
    await visit(page, standalone.baseUrl, "tasks?days=0");
    await page.locator(".run-table tbody tr").first().waitFor();
    await page.locator(".run-table .run-title").first().click();
    await page.locator(".inspector .session-heading h2").waitFor();
    visible["task-detail"] = await capture(page, "task-detail");
    await page.locator(".run-table .run-title").filter({ hasText: "Document the command workflow" }).first().click();
    await page.locator('[data-action="detail-tab"][data-value="commands"]').click();
    await page.locator(".command-card summary").first().click();
    await delay(600);
    visible.commands = await capture(page, "commands");
    await visit(page, standalone.baseUrl, "changes");
    visible.changes = await capture(page, "changes");
    await visit(page, standalone.baseUrl, "sessions");
    await page.locator(".project-item").first().click();
    await page.locator(".conversation").first().waitFor();
    await page.locator(".conversation details summary").first().click();
    visible.sessions = await capture(page, "sessions");
    await visit(page, standalone.baseUrl, "workspaces");
    await page.locator('[data-action="root-expand"]').first().click();
    await page.locator('[data-action="root-expand"]').nth(1).click();
    await page.locator(".root-projects").first().waitFor();
    visible.workspaces = await capture(page, "workspaces");
    const fleetPage = await browser.newPage({
      viewport: { width: 1440, height: 800 }, deviceScaleFactor: 1,
      locale: "zh-CN", colorScheme: "dark",
    });
    await login(fleetPage, hub.baseUrl, hub.config.oauth.ownerToken!);
    await visit(fleetPage, hub.baseUrl, "machines");
    visible.fleet = await capture(fleetPage, "fleet", true);
    assert.deepEqual(pageErrors, [], "Browser runtime error");
    await writeFile(resolve(debugOutput, "visible-labels.json"), JSON.stringify(visible, null, 2) + "\n");
    await writeFile(resolve(debugOutput, "untranslated-labels.json"), JSON.stringify(untranslated, null, 2) + "\n");
    console.log(JSON.stringify({
      pages: Object.keys(visible),
      labels: Object.fromEntries(Object.entries(visible).map(([name, values]) => [name, values.length])),
      untranslated: Object.fromEntries(Object.entries(untranslated).map(([name, values]) => [name, values.length])),
    }));
  } finally {
    await browser.close();
    await standalone.dispose();
    await hub.dispose();
    await worker.dispose();
    process.env.TEMP = originalTemp;
    process.env.TMP = originalTmp;
    if (originalToken === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN;
    else process.env.QUAYMESH_CLUSTER_TOKEN = originalToken;
    await rm(demoTemp, { recursive: true, force: true });
  }
}

await main();
