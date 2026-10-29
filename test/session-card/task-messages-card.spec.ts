import { expect, test, type Page } from "@playwright/test";

async function taskId(page: Page): Promise<string> {
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  return bootstrap.openResult._meta.quaymesh.task_id;
}
async function modelTool(page: Page, args: Record<string, unknown>) {
  const result = await page.evaluate(input => window.__quaymeshHost.requestTool("task_messages", input), args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent as Record<string, any>;
}

test("真实卡片双向对话区分保存、提供正文和确认收到，刷新不丢草稿或焦点", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const id = await taskId(page), card = page.frameLocator("#app-frame");
  await expect(card.locator("#importHostFile")).toBeHidden();
  const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  await card.locator('[data-act="messages-open"]').click();
  const draft = card.locator("#task-message-draft");
  const body = '先检查日志。\n<img src=x onerror="window.__messageXss=true">';
  await draft.fill(body);
  await card.locator("#task-message-send").click();
  await expect(draft).toHaveValue("");
  const user = card.locator(".task-message-user").last();
  await expect(user.locator(".task-message-body")).toHaveText(body);
  await expect(user.locator(".task-message-status")).toHaveText("已保存 · 等待模型领取");
  await expect(card.locator('[data-act="messages-older"]')).toBeHidden();
  await expect(card.locator('[data-act="messages-latest"]')).toBeHidden();
  expect(await card.locator("#task-message-list img").count()).toBe(0);
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);

  const unsent = "第二条草稿：先让我审查方案。";
  await draft.fill(unsent);
  await draft.evaluate(element => { element.focus(); (element as HTMLTextAreaElement).setSelectionRange(3, 9); });
  const marker = `message-draft-${Date.now()}`;
  const command = process.platform === "win32" ? `cmd /c echo ${marker}` : `printf '%s\\n' ${marker}`;
  const result = await page.evaluate(cmd => window.__quaymeshHost.runCommand(cmd), command);
  expect(result.isError).not.toBe(true);
  await expect(card.locator("#stats")).toContainText("1 命令", { timeout: 25_000 });
  await expect(draft).toHaveValue(unsent);
  await expect(draft).toBeFocused();
  expect(await draft.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([3, 9]);

  const received = await modelTool(page, { action: "receive", task_id: id, request_key: `receive-${Date.now()}` });
  expect(received.status).toBe("offered");
  const ids = received.messages.map((message: { id: string }) => message.id);
  await card.locator('[data-act="messages-refresh"]').click();
  await expect(user.locator(".task-message-status")).toHaveText("正文已提供给模型 · 待确认");
  await modelTool(page, { action: "ack", task_id: id, delivery_id: received.delivery_id, message_ids: ids });
  await card.locator('[data-act="messages-refresh"]').click();
  await expect(user.locator(".task-message-status")).toHaveText("模型已确认收到");
  const answer = "我已收到补充，会先检查日志；目前还没有完成这项任务。";
  await modelTool(page, { action: "reply", task_id: id, message_key: `reply-${Date.now()}`, reply_to: ids, body: answer });
  await card.locator('[data-act="messages-refresh"]').click();
  await expect(card.locator(".task-message-assistant .task-message-body")).toHaveText(answer);
  await expect(card.locator(".task-message-assistant .task-message-status")).toHaveText("GPT 回复已保存");
  await expect(card.locator("#card")).toHaveAttribute("data-status", "active");
  await expect(draft).toHaveValue(unsent);
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
  await card.locator("#task-message-continue").click();
  await expect.poll(async () => (await page.evaluate(() => window.__quaymeshHost.followupMessages())).length).toBe(followups.length + 1);
});

