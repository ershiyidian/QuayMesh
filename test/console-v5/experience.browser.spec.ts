import {test,expect,chromium,type Page} from '@playwright/test';
import {mkdtemp,rm,mkdir,writeFile,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request as httpRequest,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {consoleExperienceFixture,liveCaptureFixture} from './experience-fixture.js';
import {freePort,structured} from '../session-card/server-fixture.js';
import {canonicalWorkspaceRoot} from '../../src/roots.js';
import {WorkLedger} from '../../src/work-ledger.js';
import {SessionStore} from '../../src/session/store.js';
import {SessionProjector} from '../../src/session/projection.js';
import {saveRunCheckpoint} from '../../src/session/run-checkpoints.js';
import {readLocalTaskIndex} from '../../src/console-workbench/local-queries.js';
// @ts-expect-error 节点管理器使用ESM脚本。
import {McpRelay} from '../../node/relay.mjs';

let f:Awaited<ReturnType<typeof consoleExperienceFixture>>;
const screenshots='releases/console-experience';
test.beforeAll(async()=>{f=await consoleExperienceFixture();await mkdir(screenshots,{recursive:true});});
test.afterAll(async()=>{await f?.server.dispose();});
async function login(page:Page,base=f.server.baseUrl,initialView:'overview'|'tasks'='overview',password=f.server.config.oauth.ownerToken!){
  await page.goto(base+'/console/'+(initialView==='tasks'?'#/tasks?days=0&scope=all&requestState=active':''));
  await page.locator('#login-form input[name=password]').fill(password);
  const sent=page.waitForResponse(response=>response.url()===base+'/console/api/login');
  await page.locator('#login-form [type=submit]').click();
  const reply=await sent;expect(reply.status(),await reply.text()).toBe(200);
  await expect(page.locator('#login-form')).toHaveCount(0);
  await expect(page.locator(initialView==='tasks'?'.run-table':'.overview-summary')).toBeVisible();
}

test('总览展示当前Task，状态筛选、工作区和对话详情在浏览器中一致',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page);
  await expect(page.locator('.overview-current [role=listitem]')).toHaveCount(1);
  await expect(page.locator('.overview-current')).toContainText('等待下一步的工作');
  await expect(page.locator('.overview-recent [role=listitem]')).toHaveCount(2);
  await expect(page.locator('.overview-recent')).not.toContainText('等待下一步的工作');
  await expect(page.locator('#view')).not.toContainText('后台执行');
  await expect(page.locator('#view [data-elapsed]')).toHaveCount(0);
  await expect(page.locator('#view')).toContainText('等待下一步的工作');
  await expect(page.locator('#view')).toContainText('已经完成的改动');
  expect(await page.locator('.brand-image').first().evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  await page.screenshot({path:screenshots+'/overview-dark.png',fullPage:true});
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(3);
  await page.getByLabel('具体任务状态',{exact:true}).selectOption('waiting');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.run-table')).toContainText('等待下一步的工作');
  await expect(page.locator('.run-table')).not.toContainText('结果待验收');
  await page.getByLabel('具体任务状态',{exact:true}).selectOption('done');
  const scope=page.locator('.run-table .workspace-disclosure');
  await scope.locator('summary').click();
  await expect(scope.locator('.workspace-popover code')).toHaveCount(2);
  await expect(scope.locator('.workspace-popover code').last()).toBeInViewport({ratio:0.95});
  await expect(scope).toContainText(canonicalWorkspaceRoot(f.server.secondRoot));
  await page.screenshot({path:screenshots+'/workspace-details.png',fullPage:true});
  const projects=await f.get('projects');
  const project=projects.items.find((value:any)=>canonicalWorkspaceRoot(value.path)===canonicalWorkspaceRoot(f.server.project));
  await page.goto(f.server.baseUrl+'/console/#/sessions?project='+encodeURIComponent(project.id));
  await expect(page.locator('.conversation')).toHaveCount(1);
  await expect(page.locator('[data-action=session-tab][data-value=sessions] .count')).toHaveText('1');
  await expect(page.locator('[data-action=session-tab][data-value=threads] .count')).toHaveText('0');
  await page.locator('.conversation details summary').click();
  await expect(page.locator('.conversation-task')).toHaveCount(3);
  await page.screenshot({path:screenshots+'/conversations-dark.png',fullPage:true});
  await page.locator('[data-action=theme]').click();
  await page.screenshot({path:screenshots+'/conversations-light.png',fullPage:true});
  await page.setViewportSize({width:760,height:900});
  await page.screenshot({path:screenshots+'/conversations-narrow.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('已完成任务的未知后台在全局、项目、会话中保持同一主结果',async({page})=>{
  const isolated=await consoleExperienceFixture();
  try{
    const ledger=new WorkLedger(isolated.server.config.stateDir);
    try{
      const run=ledger.db.prepare('SELECT run_id FROM qm_run_links WHERE task_id=? LIMIT 1').get(isolated.completed.task_id) as {run_id:string};
      ledger.operation({runId:run.run_id,requestKey:'delayed-exit-receipt',kind:'command',label:'退出回执待核对',status:'unknown'});
    }finally{ledger.close();}
    const pageData=await isolated.get('runs?days=0&fresh=1');
    const completed=pageData.items.find((value:any)=>value.taskId===isolated.completed.task_id);
    expect(completed).toMatchObject({requestState:'closed',resultStatus:'completed',executionStatus:'unknown'});
    await login(page,isolated.server.baseUrl);
    const assertRow=async()=>{
      const row=page.locator('.run-table tbody tr',{hasText:'已经完成的改动'});
      await expect(row.locator('.task-state .state').first()).toHaveText('已完成');
      await expect(row.locator('.task-state')).not.toContainText('后台执行结果待核对');
      expect(await row.locator('[data-elapsed]').count()).toBe(0);
    };
    await page.goto(isolated.server.baseUrl+'/console/#/tasks?days=0&scope=all');
    await assertRow();
    await page.screenshot({path:screenshots+'/lifecycle-global.png',fullPage:true});
    const projects=await isolated.get('projects');
    const project=projects.items.find((value:any)=>canonicalWorkspaceRoot(value.path)===canonicalWorkspaceRoot(isolated.server.project));
    await page.goto(isolated.server.baseUrl+'/console/#/tasks?days=0&scope=all&project='+encodeURIComponent(project.id));
    await assertRow();
    await page.screenshot({path:screenshots+'/lifecycle-project.png',fullPage:true});
    await page.goto(isolated.server.baseUrl+'/console/#/sessions?project='+encodeURIComponent(project.id));
    await page.locator('.conversation details summary').click();
    const task=page.locator('.conversation-task',{hasText:'已经完成的改动'});
    await expect(task.locator('.state')).toHaveText('已完成');
    await expect(task).toContainText('后台执行结果待核对');
    await page.screenshot({path:screenshots+'/lifecycle-conversation.png',fullPage:true});
  }finally{await isolated.server.dispose();}
});

test('读取等待可见，刷新失败保留旧记录且明确标为未更新',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),async route=>{
    const response=await route.fetch();await held;await route.fulfill({response});
  });
  const opening=login(page);
  try {
    await expect(page.locator('.overview-primary .loading')).toBeVisible();
    await expect(page.locator('#statusbar')).toContainText('正在读取当前页面');
    const size=await page.locator('.skeleton').first().boundingBox();expect(size?.width).toBeGreaterThan(100);expect(size?.height).toBeGreaterThan(5);
    await page.screenshot({path:screenshots+'/overview-loading.png',fullPage:true});
  } finally {release();}
  await opening;
  await page.unrouteAll({behavior:'wait'});
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:{active:[]}}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.overview-page .resource-update')).toContainText('更新失败');
  await expect(page.locator('#statusbar')).toContainText('页面读取');
  await expect(page.locator('.overview-summary')).toBeVisible();
  await expect(page.locator('#view')).not.toContainText('总览响应结构不完整');
  await expect(page.locator('.overview-page .resource-update')).toContainText('收到的数据不完整');
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  await page.unrouteAll({behavior:'wait'});
  const snapshot=await f.get('overview'),running={...snapshot.current[0],executionStatus:'running',executionObservedAt:Date.now(),progressLabel:'执行中',progressSummary:null,stale:false,observedAt:Date.now(),finishedAt:null};
  snapshot.current=[running];snapshot.currentCount=1;snapshot.active=[running];snapshot.runningCount=1;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:snapshot}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.overview-current .overview-task-heading>.badge')).toHaveText('执行中');
  await expect(page.locator('#view [data-elapsed]')).toHaveCount(0);
  running.observedAt=Date.now();running.executionObservedAt=Date.now();await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.overview-current .overview-task-heading>.badge')).toHaveText('执行中');
  const activeAt=Date.now();
  Object.assign(running,{nodeIds:[running.nodeId,'offline-other'],nodeStates:{[running.nodeId]:'running','offline-other':'unknown'},stale:true,executionObservedAt:activeAt,observedAt:activeAt-60_000,progressSummary:'部分任务信息待更新'});
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,observedAt:activeAt}));
  snapshot.taskSources.push({nodeId:'offline-other',name:'Offline peer',online:false,state:'offline',stale:true,observedAt:activeAt-60_000,error:'offline'});
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.overview-current .overview-task-heading>.badge')).toHaveText('执行中');
  await expect(page.locator('.overview-current')).toContainText('部分任务信息待更新');
  await page.screenshot({path:screenshots+'/mixed-source-task-progress.png',fullPage:true});
});

