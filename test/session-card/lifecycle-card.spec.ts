import {expect,test} from "@playwright/test";

test("重复挂载和相同快照不重绘，卡片异常可静态降级",async({page})=>{
  await page.goto("/");await expect(page.locator("#status")).toHaveText("ready");
  const result=await page.evaluate(async()=>{
    const load=(path:string)=>import(path);
    const {createCardController}=await load("/src/ui/session-card/controller.ts");
    const {createCardState}=await load("/src/ui/session-card/state.ts");
    const {previewSnapshot,createPreviewSource}=await load("/src/ui/session-card/preview.ts");
    const frame=document.createElement("iframe");document.body.append(frame);
    const doc=frame.contentDocument!;doc.body.innerHTML='<main id="card"></main>';
    const state=createCardState(),stages:string[]=[];
    const snapshot={...previewSnapshot,rev:100,taskState:"closed",taskResult:"completed",status:"idle",execution_status:"idle",
      endedAt:Date.now(),consoleUrl:location.origin+"/console",commands:[],runningCommand:null,currentCommand:null,lastCommand:null,
      agents:[],files:[],totals:{files:0,commands:0,agents:0},capabilities:{...previewSnapshot.capabilities,refresh:false},
      executionObservation:{observedAt:Date.now(),activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}};
    let sourceDisposed=0,viewDisposed=0,draws=0,footers=0,fail=false;
    const source={...createPreviewSource(),live:true,snapshot:async()=>({...snapshot}),
      widgetStage:async(stage:string)=>{stages.push(stage);},dispose(){sourceDisposed++;}};
    const view={render(){draws++;if(fail)throw new Error("injected-render-error");},renderFooter(){footers++;},
      renderPanel(){},fillTimers(){},dispose(){viewDisposed++;}};
    const controller=createCardController(state,view,source,doc);
    controller.start();controller.start();await controller.pollOnce();
    const before={draws,footers};
    for(let i=0;i<100;i++)await controller.pollOnce();
    const after={draws,footers};
    fail=true;snapshot.rev++;await controller.pollOnce();
    const fallback=doc.getElementById("card")!;
    const status=fallback.dataset.status,text=fallback.textContent,link=fallback.querySelector("a")?.getAttribute("href");
    controller.dispose();controller.dispose();frame.remove();
    return{before,after,mounts:stages.filter(x=>x==="mount").length,errors:stages.filter(x=>x==="error").length,
      sourceDisposed,viewDisposed,status,text,link};
  });
  expect(result.mounts).toBe(1);expect(result.after).toEqual(result.before);
  expect(result.status).toBe("unavailable");expect(result.text).toContain("执行结果仍可在 Console 查看");
  expect(result.link).toContain("/console");expect(result.errors).toBe(1);
  expect(result.sourceDisposed).toBe(1);expect(result.viewDisposed).toBe(1);
});

test('真实宿主卡片区分任务历时与后台执行，摘要不再显示最近命令计时',async({page})=>{
  await page.goto('/');await expect(page.locator('#status')).toHaveText('ready');
  const card=page.frameLocator('#app-frame');
  await expect(card.locator('#act')).toHaveText('任务进行中 · 暂无后台执行');
  await expect(card.locator('#clock')).toHaveAttribute('data-dynamic','true');
  await expect(card.locator('#clock')).toContainText('任务历时');
  const elapsed=await card.locator('#clock').textContent();
  await page.waitForTimeout(1500);
  expect(await card.locator('#clock').textContent()).not.toBe(elapsed);
  await expect(card.locator('#prog')).toContainText('暂无任务活动');
  await expect(card.locator('#prog')).toContainText('上次确认');
  await expect(card.locator('#prog')).not.toContainText('最近命令');
  await expect(card.locator('#card')).toHaveAttribute('data-status','active');
  const marker='command-duration-'+Date.now();
  const result=await page.evaluate(command=>window.__quaymeshHost.runCommand(command),process.platform==='win32'?`cmd /c echo ${marker}`:`printf '%s\\n' ${marker}`);
  expect(result.isError).not.toBe(true);
  await expect(card.locator('#prog')).toContainText('最近活动');
  await card.locator('#toggle').click();
  await card.locator('#t-commands').click();
  const command=card.locator('[data-x^="c:"]',{hasText:marker}).first();
  await expect(command.locator('[data-command-id]')).toContainText('耗时',{timeout:25_000});
  await expect(command.locator('[data-command-id]')).toContainText('秒');
  await expect(card.locator('#prog')).toContainText('最近活动');
  await card.locator('#card').screenshot({path:'releases/session-acceptance/browser/card-duration-labels.png'});
});

test('结束请求持久受理后显示确认中，真实归档完成才进入稳定终态',async({page})=>{
  await page.goto('/');await expect(page.locator('#status')).toHaveText('ready');
  const bootstrap=await(await page.request.get('/api/bootstrap')).json();
  const taskId=bootstrap.openResult._meta.quaymesh.task_id;
  const control=async(action:string)=>{
    const response=await page.request.post('/api/finalization-control',{data:{action,task_id:taskId}});
    expect(response.ok(),await response.text()).toBe(true);
    return response.json();
  };
  await control('hold');
  try{
    const result=await page.evaluate(id=>window.__quaymeshHost.requestTool('finish_task',{task_id:id,status:'completed',summary:'慢证据归档验收'}),taskId);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({task_id:taskId,state:'finalizing',accepted:true,result_status:null});
    const persisted=await control('status');
    expect(persisted.task).toMatchObject({state:'active',result_status:null});
    expect(persisted.intent).toMatchObject({status:'completed',summary:'慢证据归档验收',completed_at:null,error:null});
    const card=page.frameLocator('#app-frame');
    await expect(card.locator('#card')).toHaveAttribute('data-status','finalizing',{timeout:15_000});
    await expect(card.locator('#act')).toContainText('交付确认中');
    await card.locator('#card').screenshot({path:'releases/session-acceptance/browser/card-finalization-pending.png'});
    await control('release');
    await expect(card.locator('#card')).toHaveAttribute('data-status','success',{timeout:15_000});
    await expect(card.locator('#clock')).toHaveAttribute('data-dynamic','false');
    const completed=await control('status');
    expect(completed.task).toMatchObject({state:'closed',result_status:'completed'});
    expect(completed.intent.completed_at).not.toBeNull();
    await card.locator('#card').screenshot({path:'releases/session-acceptance/browser/card-finalization-completed.png'});
  }finally{await control('release');}
});

