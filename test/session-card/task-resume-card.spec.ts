import { expect, test, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/session/types.js";

type ToolReply = { isError?: boolean; structuredContent?: Record<string, any>; _meta?: Record<string, any> };
async function tool(page: Page, name: string, args: Record<string, unknown>, entry?: string | null): Promise<ToolReply> {
  const response = await page.request.post("/api/tool", { data: { name, arguments: args, ...(entry === undefined ? {} : { entry }) } });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBe(true);
  return result;
}
async function bootstrap(page: Page) {
  const value = await (await page.request.get("/api/bootstrap")).json();
  return { taskId: value.openResult._meta.quaymesh.task_id as string, sessionId: value.sessionId as string };
}
async function snapshot(page: Page, identity: { taskId: string; sessionId: string }, entry: string, since = -1) {
  const result = await tool(page, "qm_session", { task_id: identity.taskId, session_id: identity.sessionId,
    since_rev: since, resource_version: "task-card-v9", file_recorded_at: true }, entry);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent as { unchanged: boolean; rev: number; snapshot?: Snapshot };
}

test("另一对话显式恢复原任务；unchanged 回包更新关联且保留草稿和焦点", async ({ page }) => {
  const entry = `resume-ui-${Date.now()}`;
  const unchangedSelections = new Set<string>();
  const resumeCalls: Array<Record<string, unknown>> = [];
  page.on("response", async response => {
    const request = response.request();
    if (!request.url().endsWith("/api/tool") || request.method() !== "POST") return;
    const input = request.postDataJSON();
    if (input.name === "task_resume") resumeCalls.push(input.arguments);
    if (input.name === "qm_session") {
      const result = await response.json();
      const selected = result._meta?.quaymesh?.task_binding?.selected_task_id;
      if (result.structuredContent?.unchanged && typeof selected === "string") unchangedSelections.add(selected);
    }
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto(`/?entry=${entry}`);
  await expect(page.locator("#status")).toHaveText("ready");
  const identity = await bootstrap(page), card = page.frameLocator("#app-frame");
  const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  await card.locator('[data-act="messages-open"]').click();
  await expect(card.locator("#task-binding-state")).toContainText("尚未关联任务");
  await expect(card.locator("#task-message-continue")).toBeHidden();
  const before = (await snapshot(page, identity, entry)).snapshot!;
  const draft = card.locator("#task-message-draft"), unsent = "恢复原任务后，仍请先让我检查方案。";
  await draft.fill(unsent);
  await card.locator("#task-binding-resume").click();
  await expect(card.locator("#task-binding-state")).toContainText("当前入口已关联此任务");
  await expect(card.locator("#task-binding-notice")).toContainText("尚未请求 GPT 继续");
  await expect(draft).toHaveValue(unsent);
  await expect(card.locator("#task-message-continue")).toBeVisible();
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
  const after = await snapshot(page, identity, entry, before.rev);
  expect(after.unchanged).toBe(true);
  expect(after.rev).toBe(before.rev);
  const original = await tool(page, "task_resume", { action: "inspect", task_id: identity.taskId });
  expect(original.structuredContent?.binding.selected_task_id).toBe(identity.taskId);
  expect(resumeCalls.filter(call => call.action === "resume")).toHaveLength(1);
  expect(Object.keys(resumeCalls[0]).sort()).toEqual(["action", "expected_binding_revision", "request_key", "task_id"].sort());

  await draft.evaluate(element => { element.focus(); (element as HTMLTextAreaElement).setSelectionRange(2, 8); });
  const started = await page.evaluate(async taskId => {
    const inspected = await window.__quaymeshHost.requestTool("task_resume", { action: "inspect", task_id: taskId });
    if (inspected.isError) throw new Error("The test's explicit new goal could not inspect its current entry");
    const state = inspected.structuredContent as { binding: { binding_revision: number } };
    return window.__quaymeshHost.requestTool("start_session", {
      title: "Another independent Task", request_key: `other-${Date.now()}`, new_goal: true,
      expected_binding_revision: state.binding.binding_revision,
    });
  }, identity.taskId);
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  const otherTask = (started.structuredContent as { task_id: string }).task_id;
  await expect(card.locator("#task-binding-state")).toContainText(otherTask, { timeout: 20_000 });
  await expect.poll(() => unchangedSelections.has(otherTask)).toBe(true);
  await expect(card.locator("#task-message-continue")).toBeHidden();
  await expect(draft).toHaveValue(unsent);
  await expect(draft).toBeFocused();
  expect(await draft.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
  const unchanged = (await snapshot(page, identity, entry)).snapshot!;
  expect(unchanged.rev).toBe(before.rev);
  expect(unchanged.lastActivityAt).toBe(before.lastActivityAt);
  await expect(card.locator("#card")).toHaveAttribute("data-status", "active");
  for (const selector of ["#task-binding-resume", "#task-binding-inspect", '[data-act="messages-open"]']) {
    await expect(card.locator(selector)).toHaveCSS("white-space", "nowrap");
    expect(await card.locator(selector).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  }
  expect(await card.locator("#card").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  await card.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-task-resume-mobile.png" });

  await card.locator("#task-binding-resume").click();
  await expect(card.locator("#task-binding-state")).toContainText("当前入口已关联此任务");
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
  await card.locator("#task-message-continue").click();
  await expect.poll(async () => (await page.evaluate(() => window.__quaymeshHost.followupMessages())).length).toBe(followups.length + 1);
  const sent = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  expect(sent.at(-1)).toContain(identity.taskId);
  expect(sent.at(-1)).toContain("task_resume");
});

test("真实恢复已提交但回执丢失时，同 key 与 revision 重试取回回执", async ({ page }) => {
  const entry = `resume-retry-${Date.now()}`, attempts: Array<Record<string, unknown>> = [], replies: ToolReply[] = [];
  let saved = false, release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name !== "task_resume" || input.arguments.action !== "resume") { await route.continue(); return; }
    attempts.push(input.arguments);
    const response = await route.fetch(); replies.push(await response.json());
    if (attempts.length !== 1) { await route.fulfill({ response }); return; }
    saved = true; await held; await route.abort("failed");
  });
  try {
    await page.goto(`/?entry=${entry}`);
    await expect(page.locator("#status")).toHaveText("ready");
    const identity = await bootstrap(page), card = page.frameLocator("#app-frame");
    const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
    await card.locator('[data-act="messages-open"]').click();
    await expect(card.locator("#task-binding-resume")).toBeEnabled();
    await card.locator("#task-message-draft").fill("重试恢复也保留这份草稿");
    await card.locator("#task-binding-resume").click();
    await expect.poll(() => saved).toBe(true);
    expect(replies[0].isError, JSON.stringify(replies[0])).not.toBe(true);
    release();
    await expect(card.locator("#task-binding-resume")).toHaveText("重试恢复");
    await expect(card.locator("#task-binding-notice")).toContainText("回执未确认");
    await expect(card.locator("#task-message-draft")).toHaveValue("重试恢复也保留这份草稿");
    await card.locator("#task-binding-resume").click();
    await expect(card.locator("#task-binding-state")).toContainText("当前入口已关联此任务");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(replies[1].structuredContent?.replayed).toBe(true);
    expect(replies[1].structuredContent?.binding.binding_revision).toBe(1);
    const inspected = await tool(page, "task_resume", { action: "inspect", task_id: identity.taskId }, entry);
    expect(inspected.structuredContent?.binding.selected_task_id).toBe(identity.taskId);
    expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
  } finally { release(); }
});

test("点击后关联改变不会被覆盖；先检查，再由另一次明确点击恢复", async ({ page }) => {
  const entry = `resume-cas-${Date.now()}`, attempts: Array<Record<string, unknown>> = [];
  let switched = false;
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name === "task_resume" && input.arguments.action === "resume") {
      attempts.push(input.arguments);
      if (!switched) {
        switched = true;
        const result = await tool(page, "start_session", { title: "New work accepted before the resume", request_key: `${entry}-new` }, entry);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
    }
    await route.continue();
  });
  await page.goto(`/?entry=${entry}`);
  await expect(page.locator("#status")).toHaveText("ready");
  const card = page.frameLocator("#app-frame");
  const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  await card.locator('[data-act="messages-open"]').click();
  await expect(card.locator("#task-binding-resume")).toBeEnabled();
  await card.locator("#task-binding-resume").click();
  await expect(card.locator("#task-binding-notice")).toContainText("请先重新检查");
  await expect(card.locator("#task-binding-resume")).toBeHidden();
  expect(attempts).toHaveLength(1);
  await card.locator("#task-binding-inspect").click();
  await expect(card.locator("#task-binding-resume")).toBeEnabled();
  expect(attempts).toHaveLength(1);
  await card.locator("#task-binding-resume").click();
  await expect(card.locator("#task-binding-state")).toContainText("当前入口已关联此任务");
  expect(attempts).toHaveLength(2);
  expect(attempts[0].expected_binding_revision).toBe(0);
  expect(attempts[1].expected_binding_revision).toBe(1);
  expect(attempts[0].request_key).not.toBe(attempts[1].request_key);
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
});

test("缺少可验证入口时，只明确请求宿主 GPT 核对恢复，不伪造已绑定状态", async ({ page }) => {
  let bindingCalls = 0;
  page.on("request", request => {
    if (request.url().endsWith("/api/tool") && request.method() === "POST" && request.postDataJSON().name === "task_resume") bindingCalls++;
  });
  await page.goto("/?entry=unavailable");
  await expect(page.locator("#status")).toHaveText("ready");
  const identity = await bootstrap(page), card = page.frameLocator("#app-frame");
  const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  await card.locator('[data-act="messages-open"]').click();
  await expect(card.locator("#task-binding-state")).toContainText("暂不支持从卡片直接恢复");
  await expect(card.locator("#task-binding-resume")).toBeHidden();
  await expect(card.locator("#task-message-continue")).toBeHidden();
  await card.locator("#task-binding-host").click();
  await expect.poll(async () => (await page.evaluate(() => window.__quaymeshHost.followupMessages())).length).toBe(followups.length + 1);
  await expect(card.locator("#task-binding-notice")).toContainText("尚未确认恢复或开始执行");
  await expect(card.locator("#task-binding-state")).toContainText("暂不支持从卡片直接恢复");
  const sent = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  expect(sent.at(-1)).toContain(identity.taskId);
  expect(sent.at(-1)).toContain("task_resume");
  expect(bindingCalls).toBe(0);
  await card.locator("#toggle").click();
  await page.waitForTimeout(6_000);
  expect(bindingCalls).toBe(0, "there is no separate resume polling loop");
});

test("宿主未提供消息能力时不显示不可执行的恢复请求按钮", async ({ page }) => {
  await page.goto("/?entry=unavailable&host_messages=off");
  await expect(page.locator("#status")).toHaveText("ready");
  const card = page.frameLocator("#app-frame");
  await card.locator('[data-act="messages-open"]').click();
  await expect(card.locator("#task-binding-state")).toContainText("暂不支持从卡片直接恢复");
  await expect(card.locator("#task-binding-host")).toBeHidden();
  await expect(card.locator("#task-binding-resume")).toBeHidden();
  await expect(card.locator("#task-message-continue")).toBeHidden();
  await expect(card.locator("#task-binding-notice")).toContainText("宿主也未提供发送消息能力");
});

test("继续请求等待回执时，排队的重复点击不能空报已发送", async ({ page }) => {
  const entry = `continue-busy-${Date.now()}`;
  let preparations = 0, held = false, release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name !== "qm_session_continue") { await route.continue(); return; }
    preparations++;
    const response = await route.fetch();
    held = true;
    await pending;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/?entry=${entry}`);
    await expect(page.locator("#status")).toHaveText("ready");
    const card = page.frameLocator("#app-frame");
    await card.locator('[data-act="messages-open"]').click();
    await expect(card.locator("#task-binding-resume")).toBeEnabled();
    await card.locator("#task-binding-resume").click();
    await expect(card.locator("#task-binding-state")).toContainText("当前入口已关联此任务");
    const before = await page.evaluate(() => window.__quaymeshHost.followupMessages());
    const button = card.locator("#task-message-continue");
    await button.click();
    await expect.poll(() => held).toBe(true);
    await expect(button).toBeDisabled();
    // Dispatch an already queued UI intent while the first request is blocked.
    // This exercises the view handler even though the refreshed button is disabled.
    await button.evaluate(async element => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    await expect(card.locator("#live")).not.toHaveText("已发送继续请求");
    expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(before);
    expect(preparations).toBe(1);
    release();
    await expect.poll(async () => (await page.evaluate(() => window.__quaymeshHost.followupMessages())).length).toBe(before.length + 1);
    await expect(card.locator("#live")).toHaveText("已发送继续请求");
    expect(preparations).toBe(1);
  } finally { release(); }
});