test('手动模式的一次部分读取会补齐，完成后不继续轮询',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1');
  const partial={...snapshot,current:[],currentCount:null,recent:[],olderOpen:[],olderOpenCount:null,
    knownCounts:{...snapshot.knownCounts,current:0,attention:0,completedToday:0},
    coverage:{...snapshot.coverage,tasks:false},taskSources:snapshot.taskSources.map((source:any)=>({...source,state:'loading',observedAt:null,stale:false,error:null}))};
  partial.sources=partial.taskSources;
  for(const key of ['sources','taskSources'])snapshot[key]=snapshot[key].map((source:any)=>({...source,state:'ready',stale:false,observedAt:Date.now(),error:null}));
  let reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>{reads++;return route.fulfill({json:reads===1?partial:snapshot});});
  await login(page);
  await expect(page.locator('.overview-summary>div strong')).toHaveText('待确认');
  await expect(page.locator('.overview-page .resource-update.pending')).toBeVisible();
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  await page.clock.fastForward(1_100);
  await expect(page.locator('.overview-current')).toContainText('等待下一步的工作');
  await expect(page.locator('.overview-page .resource-update.pending')).toHaveCount(0);
  expect(reads).toBe(2);
  await page.clock.fastForward(46_000);
  expect(reads).toBe(2);
});

test('旧节点读取失败时，手动预览仍会补齐其他节点的任务',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1');
  const failed={nodeId:'older-node',name:'Older node',online:true,state:'error',stale:true,observedAt:null,error:'node_read_upgrade_required'};
  snapshot.taskSources=[...snapshot.taskSources.map((source:any)=>({...source,state:'ready',stale:false,observedAt:Date.now(),error:null})),failed];
  snapshot.sources=snapshot.taskSources;
  snapshot.complete=false;snapshot.coverage.tasks=false;snapshot.currentCount=null;snapshot.attentionCount=null;snapshot.completedToday=null;
  const partial={...snapshot,current:[],recent:[],olderOpen:[],knownCounts:{...snapshot.knownCounts,current:0,attention:0,completedToday:0},
    taskSources:snapshot.taskSources.map((source:any)=>source.nodeId===failed.nodeId?source:{...source,state:'loading',observedAt:null})};
  partial.sources=partial.taskSources;
  let reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:++reads===1?partial:snapshot}));
  await login(page);
  await expect(page.locator('#global-notice .notice')).toContainText('Older node');
  await expect(page.locator('.overview-current')).not.toContainText('等待下一步的工作');
  await expect(page.locator('.overview-summary strong')).toHaveText(['待确认','待确认','待确认']);
  await page.clock.fastForward(1_100);
  await expect(page.locator('.overview-current')).toContainText('等待下一步的工作');
  await expect(page.locator('#global-notice .notice')).toContainText('Older node');
  await expect(page.locator('.overview-summary strong')).toHaveText([String(snapshot.knownCounts.current),String(snapshot.knownCounts.attention),String(snapshot.knownCounts.completedToday)]);
  await expect(page.locator('.overview-summary').getByText('项已读取',{exact:true})).toHaveCount(3);
  expect(reads).toBe(2);
  await page.screenshot({path:screenshots+'/overview-mixed-read-recovery.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.locator('#view').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:screenshots+'/overview-mixed-read-recovery-narrow.png',fullPage:true});
  await page.clock.fastForward(46_000);
  expect(reads).toBe(2);
});

test('默认列表是当前任务，完整记录有明确入口，主状态与详情一致',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  await login(page);
  await page.locator('#sidebar [data-view=tasks]').click();
  await expect(page).toHaveURL(/overviewGroup=current/);
  await expect(page.locator('[data-action=task-scope][data-value=current]')).toHaveAttribute('aria-pressed','true');
  const current=page.locator('.run-table tbody tr',{hasText:'等待下一步的工作'});
  await expect(current.locator('[data-activity-state=recent]')).toHaveText('最近有活动');
  await expect(current).toContainText('上次活动');
  await expect(current.locator('[data-elapsed]')).toHaveCount(0);
  await page.locator('[data-action=task-scope][data-value=""]').click();
  await expect(page).not.toHaveURL(/overviewGroup=/);
  await expect(page).toHaveURL(/scope=all/);
  await expect(page.locator('.run-table tbody tr')).toHaveCount(3);
  await current.locator('[data-action=open-run]').first().click();
  await expect(page.locator('#inspector [data-activity-state=recent]').first()).toHaveText('最近有活动');
  await expect(page.locator('#inspector .card-elapsed')).toContainText('上次活动');
});

test('详情首次失败保留任务上下文，重试和后续失败不清空已读内容',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  await login(page);
  const reference='qmtask:'+f.waiting.task_id, detail=await f.get('runs/'+encodeURIComponent(reference)+'?fresh=1');
  let mode:'failed'|'held'|'ready'='failed',release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  await page.route(url=>url.pathname.endsWith('/api/v4/runs/'+encodeURIComponent(reference)),async route=>{
    if(mode==='failed'){await route.fulfill({status:504,json:{code:'timeout',message:'请求 /internal/quaymesh/console 超时'}});return;}
    if(mode==='held'){entered();await gate;}
    await route.fulfill({json:detail});
  });
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&requestState=active');
  const row=page.locator('.run-table tbody tr',{hasText:'等待下一步的工作'});
  await row.locator('input[data-select-run]').check();
  await row.locator('[data-action=open-run]').first().click();
  await expect(page.locator('#inspector h2')).toHaveText('等待下一步的工作');
  await expect(page.locator('#inspector .read-failed')).toContainText('读取用时较长');
  await expect(page.locator('#view')).not.toContainText('/internal/');
  await expect(row.locator('input[data-select-run]')).toBeChecked();
  mode='held';
  await page.locator('#inspector').getByRole('button',{name:'重试这部分',exact:true}).click();
  try {
    await started;
    await expect(page.locator('#inspector [aria-busy=true]')).toBeVisible();
    await expect(page.locator('#inspector h2')).toHaveText('等待下一步的工作');
    await expect(page.locator('#inspector').getByRole('button',{name:'正在重试…',exact:true})).toBeDisabled();
  } finally {mode='ready';release();}
  await expect(page.locator('#inspector .result-section')).toBeVisible();
  const retained=await page.locator('#inspector .result-section').elementHandle();
  mode='failed';
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#inspector .resource-update')).toContainText('任务详情更新失败');
  await expect(page.locator('#inspector .resource-update')).toContainText('继续显示');
  expect(await retained!.evaluate(element=>element.isConnected)).toBe(true);
  await expect(row.locator('input[data-select-run]')).toBeChecked();
  await expect(page.locator('#inspector .resource-state')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshots+'/detail-read-failure-narrow.png',fullPage:true});
  expect(await page.locator('#inspector').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  mode='ready';
  await page.locator('#inspector').getByRole('button',{name:'重试这部分',exact:true}).click();
  await expect(page.locator('#inspector .resource-update')).toHaveCount(0);
  expect(await retained!.evaluate(element=>element.isConnected)).toBe(true);
});

test('详情返回部分成功时保留上次记录，恢复后移除历史标记',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const reference='qmtask:'+f.completed.task_id,path='runs/'+encodeURIComponent(reference);
  let ready:any;
  await expect.poll(async()=>{ready=await f.get(path+'?fresh=1');return ready.complete;}).toBe(true);
  expect(ready.commands.length).toBeGreaterThan(0);
  const partial={...ready,complete:false,files:[],commands:[],agents:[],evidence:[],timeline:[],instructions:[],skills:[],
    run:{...ready.run,actions:{...ready.run.actions,review:false,complete:false,revert:false,patch:false}},
    missingPhases:[{id:ready.run.id,nodeId:ready.run.nodeId,error:'记录仍在读取',pending:true}],
    sources:ready.sources.map((source:any)=>({...source,state:'ready',stale:false,error:null,observedAt:Date.now()}))};
  let response=ready;
  await page.route(url=>url.pathname.endsWith('/api/v4/'+path),route=>route.fulfill({json:response}));
  await login(page,f.server.baseUrl,'tasks');
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference)+'&tab=commands');
  await expect(page.locator('#inspector .command-card')).toHaveCount(ready.commands.length);
  response=partial;
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#inspector .detail-history-note')).toContainText('上次读取的记录');
  await expect(page.locator('#inspector .detail-history-note')).toContainText('当前状态尚未确认');
  await expect(page.locator('#inspector .command-card')).toHaveCount(ready.commands.length);
  await expect(page.locator('#inspector .command-card').first()).toContainText(ready.commands[0].command);
  await expect(page.locator('#inspector .command-result').first()).toContainText('上次记录');
  await expect(page.locator('#inspector .session-live,#inspector .command-card .spinner')).toHaveCount(0);
  await expect(page.locator('#inspector [data-action=detail-tab] .count')).toHaveCount(0);
  await expect(page.locator('#inspector [data-action=finish-task],#inspector [data-action=single-accept],#inspector [data-action=revert],#inspector [data-action=patch]')).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshots+'/detail-history-retained-narrow.png',fullPage:true});
  expect(await page.locator('#inspector').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  response=ready;
  await page.locator('#inspector [data-action=refresh]').click();
  await expect(page.locator('#inspector .detail-history-note')).toHaveCount(0);
  await expect(page.locator('#inspector .command-card')).toHaveCount(ready.commands.length);
  await expect(page.locator('#inspector .command-result').first()).not.toContainText('上次记录');
});

