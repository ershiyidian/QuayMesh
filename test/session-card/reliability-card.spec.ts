import {expect,test} from "@playwright/test";

for(const delivery of ["structured","delayed"]){
  test(`任务在${delivery==="structured"?"仅结构化身份":"延迟结果"}时正确初始化`,async({page})=>{
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`/?delivery=${delivery}`);await expect(page.locator("#status")).toHaveText("ready");
    const card=page.frameLocator("#app-frame");
    await expect(card.locator("#title")).not.toContainText("BOOTSTRAP_MISSING");
    await expect(card.locator("#card")).toHaveClass(/collapsed/);
    await expect(card.locator("#toggle")).toHaveAttribute("aria-expanded","false");
    await expect(card.locator("#act")).not.toBeEmpty();
    expect(errors).toEqual([]);
  });
}

test("设计师卡片默认折叠、活动摘要、任务计时、窄屏和终态停轮询",async({page})=>{
  test.setTimeout(90000);await page.goto("/");await expect(page.locator("#status")).toHaveText("ready");
  const card=page.frameLocator("#app-frame"),root=card.locator("#card"),toggle=card.locator("#toggle");
  await expect(root).toHaveClass(/collapsed/);await expect(toggle).toHaveAttribute("aria-expanded","false");
  await expect(card.locator("#details")).toBeHidden();
  expect((await root.boundingBox())!.height).toBeLessThan(150);
  await expect(card.locator("#stats")).toContainText("命令");
  await expect(card.locator("#ws")).not.toBeEmpty();
  await expect(card.locator("#clock")).toHaveText(/\d{2}:\d{2}/);
  await root.screenshot({path:"releases/session-acceptance/browser/card-default.png"});

  const worker=await page.evaluate(()=>window.__quaymeshHost.processWorker);
  const command=await page.evaluate(path=>window.__quaymeshHost.runCommand(`node "${path}" stdout-child 8000 reliability-running`,100),worker);
  expect(command.isError,JSON.stringify(command)).not.toBe(true);
  await expect(card.locator("#act")).toContainText("reliability-running",{timeout:15000});
  await expect(card.locator("#prog")).toContainText("命令");
  await root.screenshot({path:"releases/session-acceptance/browser/card-running.png"});

  await toggle.click();await expect(card.locator("#details")).toBeVisible();
  await card.locator("#t-commands").click();
  const row=card.locator('[data-x^="c:"]',{hasText:"reliability-running"}).first();await expect(row).toBeVisible();await row.click();
  const commandGroup=row.locator("xpath=..");
  await expect(commandGroup.locator(".code")).toContainText("reliability-running",{timeout:20000});
  const calls=await(await page.request.get("/api/state")).json();expect(calls.callLog.some((line:string)=>line.includes("qm_command_outputs"))).toBe(true);
  await root.screenshot({path:"releases/session-acceptance/browser/card-expanded.png"});

  await page.setViewportSize({width:430,height:900});await root.screenshot({path:"releases/session-acceptance/browser/card-mobile.png"});
  expect(await root.evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThan(2);
  expect((await root.boundingBox())!.width).toBeLessThan(431);await page.setViewportSize({width:980,height:900});

  await page.emulateMedia({reducedMotion:"reduce"});
  await expect(card.locator("#details")).toHaveCSS("animation-name","none");
  const boot=await(await page.request.get("/api/bootstrap")).json();const taskId=boot.openResult._meta.quaymesh.task_id;
  const ended=await page.evaluate(task_id=>window.__quaymeshHost.requestTool("finish_task",{task_id,status:"completed",summary:"真实浏览器卡片验收完成"}),taskId);
  expect(ended.isError).not.toBe(true);
  await toggle.click();await toggle.click();
  await expect(root).toHaveAttribute("data-status","success",{timeout:20000});
  const finalClock=await card.locator("#clock").textContent();const before=await(await page.request.get("/api/state")).json();
  await page.waitForTimeout(10000);const after=await(await page.request.get("/api/state")).json();
  const snapshots=(log:string[])=>log.filter(item=>/^(OK|ERR) qm_session\b/.test(item));
  expect(snapshots(after.callLog)).toEqual(snapshots(before.callLog));
  expect(await card.locator("#clock").textContent()).toBe(finalClock);
  await root.screenshot({path:"releases/session-acceptance/browser/card-completed.png"});
  await page.goto("/?theme=light");await expect(page.locator("#status")).toHaveText("ready");
  const light=page.frameLocator("#app-frame");await expect(light.locator("body")).toHaveAttribute("data-theme","light");
  await light.locator("#card").screenshot({path:"releases/session-acceptance/browser/card-light.png"});
});
