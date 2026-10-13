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
  await page.locator('[data-action=status][data-value=waiting]').click();
  await expect(page.locator('.run-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.run-table')).toContainText('等待下一步的工作');
  await page.locator('[data-action=status][data-value=done]').click();
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