test('来源已读取但捕获仍待确认的详情会在手动模式补齐，成功后停止补读',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const reference='qmtask:'+f.waiting.task_id,path='runs/'+encodeURIComponent(reference);
  let ready:any;
  await expect.poll(async()=>{ready=await f.get(path+'?fresh=1');return ready.complete;}).toBe(true);
  const partial={...ready,complete:false,run:{...ready.run,actions:{...ready.run.actions,review:false,complete:false,revert:false,patch:false}},
    missingPhases:[{id:ready.run.id,nodeId:ready.run.nodeId,error:'文件改动仍在整理',pending:true}],
    sources:[{nodeId:ready.run.nodeId,name:'任务详情来源',online:true,state:'ready',stale:false,error:null,observedAt:Date.now()}]};
  let resolved=false,reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/'+path),route=>{
    reads++;return route.fulfill({json:resolved?ready:partial});
  });
  await login(page,f.server.baseUrl,'tasks');
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference)+'&tab=commands');
  await expect(page.locator('#inspector h2')).toHaveText(ready.run.title);
  await expect(page.locator('#inspector .resource-update.pending')).toContainText('部分详情状态尚未确认');
  await expect(page.locator('#inspector [data-action=finish-task]')).toHaveCount(0);
  await expect(page.locator('#inspector [data-action=detail-tab] .count')).toHaveCount(0);
  const before=reads;resolved=true;
  await page.clock.fastForward(6_000);
  await expect(page.locator('#inspector [data-action=detail-tab][data-value=commands] .count')).toHaveText(String(ready.commands.length));
  await expect(page.locator('#inspector .resource-update.pending')).toHaveCount(0);
  expect(reads).toBeGreaterThan(before);
  const finished=reads;await page.clock.fastForward(46_000);expect(reads).toBe(finished);
});


test('命令输出读取失败或不完整时提供手动重读，恢复后保留全部已读片段',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const reference='qmtask:'+f.completed.task_id,path='runs/'+encodeURIComponent(reference);
  let ready:any;
  await expect.poll(async()=>{ready=await f.get(path+'?fresh=1');return ready.complete;}).toBe(true);
  expect(ready.commands.length).toBeGreaterThan(0);
  // Keep an actual Task/command identity; control only the output-read states.
  const command={...ready.commands[0],outputAvailable:true,output:''};
  await page.route(url=>url.pathname.endsWith('/api/v4/'+path),route=>route.fulfill({json:{...ready,commands:[command]}}));
  let reads=0;
  const cursors:string[]=[];
  await page.route(url=>url.pathname.endsWith('/api/v4/'+path+'/commands/'+encodeURIComponent(command.id)),route=>{
    reads++;cursors.push(new URL(route.request().url()).searchParams.get('cursor')||'');
    if(reads===1)return route.fulfill({status:503,json:{code:'console_read_timeout',message:'请求 /internal/quaymesh/console 超时'}});
    return route.fulfill({json:reads===2
      ?{chunk:'saved\n',cursor:6,totalBytes:6,done:false,hasMore:false,truncated:false,retainedFrom:0,outputState:'incomplete',errorCode:'synthetic_output_tail_missing'}
      :{chunk:'complete\n',cursor:15,totalBytes:15,done:true,hasMore:false,truncated:false,retainedFrom:0,outputState:'ready',errorCode:null}});
  });
  await login(page,f.server.baseUrl,'tasks');
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference)+'&tab=commands');
  const card=page.locator('#inspector .command-card').first();
  await card.locator('summary').click();
  await expect(card.locator('pre')).toContainText('读取失败');
  await expect(card.locator('pre')).not.toContainText('/internal/');
  await page.clock.fastForward(10_000);expect(reads).toBe(1);
  await card.getByRole('button',{name:'重新读取输出',exact:true}).click();
  await expect(card.locator('pre')).toContainText('输出记录不完整');
  await expect(card.locator('pre')).toContainText('saved');
  await expect(card.locator('pre')).not.toContainText('synthetic_output_tail_missing');
  await expect(card.locator('pre')).not.toContainText('等待输出');
  await page.clock.fastForward(10_000);expect(reads).toBe(2);
  await card.getByRole('button',{name:'重新读取输出',exact:true}).click();
  await expect(card.locator('pre')).toContainText('saved\ncomplete');
  await expect(card.locator('pre')).not.toContainText('记录不完整');
  await expect(card.getByRole('button',{name:'重新读取输出',exact:true})).toHaveCount(0);
  expect(cursors).toEqual(['0','0','6']);
});


test('详情部分读取不把未知显示为零，消息确认后自动收敛',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const reference='qmtask:'+f.waiting.task_id,ready=await f.get('runs/'+encodeURIComponent(reference)+'?fresh=1');
  expect(ready.complete).toBe(true);expect(ready.taskMessages.available).toBe(true);
  expect(ready.files).toHaveLength(0);expect(ready.commands).toHaveLength(0);expect(ready.agents).toHaveLength(0);
  const partial={...ready,complete:false,run:{...ready.run,actions:{...ready.run.actions,complete:false}},
    taskMessages:{available:false,taskId:ready.run.taskId,ownerNodeId:ready.taskMessages.ownerNodeId,error:'任务消息状态仍待确认'},
    sources:[{nodeId:ready.run.nodeId,name:'任务详情来源',online:true,observedAt:null,state:'loading',stale:false,error:null}]};
  let resolved=false,reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/runs/'+encodeURIComponent(reference)),route=>{
    reads++;return route.fulfill({json:resolved?ready:partial});
  });
  await login(page);
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference)+'&tab=diff');
  await expect(page.locator('#inspector .session-heading h2')).toHaveText(ready.run.title);
  await expect(page.locator('#inspector .resource-update.pending')).toContainText('部分数据仍在读取');
  await expect(page.locator('#inspector [data-action=detail-tab] .count')).toHaveCount(0);
  await expect(page.locator('#inspector [data-action=finish-task]')).toHaveCount(0);
  for(const [tab,unconfirmed] of [['diff','文件改动'],['commands','命令记录'],['agents','代理记录']]){
    await page.locator('#inspector [data-action=detail-tab][data-value='+tab+']').click();
    await expect(page.locator('#inspector .empty h3')).toHaveText('任务详情尚未完整确认');
    await expect(page.locator('#inspector .empty p')).toContainText('暂未显示'+unconfirmed);
    await expect(page.locator('#inspector .empty')).toContainText('部分记录或消息状态仍待确认');
    await expect(page.locator('#inspector .empty')).not.toContainText('失败');
  }
  const pendingReads=reads;resolved=true;
  await page.clock.fastForward(6_000);
  await expect(page.locator('#inspector [data-action=detail-tab][data-value=agents] .count')).toHaveText('0');
  await expect(page.locator('#inspector .empty h3')).toHaveText('暂无代理');
  await expect(page.locator('#inspector .resource-update.pending')).toHaveCount(0);
  await expect(page.locator('#inspector [data-action=finish-task]')).toBeVisible();
  expect(reads).toBeGreaterThan(pendingReads);
  const completedReads=reads;await page.clock.fastForward(46_000);expect(reads).toBe(completedReads);
});

test('部分详情空态保留未知语义并禁用需要完整证据的操作',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const reference='qmtask:'+f.waiting.task_id,base=await f.get('runs/'+encodeURIComponent(reference)+'?fresh=1');
  const partial={...base,complete:false,files:[],commands:[],agents:[],evidence:[],timeline:[],instructions:[],skills:[],
    changeCaptures:[],run:{...base.run,actions:{...base.run.actions,review:false,complete:false,revert:false,patch:false}},
    missingPhases:[{id:base.run.id,nodeId:base.run.nodeId,error:'完整记录尚未读取',pending:true}],
    sources:[{nodeId:base.run.nodeId,name:'任务记录',online:true,observedAt:null,state:'loading',stale:false,error:null}]};
  await page.route(url=>url.pathname.endsWith('/api/v4/runs/'+encodeURIComponent(reference)),route=>route.fulfill({json:partial}));
  await login(page,f.server.baseUrl,'tasks');
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference)+'&tab=diff');
  await expect(page.locator('#inspector h2')).toHaveText(base.run.title);
  await expect(page.locator('#inspector [data-action=detail-tab] .count')).toHaveCount(0);
  await expect(page.locator('#inspector [data-action=finish-task],#inspector [data-action=single-accept],#inspector [data-action=single-reject],#inspector [data-action=patch],#inspector [data-action=revert]')).toHaveCount(0);
  for(const tab of ['diff','commands','agents']){
    await page.locator('#inspector [data-action=detail-tab][data-value='+tab+']').click();
    await expect(page.locator('#inspector .empty h3')).toHaveText('任务详情尚未完整确认');
    await expect(page.locator('#inspector .empty')).not.toContainText('暂无');
  }
  await page.locator('#inspector [data-action=detail-tab][data-value=context]').click();
  await expect(page.locator('#inspector')).toContainText('项目指令尚未完整读取');
  await expect(page.locator('#inspector')).toContainText('技能记录尚未完整读取');
  await expect(page.locator('#inspector')).not.toContainText('未发现项目指令');
  await expect(page.locator('#inspector')).not.toContainText('未发现技能');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshots+'/partial-detail-context-narrow.png',fullPage:true});
  expect(await page.locator('#inspector').evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
});

