import {expect,test} from '@playwright/test';

for (const version of [1,3,4,5,6,7]) {
  test(`v${version} 历史地址通过真实 MCP 冷加载并读取同一任务`, async ({page}) => {
    const uri=`ui://quaymesh/task-card/v${version}.html`;
    await page.route('**/api/bootstrap',async route=>{
      const response=await route.fetch();
      const data=await response.json();
      const resource=await page.request.post('/api/read-resource',{data:{uri}});
      expect(resource.ok()).toBe(true);
      const contents=(await resource.json()).contents;
      expect(contents[0].uri).toBe(uri);
      await route.fulfill({response,json:{...data,resourceUri:uri,resourceHtml:contents[0].text}});
    });
    const errors:string[]=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('ready');
    const card=page.frameLocator('#app-frame');
    await expect(card.locator('meta[name="quaymesh-card-version"]')).toHaveAttribute('content',`task-card-v${version}`);
    await expect(card.locator('#stats')).toContainText('命令');
    await expect(card.locator('#title')).not.toContainText('BOOTSTRAP');
    await card.locator('#toggle').click();
    await expect(card.locator('#details')).toBeVisible();
    const state=await (await page.request.get('/api/state')).json();
    expect(state.callLog.filter((line:string)=>line.includes('ERR '))).toEqual([]);
    const bootstrap=await (await page.request.get('/api/bootstrap')).json();
    const taskId=bootstrap.openResult._meta.quaymesh.task_id;
    const finished=await page.evaluate(id=>window.__quaymeshHost.requestTool('finish_task',{task_id:id,status:'completed',summary:'冷加载与重新挂载验收'}),taskId);
    expect(finished.isError).not.toBe(true);
    const before=await (await page.request.get('/api/state')).json();
    await page.evaluate(async()=>{await window.__quaymeshHost.teardownFrame();await window.__quaymeshHost.mountFrame();});
    await expect(card.locator('#stats')).toContainText('命令');
    await expect.poll(async()=> (await (await page.request.get('/api/state')).json()).lastError).toBeNull();
    const after=await (await page.request.get('/api/state')).json();
    expect(after.callLog.filter((line:string)=>/OK (start_session|exec_command|apply_patch) /.test(line))).toEqual(before.callLog.filter((line:string)=>/OK (start_session|exec_command|apply_patch) /.test(line)));
    expect(errors).toEqual([]);
  });
}
