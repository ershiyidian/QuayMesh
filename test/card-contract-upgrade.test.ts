import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { snapshotSchema } from '../src/session/schema.js';
import { snapshotFromSchema } from '../src/ui/session-card/snapshot.js';
import { previewSnapshot } from '../src/ui/session-card/preview.js';
import { WORKSPACE_APP_URI, WORKSPACE_APP_VERSION } from '../src/tool-surfaces/types.js';
import { createRealTestServer } from './session-card/server-fixture.js';
import {createMcpSource} from '../src/ui/session-card/source.js';
import type {App} from '@modelcontextprotocol/ext-apps';
import {projectionForCard} from '../src/session/card-contract.js';

// 旧卡片的实际严格协议：新增的两个字段会导致整份快照被拒收。
const oldReader = snapshotSchema.omit({sourceTaskId: true, executionObservation: true}).strict();

test('旧卡片在新服务的启动和后续读取中保持可用，新卡片保留完整活性', async t => {
  const f = await createRealTestServer({git: false});
  t.after(() => f.dispose());
  const meta = {'openai/session': randomUUID()};
  const started = await f.client.callTool({name: 'start_session', arguments: {title: '滚动升级契约', request_key: randomUUID()}, _meta: meta});
  assert.notEqual(started.isError, true);
  const initial = (started._meta as any)?.quaymesh?.snapshot;
  assert.ok(initial);
  assert.equal(oldReader.safeParse(initial).success, true, '旧缓存卡片必须能解析新的启动回执');
  const {session_id, task_id} = started.structuredContent as {session_id:string;task_id:string};
  const identity = {session_id, task_id};
  const opened = await f.client.callTool({name: 'open_workspace', arguments: {path: f.project}, _meta: meta});
  assert.notEqual(opened.isError, true);
  assert.equal(oldReader.safeParse((opened._meta as any)?.quaymesh?.snapshot).success, true);
  for (const version of ['task-card-v5', undefined, 'task-card-v4', WORKSPACE_APP_VERSION]) {
    const result = await f.client.callTool({name: 'qm_session', arguments: {...identity, since_rev: -1,
      ...(version ? {resource_version: version} : {})}, _meta: meta});
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const data = result.structuredContent as any;
    if (version === WORKSPACE_APP_VERSION) {
      assert.ok(data.snapshot.executionObservation);
      assert.ok('sourceTaskId' in data.snapshot);
    } else {
      assert.equal(oldReader.safeParse(data.snapshot).success, true, `旧读取器必须接受 ${version ?? '无版本'} 的完整快照`);
      assert.equal('observation' in data, false, '旧版输出协议也没有独立的 observation 字段');
    }
  }
});

test('旧输出协议的未变化回执同样不携带新增观察字段', () => {
  const result = {unchanged:true, rev:previewSnapshot.rev,
    observation:{observedAt:Date.now(),activeOperationIds:[],preparingOperationIds:[],staleOperationIds:[]}};
  for (const version of [undefined, 'task-card-v4', 'task-card-v5']) {
    assert.deepEqual(projectionForCard(result, version), {unchanged:true, rev:result.rev});
  }
  assert.deepEqual(projectionForCard(result, WORKSPACE_APP_VERSION), result);
  assert.ok(result.observation, '协议投影不改写原始快照');
});

test('资源 URI、握手版本、旧资源入口保持一致', async t => {
  assert.equal(WORKSPACE_APP_VERSION, 'task-card-v6');
  assert.equal(WORKSPACE_APP_URI, 'ui://quaymesh/task-card/v6.html');
  const f = await createRealTestServer({git: false});
  t.after(() => f.dispose());
  const listing = await f.client.listTools();
  const start = listing.tools.find(tool => tool.name === 'start_session');
  assert.equal((start?._meta?.ui as any)?.resourceUri, WORKSPACE_APP_URI);
  for (const uri of [WORKSPACE_APP_URI, 'ui://quaymesh/task-card/v5.html']) {
    const response = await f.client.readResource({uri});
    assert.equal(response.contents[0].uri, uri);
  }
});