test('总览首次失败继续显示独立节点与已读任务，恢复后再显示完整统计',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  let failed=true,overviewReads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),async route=>{
    overviewReads++;
    if(failed)await route.fulfill({status:504,json:{code:'timeout',message:'请求 /internal/quaymesh/console 超时'}});
    else await route.continue();
  });
  // Start with a task-only route: a successful overview cache would turn this
  // into an update failure and would not exercise the first-read fallback.
  await login(page,f.server.baseUrl,'tasks');
  await expect(page.locator('.run-table')).toContainText('等待下一步的工作');
  expect(overviewReads).toBe(0);
  await page.locator('#sidebar [data-view=overview]').click();
  await expect(page.locator('.overview-primary .read-failed')).toContainText('读取用时较长');
  expect(overviewReads).toBe(1);
  await expect(page.getByRole('list',{name:'已读取的任务记录'})).toContainText('等待下一步的工作');
  await expect(page.locator('[data-key=overview-machines-panel]')).toContainText('节点在线');
  await expect(page.locator('.overview-summary')).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText('/internal/');
  await page.screenshot({path:screenshots+'/overview-first-failure-retained.png',fullPage:true});
  failed=false;
  await page.locator('.overview-primary').getByRole('button',{name:'重试这部分',exact:true}).click();
  await expect(page.locator('.overview-summary')).toBeVisible();
  await expect(page.locator('[data-key=overview-cached-tasks]')).toHaveCount(0);
});

test('跳到主内容仅在键盘导航时显露，原生默认焦点和鼠标不遮挡标识',async({page})=>{
  await login(page);
  const skip=page.locator('.skip-link');
  await skip.evaluate((element:HTMLElement)=>element.focus());
  await expect(skip).toBeFocused();
  expect((await skip.boundingBox())!.y+(await skip.boundingBox())!.height).toBeLessThan(0);
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  const link=await skip.boundingBox(),brand=await page.locator('#sidebar .brand').boundingBox();
  expect(link!.y).toBeGreaterThanOrEqual(0);
  expect(link!.x).toBeGreaterThan(brand!.x+brand!.width);
  await page.keyboard.press('Enter');
  await expect(page.locator('#view')).toBeFocused();
  await expect(page).not.toHaveURL(/#view$/);
  await page.locator('#sidebar [data-view=tasks]').click();
  await skip.evaluate((element:HTMLElement)=>element.focus());
  expect((await skip.boundingBox())!.y+(await skip.boundingBox())!.height).toBeLessThan(0);
});

test('后台刷新和旧快照保持中性，真实错误才集中提示',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  await login(page);
  const snapshot=await f.get('overview');
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'refreshing',stale:false,observedAt:Date.now(),error:null}));
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:snapshot}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText('正在刷新，当前显示上次确认的数据');
  await page.screenshot({path:screenshots+'/sources-refreshing.png',fullPage:true});
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,stale:true,observedAt:Date.now()-60_000}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'error',error:'请求 /internal/quaymesh/console 超时'}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#global-notice .notice')).toHaveCount(1);
  await expect(page.locator('#global-notice summary')).toContainText('数据更新延迟');
  await expect(page.locator('#view')).not.toContainText('正在刷新，当前显示上次确认的数据');
  await page.locator('#global-notice summary').click();
  await expect(page.locator('#global-notice .source-details')).toContainText('上次确认');
  await expect(page.locator('#global-notice .source-details')).toContainText('读取用时较长');
  await expect(page.locator('#global-notice')).not.toContainText('/internal/');
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'ready',stale:true,error:null}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  await page.setViewportSize({width:760,height:900});
  await page.screenshot({path:screenshots+'/sources-delayed-narrow.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('Task首页保留历史展开与焦点，当前任务入口使用相同分组筛选',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1'),current=snapshot.current[0];
  expect(current).toMatchObject({taskId:f.waiting.task_id,requestState:'active'});
  const unnamed={...current,id:'qmtask:overview-unnamed',taskId:'overview-unnamed',title:'未命名任务 · 示例工作区',titleSource:'workspace',progressLabel:'最近有活动',progressSummary:null};
  const older={...current,id:'qmtask:overview-older',taskId:'overview-older',title:'较早的资料整理任务',progressLabel:'未结束',lastActivityAt:Date.now()-3*86400_000,lastProgressAt:Date.now()-3*86400_000,executionObservedAt:null};
  snapshot.current=[current,unnamed];snapshot.currentCount=15;snapshot.knownCounts.current=15;
  snapshot.olderOpen=[older];snapshot.olderOpenCount=80;snapshot.knownCounts.olderOpen=80;
  snapshot.attention=[];snapshot.attentionCount=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:snapshot}));
  await login(page);
  const history=page.locator('#overview-older-open');
  await expect(history).toHaveJSProperty('open',false);
  await expect(page.locator('.overview-current')).toContainText('未命名任务');
  await expect(page.locator('.overview-current')).not.toContainText('QuayMesh task');
  await expect(page.locator('.overview-summary>div strong')).toHaveText('15');
  await expect(page.locator('.overview-summary>div>span')).toHaveText('当前任务 · 上次读取');
  await expect(page.getByRole('button',{name:'查看全部当前任务',exact:true})).toBeVisible();
  await history.locator(':scope>summary').click();
  const focused=page.locator('.overview-current .overview-task-title').nth(1);
  const focusedId=await focused.getAttribute('data-id');
  await focused.focus();
  snapshot.current.reverse();current.progressSummary='已记录阶段结果，任务尚未结束';
  await page.locator('#topbar [data-action=refresh]').evaluate((button:HTMLButtonElement)=>button.click());
  await expect(page.locator('.overview-current')).toContainText('已记录阶段结果');
  await expect(history).toHaveJSProperty('open',true);
  await expect(page.locator('.overview-current .overview-task-title').filter({hasText:focusedId===unnamed.id?unnamed.title:current.title})).toBeFocused();
  await page.screenshot({path:screenshots+'/overview-task-groups-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.locator('#view').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:screenshots+'/overview-task-groups-narrow.png',fullPage:true});
  await page.getByRole('button',{name:'查看全部当前任务',exact:true}).click();
  await expect(page).toHaveURL(/overviewGroup=current/);
  await expect(page.locator('.filter-chip')).toContainText('当前任务');
  await page.locator('[data-action=task-scope][data-value=ended]').click();
  await expect(page).not.toHaveURL(/overviewGroup=/);
  await expect(page.locator('.run-table tbody tr')).toHaveCount(2);
});

test('首页只观察任务来源，命令面板按需读取完整工作区目录',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1'),directory=await f.get('projects?fresh=1'),requests:string[]=[];
  expect(directory.items.length).toBeGreaterThan(0);
  expect(snapshot).not.toHaveProperty('usageSources');
  expect(snapshot).not.toHaveProperty('todayUsage');
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:snapshot}));
  page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/api/v4/projects'))requests.push(request.url());});
  let reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/projects'),route=>{
    reads++;
    return route.fulfill({json:reads<=2?{...directory,items:[],complete:false,sources:directory.sources.map((source:any)=>({...source,state:'loading',observedAt:null,error:null,stale:false}))}:directory});
  });
  await login(page);
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  await expect(page.locator('.overview-current')).not.toContainText('状态待更新');
  expect(requests).toHaveLength(0);
  await page.locator('#topbar [data-action=palette]').click();
  const palette=page.getByRole('dialog',{name:'搜索与命令面板'});
  await palette.getByLabel('搜索命令').fill(directory.items[0].name);
  await expect(palette).toContainText('正在读取工作区目录');
  await expect.poll(()=>reads).toBe(1);
  // 隔离页面内驱动可见性事件，不切换用户前台窗口。
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.clock.fastForward(2_100);
  expect(reads).toBe(1);
  const resumed=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/api/v4/projects'));
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await (await resumed).finished();
  await expect.poll(()=>reads).toBe(2);
  await page.context().setOffline(true);
  await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(false);
  await page.clock.fastForward(2_100);
  expect(reads).toBe(2);
  await page.context().setOffline(false);
  await expect(palette.getByText('项目',{exact:true})).toBeVisible();
  expect(requests.length).toBeGreaterThanOrEqual(3);
  await palette.getByLabel('搜索命令').press('Escape');
  await expect(palette).toHaveCount(0);
});