test("真实保存后丢失回执保留原文和 message_key，重试只保留一条消息", async ({ page }) => {
  const attempts: Array<Record<string, unknown>> = [];
  let release = () => {}, saved = false, firstResult: Record<string, unknown> | null = null;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name !== "qm_task_message_enqueue") { await route.continue(); return; }
    attempts.push(input.arguments);
    if (attempts.length !== 1) { await route.continue(); return; }
    const response = await route.fetch();
    firstResult = await response.json();
    saved = true;
    await held;
    await route.abort("failed");
  });
  try {
    await page.goto("/");
    await expect(page.locator("#status")).toHaveText("ready");
    const id = await taskId(page), card = page.frameLocator("#app-frame");
    await card.locator('[data-act="messages-open"]').click();
    const draft = card.locator("#task-message-draft"), body = "请保留本条消息，不要重复创建。\n中文与引号 \\\"";
    await draft.fill(body);
    await card.locator("#task-message-send").click();
    await expect.poll(() => saved).toBe(true);
    expect((firstResult as Record<string, unknown> | null)?.isError, JSON.stringify(firstResult)).not.toBe(true);
    await expect(draft).toHaveValue(body);
    await expect(card.locator("#task-message-send")).toHaveText("正在保存…");
    release();
    await expect(card.locator("#task-message-send")).toHaveText("重试保存");
    await expect(draft).toHaveValue(body);
    await expect(card.locator("#task-message-send-state")).toContainText("草稿已保留");
    await card.locator("#task-message-send").click();
    await expect(draft).toHaveValue("");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const response = await page.request.post("/api/tool", { data: { name: "qm_task_messages", arguments: { task_id: id } } });
    const result = await response.json();
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent.messages.filter((message: { body: string }) => message.body === body)).toHaveLength(1);
  } finally { release(); }
});