test('真实完成快照叠加丢失回执和延迟响应，保持交付结果并分别展示后台',async({page})=>{
  await page.goto('/');await expect(page.locator('#status')).toHaveText('ready');
  const bootstrap=await(await page.request.get('/api/bootstrap')).json();
  const taskId=bootstrap.openResult._meta.quaymesh.task_id,sessionId=bootstrap.sessionId;
  const finished=await page.evaluate(id=>window.__quaymeshHost.requestTool('finish_task',{task_id:id,status:'completed',summary:'独立后台观察验收'}),taskId);
  expect(finished.isError).not.toBe(true);
  const result=await page.evaluate(async identity=>{
    const response=await window.__quaymeshHost.requestTool('qm_session',{session_id:identity.sessionId,task_id:identity.taskId,since_rev:-1,resource_version:'task-card-v7'});
    const snapshot=(response.structuredContent as any).snapshot;
    const load=(path:string)=>import(path);
    const {createCardState,applySnapshot}=await load('/src/ui/session-card/state.ts');
    const {createCardView}=await load('/src/ui/session-card/view.ts');
    const original=(document.getElementById('app-frame') as HTMLIFrameElement).contentDocument!;
    const html=original.documentElement.cloneNode(true) as HTMLElement;
    for(const script of html.querySelectorAll('script'))script.remove();
    const frame=document.createElement('iframe');frame.id='lifecycle-proof';frame.style.cssText='width:100%;height:140px;border:0';document.body.prepend(frame);
    const doc=frame.contentDocument!;doc.documentElement.innerHTML=html.innerHTML;
    const state=createCardState(),now=Date.now();state.connection='live';
    const missing={id:'missing-receipt',operation_id:'missing-receipt',member_id:snapshot.workspaces[0]?.id??'member',cmd:'已落盘，退出回执遗失',agent:'host',status:'unknown',startedAt:now-20_000,endedAt:null,exitCode:null,signal:null,attempt:1,supersededBy:null,summary:null,output_ref:'missing-receipt',output_available:true};
    const fault={...snapshot,commands:[missing],runningCommand:null,lastCommand:missing,currentCommand:missing,
      executionObservation:{observedAt:now,activeOperationIds:[],preparingOperationIds:[],staleOperationIds:['missing-receipt']}};
    applySnapshot(state,fault);
    const view=createCardView(doc,state,async()=>{});view.render();
    (window as any).__lifecycleProof={state,view,applySnapshot,fault};
    return {taskState:snapshot.taskState,taskResult:snapshot.taskResult};
  },{taskId,sessionId});
  expect(result).toEqual({taskState:'closed',taskResult:'completed'});
  const proof=page.frameLocator('#lifecycle-proof');
  await expect(proof.locator('#card')).toHaveAttribute('data-status','success');
  await expect(proof.locator('#act')).toHaveText('已完成 · 后台命令结果待核对');
  const clock=await proof.locator('#clock').textContent();
  await page.waitForTimeout(1100);
  await page.evaluate(()=>{const p=(window as any).__lifecycleProof;p.view.fillTimers();});
  expect(await proof.locator('#clock').textContent()).toBe(clock);
  await proof.locator('#card').screenshot({path:'releases/session-acceptance/browser/card-completed-unconfirmed.png'});
  await page.evaluate(()=>{
    const p=(window as any).__lifecycleProof;
    p.applySnapshot(p.state,{...p.fault,rev:p.fault.rev+1,taskState:'active',taskResult:null,deliveryEndedAt:null,endedAt:null,
      executionObservation:{observedAt:Date.now(),activeOperationIds:['missing-receipt'],preparingOperationIds:[],staleOperationIds:[]}});
    p.view.render();
  });
  await expect(proof.locator('#card')).toHaveAttribute('data-status','success');
  await expect(proof.locator('#act')).toHaveText('已完成 · 后台仍在执行');
  expect(await proof.locator('#clock').textContent()).toBe(clock);
  await page.setViewportSize({width:430,height:900});
  expect(await proof.locator('#card').evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThan(2);
  expect(await proof.locator('#act').evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThan(2);
  await proof.locator('#toggle').click();
  await expect(proof.locator('#t-context .lbl')).toBeVisible();
  await page.evaluate(()=>{
    const frame=document.getElementById('lifecycle-proof') as HTMLIFrameElement;
    frame.style.height=frame.contentDocument!.getElementById('card')!.getBoundingClientRect().height+8+'px';
  });
  await proof.locator('#card').screenshot({path:'releases/session-acceptance/browser/card-completed-background-mobile.png'});
  await page.evaluate(()=>{(window as any).__lifecycleProof.view.dispose();document.getElementById('lifecycle-proof')?.remove();delete(window as any).__lifecycleProof;});
});