test('当前任务失效后保留记录，空态紧凑且今日完成按Task结果查询',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1'),current=snapshot.current[0],observedAt=Date.now()-60_000;
  snapshot.current=[{...current,executionStatus:'unknown',progressLabel:'待更新',stale:true,observedAt}];
  snapshot.currentCount=null;snapshot.coverage.tasks=false;
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'error',stale:true,observedAt,error:'任务读取超时'}));
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:snapshot}));
  await login(page);
  await expect(page.locator('.overview-current')).toContainText(current.title);
  await expect(page.locator('.overview-current')).toContainText('状态待更新');
  await expect(page.locator('.overview-current')).toContainText('上次确认');
  await expect(page.locator('.overview-summary>div strong')).toHaveText(String(snapshot.knownCounts.current));
  await expect(page.locator('.overview-summary>div')).toContainText('项已读取');
  await page.locator('#global-notice summary').click();
  await expect(page.locator('#global-notice .source-details')).toContainText('任务数据');
  await expect(page.locator('#global-notice .source-details')).toContainText('读取用时较长');
  snapshot.current=[];snapshot.currentCount=0;snapshot.coverage.tasks=true;
  snapshot.olderOpen=[];snapshot.olderOpenCount=0;snapshot.attention=[];snapshot.attentionCount=0;
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'ready',stale:false,observedAt:Date.now(),error:null}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.overview-current')).toContainText('暂无当前任务');
  await expect(page.locator('.overview-recent')).toContainText('已经完成的改动');
  await page.setViewportSize({width:390,height:844});
  const empty=await page.locator('.overview-current .overview-empty').boundingBox();
  const recent=await page.locator('[data-key=overview-recent-panel]').boundingBox();
  expect(empty!.height).toBeLessThan(100);expect(recent!.y).toBeLessThan(450);
  expect(await page.locator('#view').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.screenshot({path:screenshots+'/overview-task-empty-narrow.png',fullPage:true});
  await page.getByRole('button',{name:/今日完成/}).click();
  await expect(page).toHaveURL(/requestState=closed/);
  await expect(page).toHaveURL(/resultStatus=completed/);
  await expect(page).not.toHaveURL(/execution=completed/);
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
});

test('任务数量与待办在观察到期后自动降级，不为侧栏再次查询总览',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1'),current=snapshot.current[0];
  const observedAt=Date.now()-10_000;
  current.observedAt=observedAt;
  current.executionStatus='running';current.executionObservedAt=observedAt;current.lastProgressAt=observedAt;
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'ready',stale:false,observedAt,error:null}));
  snapshot.attention=[{id:current.id,title:current.title,nodeId:current.nodeId,kind:'review',detail:'任务结果等待验收',actionLabel:'验收结果',observedAt,stale:false}];
  snapshot.attentionCount=1;
  let reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>{reads++;return route.fulfill({json:snapshot});});
  await login(page);
  await expect(page.locator('#sidebar [data-view=tasks] .nav-count')).toHaveText(String(snapshot.currentCount));
  await expect(page.getByRole('button',{name:'验收结果',exact:true})).toBeVisible();
  await expect(page.locator('.overview-current .overview-task-heading>.badge')).toHaveText('执行中');
  const loaded=reads;
  await page.clock.fastForward(21_000);
  await expect(page.locator('#sidebar [data-view=tasks] .nav-count')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'查看任务记录',exact:true})).toBeVisible();
  await expect(page.locator('.overview-current')).toContainText('状态待更新');
  await expect(page.locator('.overview-current .overview-task-heading>.badge')).toHaveText('最近有活动');
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  await expect(page.locator('#statusbar')).toContainText('页面读取');
  expect(reads).toBe(loaded);
  await page.getByRole('button',{name:'查看任务记录',exact:true}).click();
  await expect(page).toHaveURL(/tab=summary/);
});

test('手动模式按活动截止时间重分首页任务，数量和执行优先排序同步更新',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const snapshot=await f.get('overview?fresh=1'),base=snapshot.current[0],now=await page.evaluate(()=>Date.now());
  const task=(id:string,title:string,lastProgressAt:number,executionObservedAt:number|null)=>({...base,id:'qmtask:'+id,taskId:id,title,
    requestState:'active',resultStatus:null,lastActivityAt:lastProgressAt,lastProgressAt,executionObservedAt,
    executionStatus:executionObservedAt===null?'waiting':'running',observedAt:now,stale:false,
    progressLabel:executionObservedAt===null?'最近有活动':'执行中',progressSummary:executionObservedAt===null?null:'已确认后台执行仍在运行'});
  const stillRecent=task('clock-recent','仍有近期进展',now-10_000,null);
  const losesPriority=task('clock-priority','执行证明到期但仍有近期进展',now-60_000,now-20_000);
  const executionOnly=task('clock-execution-only','仅执行证明保持当前的任务',now-3_600_000,now-20_000);
  const silenceBoundary=task('clock-silence','即将超过三十分钟的任务',now-30*60_000+10_000,null);
  snapshot.current=[losesPriority,executionOnly,stillRecent,silenceBoundary];snapshot.currentCount=4;snapshot.knownCounts.current=4;
  snapshot.olderOpen=[];snapshot.olderOpenCount=0;snapshot.knownCounts.olderOpen=0;snapshot.coverage.tasks=true;
  snapshot.attention=[];snapshot.attentionCount=0;
  snapshot.taskSources=snapshot.taskSources.map((source:any)=>({...source,state:'ready',observedAt:now,stale:false,error:null}));
  let reads=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>{reads++;return route.fulfill({json:snapshot});});
  await login(page);
  await expect(page.locator('.overview-current .overview-task-title')).toHaveText([losesPriority.title,executionOnly.title,stillRecent.title,silenceBoundary.title]);
  await expect(page.locator('.overview-summary>div strong')).toHaveText('4');
  const loaded=reads;
  await page.clock.fastForward(11_000);
  await expect(page.locator('.overview-current .overview-task-title')).toHaveText([stillRecent.title,losesPriority.title]);
  await expect(page.locator('.overview-summary>div strong')).toHaveText('2');
  await expect(page.locator('[data-key=overview-current-panel]>.panel-head .badge')).toHaveText('2');
  await expect(page.locator('#sidebar [data-view=tasks] .nav-count')).toHaveText('2');
  await expect(page.locator('#overview-older-open>summary .badge')).toHaveText('2');
  await page.locator('#overview-older-open>summary').click();
  await expect(page.locator('#overview-older-open .overview-task-title')).toHaveText([silenceBoundary.title,executionOnly.title]);
  await expect(page.locator('#overview-older-open .overview-task-heading>.badge')).toHaveText(['等待继续','等待继续']);
  await expect(page.locator('#view')).not.toContainText('已确认后台执行仍在运行');
  await expect(page.locator('#global-notice .notice')).toHaveCount(0);
  expect(reads).toBe(loaded);

  // The same visible rows cannot stand in for the unreturned part of a capped overview.
  snapshot.currentCount=15;snapshot.knownCounts.current=15;snapshot.olderOpenCount=80;snapshot.knownCounts.olderOpen=80;
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.overview-current .overview-task-title')).toHaveText([stillRecent.title,losesPriority.title]);
  await expect(page.locator('.overview-summary>div>span')).toHaveText('当前任务 · 上次读取');
  await expect(page.locator('.overview-summary>div strong')).toHaveText('15');
  await expect(page.locator('[data-key=overview-current-panel]>.panel-head .badge')).toHaveText('上次读取 15');
  await expect(page.locator('#overview-older-open>summary .badge')).toHaveText('上次读取 80');
  await expect(page.getByRole('button',{name:'查看全部当前任务',exact:true})).toBeVisible();
  await expect(page.locator('#sidebar [data-view=tasks] .nav-count')).toHaveCount(0);
});

test('当前任务页到期后保留可打开的记录，完整页重算数量而部分分页保留快照游标',async({page})=>{
  await page.clock.install();
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const response=await f.get('runs?days=0&fresh=1'),base=response.items.find((run:any)=>run.taskId===f.waiting.task_id);
  expect(base).toBeTruthy();
  let snapshot:any,reads=0;
  const prepare=(now:number,partial:boolean)=>({...response,items:[{...base,executionStatus:'waiting',executionObservedAt:null,
    lastProgressAt:now-30*60_000+10_000,lastActivityAt:now-30*60_000+10_000,observedAt:now,stale:false}],
    offset:0,limit:1,total:partial?3:1,nextCursor:partial?'activity-clock-next-page':null,previousCursor:null,
    complete:true,coverage:{tasks:true,details:true},sources:response.sources.map((source:any)=>({...source,state:'ready',observedAt:now,error:null,stale:false}))});
  await page.route(url=>url.pathname.endsWith('/api/v4/runs'),route=>{reads++;return route.fulfill({json:snapshot});});
  await login(page);
  snapshot=prepare(await page.evaluate(()=>Date.now()),false);
  await page.goto(f.server.baseUrl+'/console/#/tasks');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
  await expect(page.locator('[data-action=task-scope][data-value=current] .count')).toHaveText('1');
  const loaded=reads;
  await page.clock.fastForward(11_000);
  await expect(page.locator('.run-table tbody tr')).toHaveCount(0);
  await expect(page.locator('[data-action=task-scope][data-value=current] .count')).toHaveText('0');
  await expect(page.locator('.list-pane .pagination>span')).toHaveText('0 条');
  await expect(page.locator('[data-key=task-aged-records]')).toContainText(base.title);
  await expect(page.locator('[data-key=task-aged-records]')).toContainText('等待继续');
  expect(reads).toBe(loaded);

  snapshot=prepare(await page.evaluate(()=>Date.now()),true);
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
  await expect(page.locator('[data-action=task-scope][data-value=current] .count')).toHaveCount(0);
  const partialRead=reads;
  await page.clock.fastForward(11_000);
  await expect(page.locator('.run-table tbody tr')).toHaveCount(0);
  await expect(page.locator('[data-key=task-aged-records]')).toContainText(base.title);
  await expect(page.locator('.list-pane .pagination>span')).toContainText('本页当前符合 0 项');
  await expect(page.locator('.list-pane .pagination>span')).toContainText('上次读取共 3 项');
  await expect(page.locator('.list-pane .pagination>span')).toContainText('完整数量待更新');
  const next=page.locator('.list-pane [data-action=page]').filter({hasText:'下一页'});
  await expect(next).toBeEnabled();await expect(next).toHaveAttribute('data-value','activity-clock-next-page');
  expect(reads).toBe(partialRead);
  await page.locator('[data-key=task-aged-records] .overview-task-title').click();
  await expect(page.locator('.inspector .session-heading h2')).toHaveText(base.title);
  await expect(page.getByLabel('任务范围',{exact:true})).toHaveValue('current');
  await expect(page.getByLabel('任务范围',{exact:true}).locator('option:checked')).toHaveText('当前任务');
});

