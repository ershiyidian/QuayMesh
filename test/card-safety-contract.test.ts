import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRealTestServer} from './session-card/server-fixture.js';

// 这些地址来自 Git 发布历史；检查冷读取，不依赖宿主已有的 HTML 缓存。
const publishedVersions = [1, 3, 4, 5, 6];

test('所有已发布卡片地址在真实 MCP 发现后仍可读取', async t => {
  const f = await createRealTestServer({git:false});
  t.after(() => f.dispose());
  for (const version of publishedVersions) {
    await t.test(`v${version}`, async () => {
      const uri = `ui://quaymesh/task-card/v${version}.html`;
      const result = await f.client.readResource({uri});
      assert.equal(result.contents[0]?.uri, uri);
      assert.match(String(result.contents[0]?.text), /<!doctype html>/i);
      assert.match(String(result.contents[0]?.text), new RegExp(`name="quaymesh-card-version" content="task-card-v${version}"`));
    });
  }
});

for (const preauthorized of [false, true]) {
  test(`真实 tools/list 明确声明能力，免确认=${preauthorized}`, async t => {
    const f = await createRealTestServer({git:false, configure:async config => ({...config,dangerouslySkipCommandReview:preauthorized})});
    t.after(() => f.dispose());
    const {tools} = await f.client.listTools();
    for (const tool of tools) {
      for (const field of ['readOnlyHint','destructiveHint','openWorldHint'] as const) {
        assert.equal(typeof tool.annotations?.[field], 'boolean', `${tool.name}.${field}`);
      }
      if (tool.annotations?.readOnlyHint) assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
    const shell = tools.find(tool => tool.name === 'exec_command')!;
    assert.equal(shell.annotations?.readOnlyHint, false);
    assert.equal(shell.annotations?.destructiveHint, true);
    assert.equal(shell.annotations?.openWorldHint, true);
  });
}

test('卡片外启动回执包含原任务恢复入口', async t => {
  const f = await createRealTestServer({git:false});
  t.after(() => f.dispose());
  const meta = {'openai/session':randomUUID()};
  const started = await f.client.callTool({name:'start_session',arguments:{title:'卡片加载失败仍可恢复',request_key:randomUUID()},_meta:meta});
  const task = (started.structuredContent as {task_id:string}).task_id;
  const text = started.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.ok(text.includes(task));
  assert.ok(text.includes(f.config.publicBaseUrl));
  assert.ok(text.includes(encodeURIComponent(task)));
});
