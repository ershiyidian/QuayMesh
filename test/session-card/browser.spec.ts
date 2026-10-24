import {expect,test,type FrameLocator,type Page} from "@playwright/test";

const OUT="releases/session-acceptance/browser",POLL={timeout:25_000};

async function openCard(page:Page):Promise<FrameLocator>{
  await page.goto("/");
  await expect(page.locator("#status")).toHaveText("ready");
  const frame=page.frameLocator("#app-frame");
  await expect(frame.locator("#card")).toBeVisible();
  await frame.locator("#toggle").click();
  await expect(frame.locator("#toggle")).toHaveAttribute("aria-expanded","true");
  await expect(frame.locator("#details")).toBeVisible();
  return frame;
}

function workspaceId(boot:any):string{
  return String(boot.openResult?._meta?.quaymesh?.workspace_id??boot.openResult?.structuredContent?.workspace_id);
}

test("designer card structure, one iframe and multi-workspace context",async({page})=>{
  const frame=await openCard(page);
  for(const id of ["#t-changes","#t-commands","#t-agents","#t-context"])await expect(frame.locator(id)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(frame.locator("#title")).not.toBeEmpty();
  await page.screenshot({path:OUT+"/desktop-initial.png",fullPage:true});
  await page.setViewportSize({width:480,height:900});
  await page.screenshot({path:OUT+"/narrow-initial.png",fullPage:true});
  await page.setViewportSize({width:980,height:900});
  await page.getByRole("button",{name:"Attach real workspace"}).click();
  await expect.poll(async()=>(await(await page.request.get("/api/state")).json()).lastTool,POLL).toBe("attach_workspace");
  await frame.locator("#t-context").click();
  await expect(frame.locator("#p-context")).toContainText("desktop",POLL);
  await expect(frame.locator("#p-context")).toContainText("second",POLL);
  await expect(frame.locator("#p-context")).toContainText("project",POLL);
});

test("real patch feeds compact Changes and lazy diff",async({page})=>{
  const frame=await openCard(page);
  await page.evaluate(()=>window.__quaymeshHost.runPatch(["*** Begin Patch","*** Add File: browser-change.txt","+browser line one","+browser line two","*** End Patch"].join(String.fromCharCode(10))));
  const row=frame.locator('[data-x^="f:"]',{hasText:"browser-change.txt"}).first();
  await expect(row).toBeVisible(POLL);
  await expect(frame.locator("#n-changes")).not.toHaveText("0");
  await row.click();
  await expect(frame.locator("#p-changes .code").first()).toContainText("browser line one",POLL);
  await page.screenshot({path:OUT+"/changes.png",fullPage:true});
});

test("real commands feed compact Commands with durable output and failure",async({page})=>{
  const frame=await openCard(page),echoToken="browser-echo-"+Date.now();
  await page.evaluate(command=>window.__quaymeshHost.runCommand(command),process.platform==="win32"?"cmd /c echo "+echoToken:"printf '%s\\n' "+echoToken);
  await frame.locator("#t-commands").click();
  const echoRow=frame.locator('[data-x^="c:"]',{hasText:echoToken}).first();
  await expect(echoRow).toBeVisible(POLL);await echoRow.click();
  await expect(frame.locator("#p-commands .code").first()).toContainText(echoToken,POLL);
  const failToken="browser-fail-"+Date.now();
  await page.evaluate(command=>window.__quaymeshHost.runCommand(command),process.platform==="win32"?`cmd /c "echo ${failToken} 1>&2 & exit 7"`:`printf '%s\\n' ${failToken} >&2; exit 7`);
  await expect(frame.locator('[data-x^="c:"]',{hasText:failToken}).first()).toBeVisible(POLL);
  await expect(frame.locator("#n-commands")).toHaveClass(/bad/);
  await page.screenshot({path:OUT+"/commands.png",fullPage:true});
});

test("project instructions stay on-demand and explicit read becomes visible",async({page})=>{
  const frame=await openCard(page);await frame.locator("#t-context").click();
  await expect(frame.locator("#p-context")).toContainText("AGENTS.md",POLL);
  await expect(frame.locator("#p-context")).toContainText("按需");
  const boot=await(await page.request.get("/api/bootstrap")).json(),wid=workspaceId(boot);
  const read=await page.evaluate(workspace_id=>window.__quaymeshHost.requestTool("read",{workspace_id,path:"AGENTS.md"}),wid);
  expect(read.isError,JSON.stringify(read)).not.toBe(true);
  await frame.locator("#toggle").click();await frame.locator("#toggle").click();
  await expect(frame.locator('[data-x^="i:"]',{hasText:"AGENTS.md"}).first()).toContainText("已读取",POLL);
  await frame.locator('[data-x^="i:"]',{hasText:"AGENTS.md"}).first().click();
  await expect(frame.locator("#p-context .code")).toContainText("Browser acceptance instructions",POLL);
});

test("agent empty state and keyboard tabs",async({page})=>{
  const frame=await openCard(page);await frame.locator("#t-agents").click();
  await expect(frame.locator("#p-agents")).toContainText("没有子代理",POLL);
  await frame.locator("#t-changes").focus();
  await frame.locator("#t-changes").press("ArrowRight");await expect(frame.locator("#t-commands")).toHaveAttribute("aria-selected","true");
  await frame.locator("#t-commands").press("End");await expect(frame.locator("#t-context")).toHaveAttribute("aria-selected","true");
  await frame.locator("#t-context").press("Home");await expect(frame.locator("#t-changes")).toHaveAttribute("aria-selected","true");
});

test("disconnect error, reconnect and teardown keep the background operation",async({page})=>{
  const frame=await openCard(page);
  await page.getByRole("button",{name:"Disconnect MCP"}).click();
  await expect.poll(async()=>(await(await page.request.get("/api/state")).json()).connected,POLL).toBe(false);
  await frame.locator("#toggle").click();await frame.locator("#toggle").click();
  await expect(frame.locator("#prog")).toContainText("更新延迟",POLL);
  await expect(frame.locator("#prog")).toContainText("上次确认",POLL);
  await page.getByRole("button",{name:"Reconnect MCP"}).click();
  await expect.poll(async()=>(await(await page.request.get("/api/state")).json()).connected,POLL).toBe(true);
  await frame.locator("#toggle").click();await frame.locator("#toggle").click();
  await expect(frame.locator("#prog")).not.toContainText("更新延迟",POLL);
  const marker="teardown-"+Date.now()+".txt";
  const started=await page.evaluate(command=>window.__quaymeshHost.runCommand(command,1500),process.platform==="win32"?`cmd /c "ping -n 4 127.0.0.1 > nul & echo done > ${marker}"`:`sleep 3; printf done > ${marker}`);
  expect(started.isError,JSON.stringify(started)).not.toBe(true);
  const operationId=String(started.structuredContent?.operation_id),boot=await(await page.request.get("/api/bootstrap")).json(),wid=workspaceId(boot);
  await page.getByRole("button",{name:"Teardown iframe"}).click();
  await expect.poll(async()=>(await(await page.request.get("/api/state")).json()).mountedFrames,POLL).toBe(0);
  await expect.poll(async()=>{
    const result=await page.evaluate(({wid,operationId})=>window.__quaymeshHost.requestTool("read_output",{workspace_id:wid,operation_id:operationId}),{wid,operationId});
    return result.structuredContent?.operation_state;
  },POLL).toBe("completed");
  await page.evaluate(()=>window.__quaymeshHost.mountFrame());
  await expect(page.frameLocator("#app-frame").locator("#card")).toBeVisible(POLL);
});