test('任务生命周期独立于失败命令，筛选与详情保持同一事实',async({page})=>{
  const isolated = await consoleExperienceFixture();
  try {
    const result = await isolated.server.client.callTool({
      name: 'exec_command',
      arguments: {
        workspace_id: isolated.workspace.workspace_id,
        cmd: `"${process.execPath}" -e "process.exit(1)"`,
        operation_key: 'lifecycle-failed-command',
        yield_time_ms: 1000,
      },
      _meta: {'openai/session': 'console-experience'},
    });
    expect(structured(result).operation_id).toEqual(expect.any(String));
    await expect.poll(async () => {
      const tasks = await isolated.get('runs?days=0&fresh=1&requestState=active');
      expect(tasks.items.map((task:any) => task.taskId)).toEqual([isolated.waiting.task_id]);
      return tasks.items[0].executionStatus;
    }, {timeout: 15000, intervals: [250, 500, 1000]}).toBe('failed');

    await login(page, isolated.server.baseUrl);
    await page.goto(isolated.server.baseUrl + '/console/#/tasks?days=0&scope=all');
    await page.locator('[data-action=task-scope][data-value=open]').click();
    await expect(page).toHaveURL(/requestState=active/);
    const row = page.locator('.run-table tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-activity-state=recent]')).toHaveText('最近有活动');
    await expect(row).toContainText('上次活动');
    await expect(row).not.toContainText('任务进行中');
    await page.screenshot({path: screenshots + '/task-lifecycle-desktop.png', fullPage: true});

    await row.locator('[data-action=open-run]').first().click();
    await expect(page.locator('.inspector [data-activity-state=recent]').first()).toHaveText('最近有活动');
    await expect(page.locator('.inspector .result-section')).toContainText('最后一次受管执行失败');
    await expect(page.locator('.inspector .session-live.failed .live-meta')).toHaveText('最近退出码 1');
    await expect(page.getByLabel('任务范围', {exact:true})).toHaveValue('open');
    await page.setViewportSize({width:760,height:900});
    await page.screenshot({path: screenshots + '/task-lifecycle-narrow.png', fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.goto(isolated.server.baseUrl + '/console/#/tasks?days=0&scope=all');
    await page.locator('[data-action=task-scope][data-value=ended]').click();
    await expect(page.locator('.run-table tbody tr')).toHaveCount(2);
    await expect(page.locator('.run-table')).not.toContainText('等待下一步的工作');
  } finally {
    await isolated.server.dispose();
  }
});

test('节点配置刷新合并独立修改，明确解决冲突后才提交新版本',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const original=await f.get('fleet/status'),current=structuredClone(original),node=current.nodes.find((item:any)=>item.online);
  expect(node).toBeTruthy();node.name='原节点名';node.revision=10;node.egress.port=8000;node.egress.probe='https://original.invalid/ping';
  const settings={revision:10 as number|null,savedRevision:10,appliedRevision:9,pending:true,error:'测试应用失败，允许修正',nickname:node.name,priority:node.priority,egress:{...node.egress}};
  let held=false,release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),readStarted=new Promise<void>(resolve=>{started=resolve;});
  await page.route(url=>url.pathname.endsWith('/api/v4/fleet/status'),route=>route.fulfill({json:current}));
  await page.route(url=>url.pathname.endsWith('/console/api/login'),async route=>{const response=await route.fetch(),body=await response.json();body.capabilities.settings=true;await route.fulfill({response,json:body});});
  const writes:any[]=[];
  await page.route(url=>url.pathname.endsWith('/nodes/'+encodeURIComponent(node.id)+'/settings'),async route=>{
    if(route.request().method()==='GET'){
      if(held){started();await gate;}
      await route.fulfill({json:{settings,roots:[],source:{nodeId:node.id,name:node.name,online:true,state:'ready',stale:false,observedAt:Date.now(),error:null}}});return;
    }
    writes.push(route.request().postDataJSON());
    await route.fulfill(writes.length===1?{status:422,json:{code:'invalid_input',message:'测试明确拒绝',effect:'none'}}:{json:{saved:true,revision:12,appliedRevision:12}});
  });
  await login(page);
  await page.goto(f.server.baseUrl+'/console/#/settings?section=egress');
  await page.locator('[data-action=node][data-tab=settings]').filter({hasText:'节点设置'}).first().click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.locator('[data-dialog-confirm]')).toBeEnabled();await expect(dialog).toContainText('运行配置应用失败');
  await dialog.locator('[name=name]').fill('我的节点名');await dialog.locator('[name=probe]').fill('https://mine.invalid/ping');
  settings.revision=11;settings.savedRevision=11;settings.egress.port=9000;settings.egress.probe='https://other.invalid/ping';held=true;
  await dialog.locator('[data-dialog-refresh]').click();await readStarted;
  await expect(dialog.locator('[data-dialog-refresh]')).toBeDisabled();await expect(dialog.locator('[data-dialog-confirm]')).toBeDisabled();
  release();await expect(dialog.locator('[data-dialog-refresh]')).toBeEnabled();
  await expect(dialog.locator('[name=name]')).toHaveValue('我的节点名');await expect(dialog.locator('[name=port]')).toHaveValue('9000');
  await expect(dialog.locator('[name=probe]')).toHaveValue('https://mine.invalid/ping');
  expect(await dialog.locator('[name=probe]').evaluate((field:HTMLInputElement)=>field.validity.customError)).toBe(true);
  await dialog.getByRole('button',{name:'保留我的输入',exact:true}).click();
  await dialog.locator('[data-dialog-confirm]').click();await expect(dialog.locator('[data-dialog-error]')).toContainText('测试明确拒绝');
  await dialog.locator('[name=name]').fill('已核对节点名');await dialog.locator('[data-dialog-confirm]').click();
  await expect(dialog).toHaveCount(0);expect(writes).toHaveLength(2);
  expect(writes[0].expectedRevision).toBe(11);expect(writes[0].settings.egress.port).toBe(9000);expect(writes[0].settings.egress.probe).toBe('https://mine.invalid/ping');
  expect(writes[1].requestKey).not.toBe(writes[0].requestKey);expect(writes[1].settings.name).toBe('已核对节点名');
  settings.revision=null;await page.locator('[data-action=node][data-tab=settings]').first().click();
  await expect(page.locator('dialog [data-dialog-error]')).toContainText('尚未取得可保存的配置版本');
  await expect(page.locator('dialog [data-dialog-confirm]')).toBeDisabled();expect(writes).toHaveLength(2);
});

test('传输文件名按文字显示，未知总量有明确进度，未知取消只查询原回执',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const fleet=await f.get('fleet/status'),nodeId=fleet.nodes[0].id,source='/tmp/<img data-forged="yes" src="x">.txt';
  const items=[{id:'transfer-a',nodeId,source,destination:'/tmp/out',bytes:0,total:null,status:'running',speed:null,startedAt:Date.now(),revision:'one',error:null},
    {id:'transfer-empty',nodeId,source:'/tmp/empty',destination:'/tmp/out-empty',bytes:0,total:0,status:'completed',speed:null,startedAt:Date.now(),revision:'two',error:null}];
  await page.route(url=>url.pathname.endsWith('/api/v4/activity')&&url.searchParams.get('kind')==='transfers',route=>route.fulfill({json:{items,sources:[],complete:true,total:2,offset:0,limit:25,nextCursor:null,bins:[]}}));
  let posts=0,queries=0,key='';
  await page.route(url=>url.pathname.endsWith('/api/v4/transfers/cancel'),route=>{posts++;key=route.request().postDataJSON().requestKey;return route.fulfill({status:504,json:{code:'timeout',message:'结果待核对',effect:'unknown'}});});
  await page.route(url=>url.pathname.includes('/api/v4/receipts/'),route=>{
    queries++;const url=new URL(route.request().url());expect(url.pathname.endsWith(key)).toBe(true);expect(url.searchParams.get('target')).toBe('transfer-a');
    return route.fulfill({json:{state:'completed',response:{transfer:{status:'cancelled'}}}});
  });
  await login(page);await page.goto(f.server.baseUrl+'/console/#/activity?kind=transfers');
  await expect(page.locator('.transfer h3').first()).toHaveText('<img data-forged="yes" src="x">.txt');await expect(page.locator('.transfer [data-forged]')).toHaveCount(0);
  await expect(page.locator('.transfer').first()).toContainText('总量待确认');await expect(page.locator('.transfer').nth(1)).toContainText('100.0%');
  await expect(page.locator('#view')).not.toContainText(/NaN|Infinity|未上报\/s/);
  await page.getByRole('button',{name:'取消传输',exact:true}).click();await page.locator('dialog [data-dialog-confirm]').click();
  await expect(page.locator('dialog [data-dialog-confirm]')).toHaveText('查询原提交结果');
  expect(await page.locator('dialog .dialog-body').evaluate((element:HTMLElement)=>element.inert)).toBe(true);
  await page.locator('dialog [data-dialog-confirm]').click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(posts).toBe(1);expect(queries).toBe(1);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:screenshots+'/transfer-narrow.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.route(url=>url.pathname.endsWith('/api/v4/receipts'),route=>route.fulfill({json:{items:[{scope:'console:/api/v4/runs/a/control:',requestKey:'accepted',path:'/api/v4/runs/a/control',state:'completed',effect:'applied',createdAt:'2026-10-22T12:00:00.000Z',finishedAt:null,response:{status:'accepted'}}]}}));
  await page.goto(f.server.baseUrl+'/console/#/activity?kind=receipts');
  await expect(page.locator('.receipt-row')).toContainText('请求已接收，执行待结束');await expect(page.locator('.receipt-row [data-action=receipt-query]')).toBeVisible();
  await expect(page.locator('.receipt-row time')).not.toHaveText('—');
});