test("对话按页读取，折叠停止消息请求，窄屏动作保持横向文字", async ({ page }) => {
  let mailboxReads = 0;
  page.on("request", request => {
    if (request.url().endsWith("/api/tool") && request.method() === "POST" && request.postDataJSON().name === "qm_task_messages") mailboxReads++;
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const id = await taskId(page), card = page.frameLocator("#app-frame");
  for (let sequence = 1; sequence <= 21; sequence++) {
    const response = await page.request.post("/api/tool", { data: { name: "qm_task_message_enqueue", arguments: {
      task_id: id, message_key: `page-${sequence}`, body: `分页消息 ${sequence}`,
    } } });
    const result = await response.json();
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
  }
  expect(mailboxReads).toBe(0);
  await card.locator('[data-act="messages-open"]').click();
  await expect(card.locator(".task-message")).toHaveCount(20);
  await expect(card.locator(".task-message-body").last()).toHaveText("分页消息 21");
  await card.locator("#task-message-draft").fill("翻页也保留这份草稿");
  await card.locator('[data-act="messages-older"]').click();
  await expect(card.locator(".task-message")).toHaveCount(1);
  await expect(card.locator(".task-message-body")).toHaveText("分页消息 1");
  await expect(card.locator("#task-message-draft")).toHaveValue("翻页也保留这份草稿");
  await card.locator('[data-act="messages-latest"]').click();
  await expect(card.locator(".task-message")).toHaveCount(20);

  // Exercise the optional host import action's layout without invoking an import.
  await expect(card.locator("#importHostFile")).toBeHidden();
  await card.locator("#importHostFile").evaluate(button => { (button as HTMLButtonElement).hidden = false; });
  for (const selector of ["#importHostFile", '[data-act="messages-open"]', "#task-message-send", "#task-message-continue"]) {
    const button = card.locator(selector);
    await expect(button).toBeVisible();
    await expect(button).toHaveCSS("white-space", "nowrap");
    expect(await button.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  }
  expect(await card.locator("#card").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  await card.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-task-messages-mobile.png" });
  await card.locator("#toggle").click();
  const before = mailboxReads;
  await page.waitForTimeout(6_000);
  expect(mailboxReads).toBe(before);
});

test("展开命令显示开始、结束及耗时，文件显示证据时间而非刷新时间", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const card = page.frameLocator("#app-frame"), marker = `row-time-${Date.now()}`;
  const command = process.platform === "win32" ? `cmd /c echo ${marker}` : `printf '%s\\n' ${marker}`;
  expect((await page.evaluate(cmd => window.__quaymeshHost.runCommand(cmd), command)).isError).not.toBe(true);
  const path = `${marker}.txt`;
  const patch = ["*** Begin Patch", `*** Add File: ${path}`, "+recorded change", "*** End Patch"].join("\n");
  expect((await page.evaluate(text => window.__quaymeshHost.runPatch(text), patch)).isError).not.toBe(true);
  await card.locator("#toggle").click();
  await card.locator("#t-commands").click();
  const commandGroup = card.locator(".grp", { has: card.locator('[data-x^="c:"]', { hasText: marker }) });
  await expect(commandGroup.locator("[data-command-id]")).toContainText("耗时", { timeout: 25_000 });
  await expect(commandGroup.locator(".row-times")).toContainText("开始");
  await expect(commandGroup.locator(".row-times")).toContainText("结束");
  await expect(commandGroup.locator("time[datetime]")).toHaveCount(2);
  const started = await commandGroup.locator("time[datetime]").first().getAttribute("datetime");
  expect(Date.parse(started!)).toBeGreaterThan(0);
  await expect(commandGroup.locator("time[datetime]").first()).toHaveAttribute("title", /\d{4}.* · .+/);
  await card.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-command-times-mobile.png" });
  await card.locator("#t-changes").click();
  const fileGroup = card.locator(".grp", { has: card.locator('[data-x^="f:"]', { hasText: path }) });
  await expect(fileGroup.locator(".row-times time")).toHaveCount(1, { timeout: 25_000 });
  const recorded = await fileGroup.locator(".row-times time").getAttribute("datetime");
  expect(Date.parse(recorded!)).toBeGreaterThan(0);
  await page.waitForTimeout(6_000);
  expect(await fileGroup.locator(".row-times time").getAttribute("datetime")).toBe(recorded);
  expect(await card.locator("#card").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  await card.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-recorded-times-mobile.png" });
});

test("任务快照持续失败达到重试上限时，真实 Coordinator 消息仍自动刷新且不伪造任务确认", async ({ page }) => {
  let snapshots = 0;
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name !== "qm_session") { await route.continue(); return; }
    snapshots++;
    // Fault only the worker-dependent snapshot route. Mailbox requests still reach the real OAuth/SQLite fixture.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ isError: true,
      content: [{ type: "text", text: "WORKER_OFFLINE: task snapshot unavailable" }],
      structuredContent: { error_code: "WORKER_OFFLINE", effect: "not_started" } }) });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const id = await taskId(page), card = page.frameLocator("#app-frame");
  const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  await card.locator('[data-act="messages-open"]').click();
  const draft = card.locator("#task-message-draft");
  await draft.fill("快照离线时仍保留草稿");
  await expect(card.locator("#prog")).toContainText("数据未确认", { timeout: 30_000 });
  expect(snapshots).toBe(3);
  const confirmation = await card.locator("#prog").getAttribute("title");
  const savedResponse = await page.request.post("/api/tool", { data: { name: "qm_task_message_enqueue", arguments: {
    task_id: id, message_key: `offline-mailbox-${Date.now()}`, body: "工作节点不可用时，仍请确认收到补充。",
  } } });
  const saved = await savedResponse.json();
  expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
  await expect(card.locator(".task-message-user .task-message-body")).toHaveText("工作节点不可用时，仍请确认收到补充。", { timeout: 15_000 });
  const received = await modelTool(page, { action: "receive", task_id: id, request_key: `offline-receive-${Date.now()}` });
  expect(received.status).toBe("offered");
  const ids = received.messages.map((message: { id: string }) => message.id);
  await modelTool(page, { action: "ack", task_id: id, delivery_id: received.delivery_id, message_ids: ids });
  await modelTool(page, { action: "reply", task_id: id, message_key: `offline-reply-${Date.now()}`, reply_to: ids,
    body: "已收到补充，工作节点的任务状态仍未确认。" });
  await expect(card.locator(".task-message-user .task-message-status")).toHaveText("模型已确认收到", { timeout: 15_000 });
  await expect(card.locator(".task-message-assistant .task-message-body")).toHaveText("已收到补充，工作节点的任务状态仍未确认。");
  await expect(card.locator("#prog")).toContainText("数据未确认");
  await expect(card.locator("#prog")).toHaveAttribute("title", confirmation!);
  await expect(card.locator("#task-binding-state")).toContainText("尚未确认");
  await expect(card.locator("#task-message-continue")).toBeHidden();
  await expect(draft).toHaveValue("快照离线时仍保留草稿");
  expect(snapshots).toBe(3, "message polling must not reset the exhausted snapshot handshake budget");
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
});

