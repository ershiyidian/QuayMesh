import {test,expect,chromium,type Page} from '@playwright/test';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request as httpRequest,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {consoleExperienceFixture} from './experience-fixture.js';
// @ts-expect-error 节点管理器使用ESM脚本。
import {McpRelay} from '../../node/relay.mjs';

let f:Awaited<ReturnType<typeof consoleExperienceFixture>>;
const screenshots='releases/console-experience';
test.beforeAll(async()=>{f=await consoleExperienceFixture();await mkdir(screenshots,{recursive:true});});
test.afterAll(async()=>{await f?.server.dispose();});
async function login(page:Page,base=f.server.baseUrl){
  await page.goto(base+'/console/');
  await page.locator('#login-form input[name=password]').fill(f.server.config.oauth.ownerToken!);
  const sent=page.waitForResponse(response=>response.url()===base+'/console/api/login');
  await page.locator('#login-form [type=submit]').click();
  const reply=await sent;expect(reply.status(),await reply.text()).toBe(200);
  await expect(page.locator('#login-form')).toHaveCount(0);
  await expect(page.locator('.summary-grid')).toBeVisible();
}

test('总览只列实际执行，状态筛选、工作区和对话详情在浏览器中一致',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page);
  await expect(page.locator('.overview-active .run-card')).toHaveCount(0);
  await expect(page.locator('#view')).toContainText('等待下一步的工作');
  await expect(page.locator('#view')).toContainText('已经完成的改动');
  expect(await page.locator('.brand-image').first().evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true);
  await page.screenshot({path:screenshots+'/overview-dark.png',fullPage:true});
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(3);
  await page.getByLabel('具体任务状态',{exact:true}).selectOption('waiting');
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.run-table')).toContainText('等待下一步的工作');
  await page.getByLabel('具体任务状态',{exact:true}).selectOption('done');
  const scope=page.locator('.run-table .workspace-disclosure');
  await scope.locator('summary').click();
  await expect(scope.locator('.workspace-popover code')).toHaveCount(2);
  await expect(scope.locator('.workspace-popover code').last()).toBeInViewport({ratio:0.95});
  await expect(scope).toContainText(f.server.secondRoot.toLowerCase());
  await page.screenshot({path:screenshots+'/workspace-details.png',fullPage:true});
  const projects=await f.get('projects');
  const project=projects.items.find((value:any)=>value.path.toLowerCase()===f.server.project.toLowerCase());
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

test('读取等待可见，刷新失败保留旧记录且明确标为未更新',async({page})=>{
  await page.addInitScript(()=>localStorage.setItem('quaymesh.workbench.v5',JSON.stringify({poll:0})));
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),async route=>{
    const response=await route.fetch();await held;await route.fulfill({response});
  });
  const opening=login(page);
  try {
    await expect(page.locator('.loading')).toBeVisible();
    await expect(page.locator('#statusbar')).toContainText('正在读取当前页面');
    const size=await page.locator('.skeleton').first().boundingBox();expect(size?.width).toBeGreaterThan(100);expect(size?.height).toBeGreaterThan(5);
    await page.screenshot({path:screenshots+'/overview-loading.png',fullPage:true});
  } finally {release();}
  await opening;
  await page.unrouteAll({behavior:'wait'});
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:{active:[]}}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('#global-notice')).toContainText('读取失败');
  await expect(page.locator('#statusbar')).toContainText('保留上次数据');
  await expect(page.locator('.summary-grid')).toBeVisible();
  await expect(page.locator('#view')).toContainText('总览响应结构不完整');
  await page.unrouteAll({behavior:'wait'});
  const snapshot=await f.get('overview'),running={...snapshot.waiting[0],executionStatus:'running',stale:false,observedAt:Date.now(),finishedAt:null};
  snapshot.active=[running];snapshot.runningCount=1;snapshot.waiting=[];snapshot.waitingCount=0;
  await page.route(url=>url.pathname.endsWith('/api/v4/overview'),route=>route.fulfill({json:snapshot}));
  await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('[data-elapsed]')).toHaveAttribute('data-observed',String(running.observedAt));
  running.observedAt+=1000;await page.locator('#topbar [data-action=refresh]').click();
  await expect(page.locator('[data-elapsed]')).toHaveAttribute('data-observed',String(running.observedAt));
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
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&run='+encodeURIComponent(reference));
  await expect(page.locator('.execution-summary')).toContainText('文件已经写入');
  await expect(page.locator('.phase-card')).toHaveCount(2);
  const phase=await page.locator('.phase-card [data-action=open-run]').first().getAttribute('data-id');expect(phase).toMatch(/^qm:/);
  await page.locator('.phase-card [data-action=open-run]').first().click();await expect(page).toHaveURL(new RegExp('run='+encodeURIComponent(phase!)));
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&run='+encodeURIComponent(reference)+'&tab=diff');
  await expect.poll(async()=>((await page.locator('.file-source').first().textContent())||'').toLowerCase()).toContain(f.server.secondRoot.toLowerCase());
  await page.goto(f.server.baseUrl+'/console/#/tasks?days=0&run='+encodeURIComponent('qmtask:'+f.waiting.task_id));
  await expect(page.locator('[data-action=finish-task]')).toBeVisible();await expect(page.locator('#inspector')).not.toContainText('结束并验收');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:screenshots+'/task-detail-narrow.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('登录成功仍校验服务能力，不允许进入不兼容页面',async({page})=>{
  await page.route(url=>url.pathname.endsWith('/console/api/login'),async route=>{
    const response=await route.fetch(),body=await response.json();body.capabilities.taskLifecycle=false;await route.fulfill({response,json:body});
  });
  await page.goto(f.server.baseUrl+'/console/');await page.locator('#login-form input[name=password]').fill(f.server.config.oauth.ownerToken!);
  await page.locator('#login-form [type=submit]').click();
  await expect(page.locator('#login-form [data-form-error]')).toContainText('版本不一致');await expect(page.locator('.summary-grid')).toHaveCount(0);
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
    await expect(page.locator('.summary-grid')).toBeVisible();await expect(page.locator('#login-form')).toHaveCount(0);
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
  const relay=await new McpRelay({origin:`http://127.0.0.1:${port}`,port:0,consoleAssetDir:join(process.cwd(),'dist','ui'),
    consoleRpc:(request:{method:string;path:string;headers:Record<string,string>;body?:string;signal:AbortSignal})=>
      new Promise((resolve,reject)=>{
        const upstream=httpRequest({host:'127.0.0.1',port,path:request.path,method:request.method,
          headers:{...request.headers,host:new URL(base).host},signal:request.signal},response=>{
            const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
            response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
          });
        upstream.on('error',reject);upstream.end(request.body);
      })}).start();
  base=`http://127.0.0.1:${relay.port}`;
  try{
    await login(page,base);
    backend.closeAllConnections();await new Promise<void>(resolve=>backend.close(()=>resolve()));
    await page.reload();
    await expect(page.getByRole('heading',{name:'控制台暂未连接'})).toBeVisible();
    await expect(page.locator('#login-form')).toHaveCount(0);
    backend=createServer(f.server.running.app);
    await new Promise<void>(resolve=>backend.listen(port,'127.0.0.1',resolve));
    await page.getByRole('button',{name:'重新连接',exact:true}).click();
    await expect(page.locator('.summary-grid')).toBeVisible();
    await expect(page.locator('#login-form')).toHaveCount(0);
  }finally{
    await page.close();await relay.close();backend.closeAllConnections();
    await new Promise<void>(resolve=>backend.close(()=>resolve()));
  }
});