test('任务详情保留交付总结、各工作区阶段入口和文件来源',async({page})=>{
  await login(page);
  const reference='qmtask:'+f.completed.task_id;
  const detail=await f.get('runs/'+encodeURIComponent(reference)+'?fresh=1');
  // Reading the first workspace associates the Task with it; only the actual
  // apply_patch in the second workspace creates an execution phase.
  expect(detail.run.workspaces.map((workspace:any)=>canonicalWorkspaceRoot(workspace.root)).sort()).toEqual(
    [canonicalWorkspaceRoot(f.server.project),canonicalWorkspaceRoot(f.server.secondRoot)].sort());
  expect(detail.phases).toHaveLength(1);
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference));
  await expect(page.locator('.execution-summary')).toContainText('文件已经写入');
  await expect(page.locator('.phase-card')).toHaveCount(1);
  const phase=await page.locator('.phase-card [data-action=open-run]').first().getAttribute('data-id');expect(phase).toMatch(/^qm:/);
  expect(phase).toBe(detail.phases[0].id);
  await page.locator('.phase-card [data-action=open-run]').first().click();await expect(page).toHaveURL(new RegExp('run='+encodeURIComponent(phase!)));
  await expect(page.locator('.phase-card')).toHaveCount(0);
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent(reference)+'&tab=diff');
  await expect.poll(async()=>{
    const source=(await page.locator('.file-source').first().textContent())||'';
    const root=source.split(' · ').slice(2).join(' · ');
    return root?canonicalWorkspaceRoot(root):'';
  }).toBe(canonicalWorkspaceRoot(f.server.secondRoot));
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&run='+encodeURIComponent('qmtask:'+f.waiting.task_id));
  await expect(page.locator('[data-action=finish-task]')).toBeVisible();await expect(page.locator('#inspector')).not.toContainText('结束并验收');
  await expect(page.locator('#inspector')).not.toContainText('结果待验收');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:screenshots+'/task-detail-narrow.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('真实文件采集显示在途与失败证据，保留旧文件并隔离历史检查点',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  const capture=await liveCaptureFixture(f),collector=capture.collector;
  const original=collector.capture,descriptor=Object.getOwnPropertyDescriptor(collector,'capture');
  const name='capture-state.txt',path=join(capture.member.root,name),backup=path+'.test-backup';
  let release:(()=>void)|undefined,hasBackup=false;
  const hold=()=>{
    let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    collector.capture=async function(memberId,taskId,paths){
      if(memberId===capture.member.id&&taskId===capture.taskId){entered();await gate;}
      return original.call(this,memberId,taskId,paths);
    };
    collector.markDirty(capture.member.id,[name],capture.taskId);
    return started;
  };
  const finish=async()=>{release?.();release=undefined;await collector.flushTask(capture.member.id,capture.taskId);collector.capture=original;};
  const show=async(reference:string)=>page.goto(f.server.baseUrl+'/console/#/tasks?days=0&scope=all&tab=diff&run='+encodeURIComponent(reference));
  const noUnsafeActions=async()=>expect(page.locator('#inspector [data-action=patch]:enabled,#inspector [data-action=single-accept]:enabled,#inspector [data-action=single-reject]:enabled,#inspector [data-action=revert]:enabled')).toHaveCount(0);
  try {
    const evidence=await collector.prepareWrite(capture.member,[name],capture.member.root,capture.taskId);
    await writeFile(path,'first captured content\n','utf8');
    await collector.recordWrite(capture.member,evidence,capture.taskId);
    await hold();
    await login(page);await show(capture.reference);
    await expect(page.locator('.change-capture-notice')).toContainText('文件改动采集进行中');
    const pendingRoot=page.locator('.capture-scope[data-capture-state=pending] code');
    await expect(pendingRoot).toBeVisible();
    expect(canonicalWorkspaceRoot(await pendingRoot.innerText())).toBe(canonicalWorkspaceRoot(capture.member.root));
    await expect(page.locator('.file-section')).toHaveCount(0);
    await expect(page.locator('#inspector')).not.toContainText('暂无已记录的文件改动');
    await expect(page.locator('#inspector')).not.toContainText('文件改动正在整理，当前列表尚未确认完整。');
    await page.locator('[data-action=detail-tab][data-value=summary]').click();
    await expect(page.locator('.change-capture-notice')).toHaveCount(1);
    await expect(page.locator('#inspector')).not.toContainText('文件改动正在整理，当前列表尚未确认完整。');
    await page.locator('[data-action=detail-tab][data-value=diff]').click();
    await noUnsafeActions();await page.screenshot({path:screenshots+'/capture-pending.png',fullPage:true});
    await finish();await page.locator('#topbar [data-action=refresh]').click();
    await expect(page.locator('.file-section')).toHaveCount(1);
    await expect(page.locator('.change-capture-notice')).toHaveCount(0);
    await show(capture.phaseId);await expect(page.locator('#inspector [data-action=patch]')).toBeEnabled();

    await hold();await page.locator('#topbar [data-action=refresh]').click();
    await expect(page.locator('.change-capture-notice')).toContainText('文件改动采集进行中');
    await expect(page.locator('.file-section')).toHaveCount(1);await noUnsafeActions();
    const historical=await f.get('runs/'+encodeURIComponent('qmtask:'+f.completed.task_id)+'?fresh=1');
    expect(historical.changeCaptures).toEqual([]);
    const frozenPhase=historical.files.find((file:any)=>file.path==='finished.txt').source.runId;
    await show(frozenPhase);
    await expect(page.locator('.change-capture-notice')).toHaveCount(0);
    await expect(page.locator('.file-path')).toContainText('finished.txt');
    await expect(page.locator('#inspector [data-action=patch]')).toBeEnabled();
    const downloadEvent=page.waitForEvent('download');
    await page.locator('#inspector [data-action=patch]').click();
    const download=await downloadEvent;
    expect(await readFile((await download.path())!,'utf8')).toContain('真实完成的文件内容');
    await page.locator('dialog footer [data-dialog-close]').click();
    await finish();

    await rename(path,backup);hasBackup=true;await mkdir(path);
    collector.markDirty(capture.member.id,[name],capture.taskId);
    await expect(collector.flushTask(capture.member.id,capture.taskId)).rejects.toThrow();
    const failed=await f.get('runs/'+encodeURIComponent(capture.phaseId)+'?fresh=1');
    expect(failed.changeCaptures[0].state).toBe('failed');expect(failed.changeCaptures[0].error).toBeTruthy();
    await show(capture.phaseId);
    // 此例关闭轮询；返回刚打开过的阶段会复用缓存，需通过页面主动刷新。
    const [refreshed]=await Promise.all([
      page.waitForResponse(response=>{
        const url=new URL(response.url());
        return url.pathname.endsWith('/runs/'+encodeURIComponent(capture.phaseId))&&url.searchParams.get('fresh')==='1';
      }),
      page.getByRole('button',{name:'刷新文件证据',exact:true}).click(),
    ]);
    expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).changeCaptures[0].state).toBe('failed');
    await expect(page.locator('.change-capture-notice')).toContainText('文件改动采集失败');
    await expect(page.locator('.change-capture-notice')).toContainText(failed.changeCaptures[0].error);
    await expect(page.locator('#inspector')).not.toContainText('文件改动整理失败，当前列表可能不完整：'+failed.changeCaptures[0].error);
    await expect(page.locator('.file-section')).toHaveCount(1);await noUnsafeActions();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:screenshots+'/capture-failed-narrow.png',fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await rm(path,{recursive:true,force:true});await rename(backup,path);hasBackup=false;
    collector.markDirty(capture.member.id,[name],capture.taskId);await collector.flushTask(capture.member.id,capture.taskId);
    await page.getByRole('button',{name:'刷新文件证据',exact:true}).click();
    await expect(page.locator('.capture-scope[data-capture-state=failed]')).toHaveCount(0);
    await expect(page.locator('.change-capture-notice')).toHaveCount(0);
    await expect(page.locator('.file-section')).toHaveCount(1);await expect(page.locator('#inspector [data-action=patch]')).toBeEnabled();
  } finally {
    try {
      release?.();collector.capture=original;
      if(hasBackup){await rm(path,{recursive:true,force:true});await rename(backup,path);}
      collector.markDirty(capture.member.id,[name],capture.taskId);
      await collector.flushTask(capture.member.id,capture.taskId);
    } finally {
      if(descriptor)Object.defineProperty(collector,'capture',descriptor);else Reflect.deleteProperty(collector,'capture');
    }
  }
});

