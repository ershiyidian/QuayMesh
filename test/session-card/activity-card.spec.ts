import { expect, test } from "@playwright/test";

test("Task 主状态保持 active，进度条只随真实后台命令运行显示", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const card = page.frameLocator("#app-frame"), bar = card.locator("#bar");
  await expect(card.locator("#card")).toHaveAttribute("data-status", "active");
  await expect(card.locator("#act")).toContainText("任务进行中");
  const toneMatches = await card.locator("#stIc").evaluate(element => {
    const sample = element.ownerDocument.createElement("span");
    sample.style.color = "var(--color-text-info)";
    element.ownerDocument.body.append(sample);
    const matched = getComputedStyle(element).color === getComputedStyle(sample).color;
    sample.remove();
    return matched;
  });
  expect(toneMatches).toBe(true);
  await expect(bar).not.toHaveClass(/indet/);
  await expect(bar).toHaveCSS("opacity", "0");

  const commandCall = page.evaluate(() => window.__quaymeshHost.runCommand(
    `"${window.__quaymeshHost.nodeExecutable}" -e "setTimeout(()=>{},12000)"`));
  await expect(bar).toHaveClass(/indet/, { timeout: 20_000 });
  await expect(bar).toHaveCSS("opacity", "1");
  await expect(card.locator("#card")).toHaveAttribute("data-status", "active");
  await expect(card.locator("#act")).toContainText("后台仍在执行");
  await card.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-active-background-progress.png" });
  const result = await commandCall;
  expect(result.isError).not.toBe(true);
  await expect(bar).not.toHaveClass(/indet/, { timeout: 25_000 });
  await expect(bar).toHaveCSS("opacity", "0");
  await expect(card.locator("#card")).toHaveAttribute("data-status", "active");
  await expect(card.locator("#act")).toContainText("任务进行中");
});

test("活动时间与确认时间并存，断线和刷新不制造进展，终态只更新相对时间", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const initialActivity = await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const { createCardState, applySnapshot } = await load("/src/ui/session-card/state.ts");
    const { createCardView } = await load("/src/ui/session-card/view.ts");
    const { previewSnapshot } = await load("/src/ui/session-card/preview.ts");
    const original = (document.getElementById("app-frame") as HTMLIFrameElement).contentDocument!;
    const html = original.documentElement.cloneNode(true) as HTMLElement;
    for (const script of html.querySelectorAll("script")) script.remove();
    const frame = document.createElement("iframe");
    frame.id = "activity-proof";
    frame.style.cssText = "width:100%;height:200px;border:0";
    document.body.prepend(frame);
    const doc = frame.contentDocument!;
    doc.documentElement.innerHTML = html.innerHTML;
    const now = Date.now(), activityAt = now - 70_000;
    const snapshot = { ...previewSnapshot, rev: 100, taskState: "active", taskResult: null,
      lastActivityAt: activityAt, lastModelToolAt: null, lastExecutionActivityAt: null, lastOutputAt: null,
      startedAt: now - 600_000, serverNow: now, observedAt: now - 40_000,
      commands: [], currentCommand: null, runningCommand: null, lastCommand: null, lastOperation: null,
      agents: [], files: [], totals: { files: 0, commands: 0, agents: 0 },
      executionObservation: { observedAt: now - 40_000, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] },
    };
    const state = createCardState();
    state.connection = "error";
    applySnapshot(state, snapshot);
    const view = createCardView(doc, state, async () => {});
    view.render();
    (window as any).__activityProof = { state, view, applySnapshot, doc };
    return activityAt;
  });
  const proof = page.frameLocator("#activity-proof"), progress = proof.locator("#prog");
  await expect(progress).toContainText("最近活动 1 分");
  await expect(progress).toContainText("更新延迟");
  await expect(progress).toContainText("上次确认");

  const refreshedActivity = await page.evaluate(() => {
    const { state, view, applySnapshot } = (window as any).__activityProof;
    const now = Date.now();
    state.connection = "live";
    applySnapshot(state, { ...state.snapshot, rev: state.snapshot.rev + 1, observedAt: now, serverNow: now,
      executionObservation: { observedAt: now, activeOperationIds: [], preparingOperationIds: [], staleOperationIds: [] } });
    view.render();
    return state.snapshot.lastActivityAt;
  });
  expect(refreshedActivity).toBe(initialActivity);
  await expect(progress).toContainText("最近活动 1 分");
  await expect(progress).toContainText("上次确认");

  await page.evaluate(() => {
    const { state, view, applySnapshot } = (window as any).__activityProof;
    applySnapshot(state, { ...state.snapshot, rev: state.snapshot.rev + 1, host_status: "disconnected" });
    view.render();
  });
  await expect(progress).toContainText("节点暂不可达");
  await expect(progress).toContainText("最近活动 1 分");
  await expect(progress).toContainText("上次确认");
  await page.setViewportSize({ width: 430, height: 900 });
  expect(await progress.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);
  await page.evaluate(() => {
    const { state, view } = (window as any).__activityProof;
    state.collapsed = false;
    view.render();
    const frame = document.getElementById("activity-proof") as HTMLIFrameElement;
    frame.style.height = frame.contentDocument!.getElementById("card")!.getBoundingClientRect().height + 8 + "px";
  });
  await expect(progress).toBeVisible();
  expect(await proof.locator("#card").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThan(2);

  await page.evaluate(() => {
    const { state, view, applySnapshot } = (window as any).__activityProof;
    applySnapshot(state, { ...state.snapshot, rev: state.snapshot.rev + 1, lastActivityAt: null });
    view.render();
  });
  await expect(progress).toContainText("暂无任务活动");
  await expect(progress).toContainText("上次确认");

  const terminal = await page.evaluate(() => {
    const { state, view, applySnapshot, doc } = (window as any).__activityProof;
    const now = Date.now();
    applySnapshot(state, { ...state.snapshot, rev: state.snapshot.rev + 1, taskState: "closed", taskResult: "completed",
      deliveryEndedAt: now - 1000, endedAt: now - 1000, lastActivityAt: now - 2000 });
    view.render();
    const clock = doc.getElementById("clock"), progress = doc.getElementById("prog");
    const before = { clock: clock.textContent, progress: progress.textContent };
    const mutations = new MutationObserver(() => {});
    mutations.observe(doc.getElementById("card"), { subtree: true, attributes: true, childList: true, characterData: true });
    state.clockOffsetMs += 65_000;
    view.fillTimers();
    const changedOutsideProgress = mutations.takeRecords().filter(record => !progress.contains(record.target));
    mutations.disconnect();
    return { before, clock: clock.textContent, progress: progress.textContent, changedOutsideProgress: changedOutsideProgress.length };
  });
  expect(terminal.clock).toBe(terminal.before.clock);
  expect(terminal.progress).not.toBe(terminal.before.progress);
  expect(terminal.progress).toContain("最近活动 1 分");
  expect(terminal.progress).toContain("上次确认");
  expect(terminal.changedOutsideProgress).toBe(0);
  await proof.locator("#card").screenshot({ path: "releases/session-acceptance/browser/card-activity-recency-mobile.png" });
  await page.evaluate(() => {
    (window as any).__activityProof.view.dispose();
    document.getElementById("activity-proof")?.remove();
    delete (window as any).__activityProof;
  });
});