test("模拟可选 widgetState 的 iframe 重挂载保留原发送键，真实 MCP 只保存一条消息", async ({ page }) => {
  // Only the optional widget-state extension is simulated. AppBridge, OAuth and mailbox storage remain real.
  await page.addInitScript(() => {
    type Harness = { state: Record<string, any>; writes: number };
    const parent = window.parent as Window & { __qmPendingWidget?: Harness };
    if (window.parent === window) {
      parent.__qmPendingWidget = { state: { modelContent: { selection: "keep" }, imageIds: [],
        privateContent: { otherPanel: "keep" } }, writes: 0 };
      return;
    }
    if (!parent.__qmPendingWidget) return;
    Object.defineProperty(window, "openai", { configurable: true, value: {
      get widgetState() { return structuredClone(parent.__qmPendingWidget!.state); },
      setWidgetState(state: Record<string, any>) {
        parent.__qmPendingWidget!.state = structuredClone(state); parent.__qmPendingWidget!.writes++;
      },
    } });
  });
  const attempts: Array<Record<string, unknown>> = [], replies: Array<Record<string, any>> = [];
  let saved = false, release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name !== "qm_task_message_enqueue") { await route.continue(); return; }
    attempts.push(input.arguments);
    const response = await route.fetch(); replies.push(await response.json());
    if (attempts.length !== 1) { await route.fulfill({ response }); return; }
    saved = true; await held; await route.abort("failed");
  });
  try {
    await page.goto("/");
    await expect(page.locator("#status")).toHaveText("ready");
    const id = await taskId(page), card = page.frameLocator("#app-frame");
    const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
    await card.locator('[data-act="messages-open"]').click();
    const body = "这条请求已由我点击发送。\n重载后请复用同一个键核对回执。";
    await card.locator("#task-message-draft").fill(body);
    expect(await page.evaluate(() => (window as Window & { __qmPendingWidget?: { writes: number } }).__qmPendingWidget?.writes)).toBe(0);
    await card.locator("#task-message-send").click();
    await expect.poll(() => saved).toBe(true);
    expect(replies[0].isError, JSON.stringify(replies[0])).not.toBe(true);
    const pending = await page.evaluate(() => (window as Window & { __qmPendingWidget?: { state: Record<string, any> } })
      .__qmPendingWidget!.state.privateContent["quaymesh.taskMessagePending"]);
    expect(pending).toEqual({ version: 1, taskId: id, key: attempts[0].message_key, body });
    await page.evaluate(() => window.__quaymeshHost.teardownFrame());
    release();
    await page.evaluate(() => window.__quaymeshHost.mountFrame());
    await card.locator('[data-act="messages-open"]').click();
    const restored = card.locator("#task-message-draft");
    await expect(restored).toHaveValue(body);
    await expect(restored).toHaveAttribute("readonly", "");
    await expect(card.locator("#task-message-send")).toHaveText("重试保存");
    await expect(card.locator("#task-message-send-state")).toContainText("保存回执仍未确认");
    expect(attempts).toHaveLength(1, "restoring the UI must not automatically resend");
    expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);

    await card.locator("#task-message-send").click();
    await expect(restored).toHaveValue("");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(replies[1].structuredContent.replayed).toBe(true);
    expect(replies[1].structuredContent.message.id).toBe(replies[0].structuredContent.message.id);
    const widget = await page.evaluate(() => (window as Window & { __qmPendingWidget?: { state: Record<string, any> } }).__qmPendingWidget!.state);
    expect(widget).toEqual({ modelContent: { selection: "keep" }, imageIds: [], privateContent: { otherPanel: "keep" } });
    const historyResponse = await page.request.post("/api/tool", { data: { name: "qm_task_messages", arguments: { task_id: id } } });
    const history = await historyResponse.json();
    expect(history.isError, JSON.stringify(history)).not.toBe(true);
    expect(history.structuredContent.messages.filter((message: { body: string }) => message.body === body)).toHaveLength(1);
    expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
  } finally { release(); }
});