test('登录成功仍校验服务能力，不允许进入不兼容页面',async({page})=>{
  await page.route(url=>url.pathname.endsWith('/console/api/login'),async route=>{
    const response=await route.fetch(),body=await response.json();body.capabilities.taskLifecycle=false;await route.fulfill({response,json:body});
  });
  await page.goto(f.server.baseUrl+'/console/');await page.locator('#login-form input[name=password]').fill(f.server.config.oauth.ownerToken!);
  await page.locator('#login-form [type=submit]').click();
  await expect(page.locator('#login-form [data-form-error]')).toContainText('版本不一致');await expect(page.locator('.overview-summary')).toHaveCount(0);
});

test('真实浏览器关闭重开仍保持登录，退出后再次打开需要认证',async()=>{
  const profile=await mkdtemp(join(tmpdir(),'quaymesh-browser-session-'));
  let context=await chromium.launchPersistentContext(profile,{headless:true});
  try{
    let page=await context.newPage();await login(page);
    const cookie=(await context.cookies()).find(value=>value.name==='qm_console_session')!;
    expect(cookie.httpOnly).toBe(true);expect(cookie.expires).toBeGreaterThan(Date.now()/1000+86400);
    await context.close();context=await chromium.launchPersistentContext(profile,{headless:true});
    page=await context.newPage();await page.goto(f.server.baseUrl+'/console/');
    await expect(page.locator('.overview-summary')).toBeVisible();await expect(page.locator('#login-form')).toHaveCount(0);
    const auth=await (await context.request.get(f.server.baseUrl+'/console/api/session')).json();
    const logout=await context.request.post(f.server.baseUrl+'/console/api/logout',{headers:{origin:f.server.baseUrl,'x-quaymesh-csrf':auth.csrf},data:{}});
    expect(logout.status()).toBe(200);
    await context.close();context=await chromium.launchPersistentContext(profile,{headless:true});
    page=await context.newPage();await page.goto(f.server.baseUrl+'/console/');
    await expect(page.locator('#login-form')).toBeVisible();
  }finally{await context.close();await rm(profile,{recursive:true,force:true});}
});

test('后端连接中断时不要求重新输入口令，真实HTTP恢复后继续原登录',async({page})=>{
  let backend:Server=createServer(f.server.running.app);
  await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const port=(backend.address() as AddressInfo).port;
  let base='';
  const relay=await new McpRelay({origin:`http://127.0.0.1:${port}`,port:await freePort(),
    consoleRpc:(request:{method:string;path:string;headers:Record<string,string>;body?:string;signal:AbortSignal})=>
      new Promise((resolve,reject)=>{
        const upstream=httpRequest({host:'127.0.0.1',port,path:request.path,method:request.method,
          headers:{...request.headers,host:new URL(base).host},signal:request.signal},response=>{
            const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
            response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('base64'),bodyBase64:true}));
          });
        upstream.on('error',reject);upstream.end(request.body);
      })}).start();
  base=`http://127.0.0.1:${relay.port}`;
  try{
    await login(page,base);
    await page.goto(base+'/console/?entry=local#/overview');
    await expect(page.locator('.overview-summary')).toBeVisible();
    backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));
    await page.reload();
    await expect(page.getByRole('heading',{name:'控制台暂未连接'})).toBeVisible();
    await expect(page.locator('#login-form')).toHaveCount(0);
    backend=createServer(f.server.running.app);
    await new Promise<void>(resolve=>backend.listen(port,'127.0.0.1',resolve));
    await page.getByRole('button',{name:'重新连接',exact:true}).click();
    await expect(page.locator('.overview-summary')).toBeVisible();
    await expect(page.locator('#login-form')).toHaveCount(0);
    await expect(page).toHaveURL(base+'/console/?entry=local#/overview');
    backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));
    await page.reload();
    await expect(page.getByRole('heading',{name:'控制台暂未连接'})).toBeVisible();
    backend=createServer(f.server.running.app);
    await new Promise<void>(resolve=>backend.listen(port,'127.0.0.1',resolve));
    await expect(page.locator('.overview-summary')).toBeVisible({timeout:15_000});
    await expect(page.locator('#login-form')).toHaveCount(0);
    await expect(page).toHaveURL(base+'/console/?entry=local#/overview');
  }finally{
    await page.close();await relay.close();backend.closeAllConnections();
    await new Promise<void>(resolve=>backend.close(()=>resolve()));
  }
});

test('Task历史阶段按页读取，前后页和窄屏预览保持完整Task身份',async({page})=>{
  const local=await consoleExperienceFixture();
  try{
    const ledger=new WorkLedger(local.server.config.stateDir),store=new SessionStore(ledger.db);
    let phaseCount=0;
    try{
      const taskId=String(local.waiting.task_id),sessionId=String(local.waiting.session_id);
      const member=store.getMember(sessionId,store.taskMemberIds(taskId)[0]!);
      for(let index=0;index<41;index++){
        const run=ledger.begin({root:member.root,workspaceId:member.id,workItemId:taskId,runKey:'browser-history-'+index,
          title:'历史执行 '+index,origin:{entryPoint:'console',evidence:'server_entry'}});
        store.linkRun(sessionId,member.id,run.id,taskId);
        ledger.db.prepare('UPDATE console_work_runs SET summary=? WHERE id=?').run('已保存的历史阶段 '+index,run.id);
      }
      const snapshot=await new SessionProjector(store,local.server.config.stateDir,null,undefined,member.node_id)
        .readSnapshot(sessionId,member.id,taskId);
      const phases=readLocalTaskIndex(local.server.config,undefined,{taskIds:[taskId]}).items;
      phaseCount=phases.length;expect(phaseCount).toBeGreaterThan(40);
      for(const phase of phases)saveRunCheckpoint(ledger.db,phase.localId,{revision:1,snapshot,files:[]});
    }finally{ledger.close();}
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await login(page,local.server.baseUrl,'tasks',local.server.config.oauth.ownerToken!);
    const reference='qmtask:'+local.waiting.task_id,path='/console/api/v4/runs/'+encodeURIComponent(reference);
    const response=page.waitForResponse(reply=>new URL(reply.url()).pathname===path&&reply.status()===200);
    await page.locator('.run-title[data-id="'+reference+'"]').first().click();
    const first=await (await response).json();
    expect(first.run.phaseRefs).toHaveLength(phaseCount);expect(first.phasePage.references).toHaveLength(20);
    await expect(page.locator('.phase-pagination')).toContainText('第 1 / 3 页');
    await expect(page.locator('.phase-pagination')).toContainText('本页记录已读取');
    await expect(page.locator('.phase-card')).toHaveCount(20);
    await page.screenshot({path:screenshots+'/phase-pagination-desktop.png',fullPage:true});
    const next=page.waitForResponse(reply=>new URL(reply.url()).pathname===path&&new URL(reply.url()).searchParams.has('phaseCursor')&&reply.status()===200);
    await page.locator('.phase-pagination').getByRole('button',{name:'下一页',exact:true}).click();
    const second=await (await next).json();
    expect(second.run.phaseRefs).toEqual(first.run.phaseRefs);expect(second.run.revision).toBe(first.run.revision);
    expect(second.complete).toBe(false);expect(second.phasePage.complete).toBe(true);expect(second.missingPhases).toEqual([]);
    await expect(page.locator('.phase-pagination')).toContainText('第 2 / 3 页');
    await expect(page.locator('.phase-card')).toHaveCount(20);
    await page.locator('[data-action=detail-tab][data-value=diff]').click();
    await expect(page.locator('.inspector')).toContainText('本页为历史执行');
    await expect(page.locator('.inspector')).toContainText('可在阶段卡片查看该阶段改动');
    await expect(page.locator('.phase-card')).toHaveCount(20);
    await page.locator('[data-action=detail-tab][data-value=summary]').click();
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('.phase-pagination').getByRole('button',{name:'上一页',exact:true})).toBeInViewport();
    await expect(page.locator('.phase-pagination').getByRole('button',{name:'下一页',exact:true})).toBeInViewport();
    await page.screenshot({path:screenshots+'/phase-pagination-narrow.png',fullPage:true});
    await page.locator('.phase-pagination').getByRole('button',{name:'上一页',exact:true}).click();
    await expect(page.locator('.phase-pagination')).toContainText('第 1 / 3 页');
    await page.locator('.phase-card [data-action=open-run]').first().click();
    await expect(page.locator('.inspector')).toBeVisible();
    await expect(page.locator('.phase-pagination')).toHaveCount(0);
    expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('phaseCursor')).toBe(false);
    expect(errors).toEqual([]);
  }finally{await local.server.dispose();}
});