test('展示端接受额外展示字段，继续拒绝损坏的已知字段', () => {
  const future = {...previewSnapshot, futureDisplayBadge: 'safe-addition'};
  assert.equal(snapshotFromSchema(future).sessionId, previewSnapshot.sessionId);
  assert.equal('futureDisplayBadge' in snapshotFromSchema(future), false);
  assert.throws(() => snapshotFromSchema({...future, commands: 'broken'}));
  assert.throws(() => snapshotFromSchema({...future, executionObservation: {observedAt: -1}}));
  assert.equal(snapshotSchema.safeParse(future).success, false, '服务端写出校验继续严格');
});

test('每次界面读取都声明协议版本，不只首轮握手携带', async () => {
  const requests: Array<{name:string;arguments:Record<string,unknown>}> = [];
  const app = {
    getHostCapabilities: () => ({serverTools: {}}),
    callServerTool: async (request: {name:string;arguments:Record<string,unknown>}) => {
      requests.push(request);
      return {content: [], structuredContent: {unchanged: false, snapshot: previewSnapshot}};
    },
  } as unknown as App;
  const source = createMcpSource(app, previewSnapshot.sessionId, previewSnapshot.taskId!);
  try {
    for (let i=0; i<3; i++) await source.snapshot(i);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.arguments.resource_version === WORKSPACE_APP_VERSION));
    assert.ok(requests[0].arguments.mount_id);
    assert.equal(requests[1].arguments.mount_id, undefined);
  } finally {source.dispose();}
});

test('选择工作区后生命周期事件仍符合真实工具声明', async t => {
  const f = await createRealTestServer({git: false});
  t.after(() => f.dispose());
  const definitions = (await f.client.listTools()).tools;
  const sent: Array<{name:string;arguments:Record<string,unknown>}> = [];
  const app = {
    getHostCapabilities: () => ({serverTools: {}}),
    callServerTool: async (request: {name:string;arguments:Record<string,unknown>}) => {
      sent.push(request);
      return {content: [], structuredContent: request.name === 'qm_session'
        ? {unchanged:false, snapshot:previewSnapshot} : {recorded:true}};
    },
  } as unknown as App;
  const source = createMcpSource(app, previewSnapshot.sessionId, previewSnapshot.taskId!);
  try {
    await source.snapshot(-1, undefined, 'selected-member');
    await source.widgetStage!('visible', {visible:true});
    const event = sent.find(request => request.name === 'qm_widget_stage')!;
    assert.equal('member_id' in event.arguments, false, '任务级生命周期不继承工作区级参数');
    const schema = definitions.find(tool => tool.name === event.name)!.inputSchema;
    const unknown = Object.keys(event.arguments).filter(key => !(key in (schema.properties ?? {})));
    assert.deepEqual(unknown, [], '卡片事件不能携带工具声明之外的参数');
  } finally { source.dispose(); }
});

test('已挂载旧卡片的工作区参数只接受所属会话，错误身份仍拒绝', async t => {
  const f = await createRealTestServer({git:false});
  t.after(() => f.dispose());
  const meta = {'openai/session':randomUUID()};
  const started = await f.client.callTool({name:'start_session', arguments:{title:'旧卡片事件',request_key:randomUUID()}, _meta:meta});
  const identity = started.structuredContent as {session_id:string;task_id:string};
  const opened = await f.client.callTool({name:'open_workspace', arguments:{path:f.project}, _meta:meta});
  const memberId = (opened._meta as any).quaymesh.member_id;
  assert.ok(memberId);
  const args = {...identity, stage:'visible',resource_version:'task-card-v5',mount_id:randomUUID(),visible:true};
  const valid = await f.client.callTool({name:'qm_widget_stage',arguments:{...args,member_id:memberId},_meta:meta});
  assert.notEqual(valid.isError,true,JSON.stringify(valid));
  const invalid = await f.client.callTool({name:'qm_widget_stage',arguments:{...args,member_id:'foreign-member'},_meta:meta});
  assert.equal(invalid.isError,true);
});
