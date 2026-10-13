"""Exercise the real fleet UI against the included three-node API fixture.
Install: python -m pip install playwright; python -m playwright install chromium
Run: python test/federation/browser.test.py
"""
import json, subprocess, pathlib, urllib.request, urllib.error, os
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[2]
proc=subprocess.Popen(['node','test/federation/fleet-browser-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
port=json.loads(proc.stdout.readline())['port'];base=f'http://127.0.0.1:{port}'
errors=[];results=[]
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True, **({'executable_path': os.environ['QUAYMESH_CHROMIUM']} if os.environ.get('QUAYMESH_CHROMIUM') else {}))
  context=browser.new_context(viewport={'width':1440,'height':1050},permissions=['clipboard-read','clipboard-write'])
  page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  cookies={'value':''}
  def fixture_fetch(_source, path, options):
   data=options.get('body'); headers=options.get('headers',{}).copy()
   if cookies['value']:headers['Cookie']=cookies['value']
   req=urllib.request.Request(base+path,data=data.encode() if data else None,headers=headers,method=options.get('method','GET'))
   try:res=urllib.request.urlopen(req)
   except urllib.error.HTTPError as err:res=err
   if res.headers.get('Set-Cookie'):cookies['value']=res.headers['Set-Cookie'].split(';')[0]
   return {'status':res.status,'body':res.read().decode()}
  page.expose_binding('fixtureFetch',fixture_fetch)
  page.set_content((root/'src/ui/fleet/index.html').read_text().replace('<script type="module" src="./fleet.js"></script>','').replace('<link rel="stylesheet" href="./fleet.css">',''))
  page.add_style_tag(content=(root/'src/ui/fleet/fleet.css').read_text())
  page.add_script_tag(content="window.fetch = async (path, options={}) => { const result=await window.fixtureFetch(path, options); return {status:result.status, ok:result.status>=200 && result.status<300, json:async()=>JSON.parse(result.body)}; };")
  page.add_script_tag(type='module',content=(root/'src/ui/fleet/fleet.js').read_text())
  page.get_by_label('管理口令').fill('test-owner');page.get_by_role('button',name='进入主控台').click()
  page.locator('.node').first.wait_for();assert page.locator('.node').count()==3;results.append('login and three-node overview')
  images=root/'docs/images';images.mkdir(parents=True,exist_ok=True)
  page.screenshot(path=str(images/'federation-overview.png'),full_page=True)
  page.locator('[data-view=roots]').click();page.get_by_role('button',name='添加根目录').click()
  page.get_by_label('目录昵称').fill('浏览器交互测试');page.get_by_label('稳定 ID').fill('browser-test')
  page.get_by_label('该机器上的绝对路径').fill('D:\\Projects\\BrowserTest');page.get_by_label('用途说明').fill('GUI test fixture')
  page.get_by_label('标签（逗号分隔）').fill('ui, test');page.get_by_role('button',name='保存目录',exact=True).click()
  page.locator('#editor').wait_for(state='hidden');page.get_by_text('浏览器交互测试',exact=True).wait_for();results.append('root create and persistence in fixture')
  page.get_by_label('搜索根目录').fill('browser-test');assert page.locator('#root-table tbody tr').count()==1;results.append('root search')
  page.get_by_label('搜索根目录').fill('');page.screenshot(path=str(images/'federation-roots.png'),full_page=True)
  row=page.locator('tr').filter(has_text='浏览器交互测试');row.get_by_role('button',name='编辑').click()
  page.get_by_label('目录昵称').fill('已修改昵称');page.get_by_role('button',name='保存目录',exact=True).click();page.locator('#editor').wait_for(state='hidden');page.get_by_text('已修改昵称',exact=True).wait_for();results.append('root edit')
  page.locator('[data-view=nodes]').click();page.locator('.node').filter(has_text='计算服务器 2').get_by_role('button',name='设置',exact=True).click()
  page.get_by_label('节点昵称',exact=True).fill('数据服务器 Beta');page.get_by_role('button',name='保存设置',exact=True).click();page.locator('#editor').wait_for(state='hidden');page.get_by_role('heading',name='数据服务器 Beta',exact=True).wait_for();results.append('node nickname and settings submit')
  page.get_by_role('button',name='同步 config.yaml',exact=True).click();page.get_by_label('从文件导入').set_input_files({'name':'config.yaml','mimeType':'text/yaml','buffer':b'mixed-port: 7890\n'})
  page.get_by_role('button',name='同步配置',exact=True).click();page.get_by_text('数据服务器 Beta：已保存并加载',exact=False).wait_for();results.append('mihomo YAML upload and three targets')
  page.get_by_role('button',name='关闭',exact=True).last.click()
  for view in ['work','transfers','events']:page.locator(f'[data-view={view}]').click();assert page.locator('main').inner_text().strip();results.append(view+' view')
  data=page.request.get(base+'/fixture-requests').json();assert any('/settings/update' in item['path'] and item['body']['settings'].get('nickname')=='数据服务器 Beta' for item in data)
  assert not any('subagents' in item.get('body',{}).get('settings',{}) for item in data);results.append('settings keep provider configuration out of writes')
  page.set_viewport_size({'width':390,'height':844});page.locator('[data-view=overview]').click()
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
  page.screenshot(path=str(images/'federation-mobile.png'),full_page=True);results.append('mobile width and navigation')
  assert not errors,errors
  browser.close()
finally:proc.terminate();proc.wait(timeout=5)
print(json.dumps({'passed':results,'page_errors':errors},ensure_ascii=False,indent=2))