test("模拟迟到 widgetState 时保留新草稿，明确重试单独显示的原消息", async ({ page }) => {
  // Only delayed availability of the optional host snapshot is simulated; the receipt uses real MCP storage.
  await page.setViewportSize({ width: 430, height: 900 });
  await page.addInitScript(() => {
    type Harness = { state: Record<string, any>; available: boolean; writes: number };
    const parent = window.parent as Window & { __qmDelayedPendingWidget?: Harness };
    if (window.parent === window) {
      parent.__qmDelayedPendingWidget = { state: { privateContent: { otherPanel: "keep" } }, available: false, writes: 0 };
      return;
    }
    if (!parent.__qmDelayedPendingWidget) return;
    Object.defineProperty(window, "openai", { configurable: true, value: {
      get widgetState() {
        return parent.__qmDelayedPendingWidget!.available ? structuredClone(parent.__qmDelayedPendingWidget!.state) : {};
      },
      setWidgetState(state: Record<string, any>) {
        parent.__qmDelayedPendingWidget!.state = structuredClone(state);
        parent.__qmDelayedPendingWidget!.writes++;
      },
    } });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const id = await taskId(page), card = page.frameLocator("#app-frame");
  const followups = await page.evaluate(() => window.__quaymeshHost.followupMessages());
  await card.locator('[data-act="messages-open"]').click();
  const draft = card.locator("#task-message-draft"), edited = "刚编辑的另一份草稿：目前不要提交这段文字。";
  await draft.fill(edited);
  const original = '上次已经提交的原消息。\n<img src=x onerror="window.__pendingXss=true">';
  const key = `late-widget-${Date.now()}`;
  const response = await page.request.post("/api/tool", { data: { name: "qm_task_message_enqueue", arguments: {
    task_id: id, message_key: key, body: original,
  } } });
  const saved = await response.json();
  expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
  const attempts: Array<Record<string, unknown>> = [], replies: Array<Record<string, any>> = [];
  await page.route("**/api/tool", async route => {
    const input = route.request().postDataJSON();
    if (input.name !== "qm_task_message_enqueue") { await route.continue(); return; }
    attempts.push(input.arguments);
    const response = await route.fetch();
    replies.push(await response.json());
    await route.fulfill({ response });
  });
  await page.evaluate(pending => {
    const harness = (window as Window & { __qmDelayedPendingWidget?: {
      state: Record<string, any>; available: boolean; writes: number;
    } }).__qmDelayedPendingWidget!;
    harness.state.privateContent["quaymesh.taskMessagePending"] = pending;
    harness.available = true;
  }, { version: 1, taskId: id, key, body: original });
  await card.locator('[data-act="messages-refresh"]').click();
  await expect(draft).toHaveValue(edited);
  await expect(draft).toHaveAttribute("readonly", "");
  await expect(card.locator("#task-message-pending-original")).toBeVisible();
  await expect(card.locator("#task-message-pending-body")).toHaveText(original);
  expect(await card.locator("#task-message-pending-original img").count()).toBe(0);
  await expect(card.locator("#task-message-send")).toHaveText("重试上次消息");
  expect(attempts).toHaveLength(0, "reading delayed host state must not send either the original or the draft");
  expect(await card.locator("#card").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  await card.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-pending-original-mobile.png" });

  await card.locator("#task-message-send").click();
  await expect(card.locator("#task-message-send-state")).toContainText("上次消息已保存。当前草稿尚未发送。");
  await expect(draft).toHaveValue(edited);
  await expect(draft).not.toHaveAttribute("readonly", "");
  await expect(card.locator("#task-message-pending-original")).toBeHidden();
  expect(attempts).toEqual([{ task_id: id, message_key: key, body: original }]);
  expect(replies[0].structuredContent.replayed).toBe(true);
  expect(replies[0].structuredContent.message.id).toBe(saved.structuredContent.message.id);
  const historyResponse = await page.request.post("/api/tool", { data: { name: "qm_task_messages", arguments: { task_id: id } } });
  const history = await historyResponse.json();
  expect(history.isError, JSON.stringify(history)).not.toBe(true);
  expect(history.structuredContent.messages.filter((message: { body: string }) => message.body === original)).toHaveLength(1);
  expect(history.structuredContent.messages.some((message: { body: string }) => message.body === edited)).toBe(false);
  expect(await page.evaluate(() => window.__quaymeshHost.followupMessages())).toEqual(followups);
});
