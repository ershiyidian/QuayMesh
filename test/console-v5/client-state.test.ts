import test from 'node:test';
import assert from 'node:assert/strict';
import { Resources } from '../../src/ui/console-v5/resources.js';
import { ApiError, WriteIntent, validateSession, createApi } from '../../src/ui/console-v5/client.js';
import { mergeFields } from '../../src/ui/console-v5/settings-form.js';
import { elapsed, esc, percent, resultExplanation, changeCaptureBlockReason, changeCaptureNotice, dedupeCaptureWarnings, acceptanceBadge, status, transferPercent } from '../../src/ui/console-v5/presentation.js';
import { fullTime, setDisplayTimeZone, day, timestamp } from '../../src/ui/console-v5/format.js';
import { taskStages, taskStage } from '../../src/console-task-state.js';
import { resourceHealth } from '../../src/ui/console-v5/source-state.js';
import { CommandOutputs } from '../../src/ui/console-v5/command-output.js';
import type { Run, ActionReceipt, ChangeCapture } from '../../src/ui/console-v5/contracts.js';
import { EventNotifications, type NotificationMemory, type NotificationPage } from '../../src/ui/console-v5/notifications.js';
import { filterTaskIndex, type TaskIndex } from '../../src/console-workbench/task-aggregation.js';
import { receiptLabel, canQueryReceipt } from '../../src/ui/console-v5/receipt-presentation.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
}
function resourceFixture(get: (path: string, signal?: AbortSignal) => Promise<unknown>) {
  const loaded: string[] = [];
  const resources = new Resources({get} as ReturnType<typeof createApi>, {freshness:()=>8000,paint(){},loaded:path=>loaded.push(path)});
  return {resources,loaded};
}

test('写后强制读取隔离晚到的旧请求及其 finally，最终缓存为写后版本', async () => {
  const before=deferred<unknown>(), after=deferred<unknown>(), signals:AbortSignal[]=[];
  let calls=0;
  const {resources,loaded}=resourceFixture(async(_path,signal)=>{signals.push(signal!);return ++calls===1?before.promise:after.promise;});
  const oldRead=resources.load('projects');
  const newRead=resources.load('projects',true);
  assert.equal(signals[0].aborted,true);
  after.resolve({items:[],revision:2}); await newRead;
  before.resolve({items:[],revision:1}); await oldRead;
  assert.equal(calls,2);
  assert.deepEqual(resources.data('projects'),{items:[],revision:2});
  assert.deepEqual(loaded,['projects']);
  assert.equal(resources.entries.get('projects')?.loading,false);
});

test('失效后重读与取消保持身份，隐藏页取消不会触发 loaded 再次读取', async () => {
  const before=deferred<unknown>(), after=deferred<unknown>(); let calls=0;
  const {resources,loaded}=resourceFixture(async(_path,signal)=>{
    const request=++calls===1?before:after;
    signal!.addEventListener('abort',()=>request.reject(new DOMException('cancelled','AbortError')),{once:true});
    return request.promise;
  });
  const oldRead=resources.load('projects'); resources.invalidate();
  const newRead=resources.load('projects'); after.resolve({items:[],revision:2});
  await Promise.all([oldRead,newRead]);
  assert.deepEqual(loaded,['projects']);
  const held=deferred<unknown>(), fixture=resourceFixture(async(_path,signal)=>{
    signal!.addEventListener('abort',()=>held.reject(new DOMException('cancelled','AbortError')),{once:true});return held.promise;
  });
  const reading=fixture.resources.load('projects');fixture.resources.cancelAll();await reading;
  assert.deepEqual(fixture.loaded,[]);
  assert.equal(fixture.resources.entries.get('projects')?.error,null);
});

test('不完整的总览被资源层拒绝，读取中或陈旧来源不会显示已确认', async () => {
  const {resources}=resourceFixture(async()=>({active:[]}));
  await resources.load('overview');
  assert.match(resources.entries.get('overview')!.error!.message,/结构不完整/);
  assert.equal(resources.data('overview'),null);
  const pending={data:null,time:0,error:null,loading:true};
  assert.equal(resourceHealth([pending]).label,'正在读取当前页面');
  const stale={data:{sources:[{nodeId:'n',name:'n',state:'refreshing',stale:true,online:true,observedAt:1,error:null}]},time:2,error:null,loading:false};
  assert.equal(resourceHealth([stale]).tone,'amber');
});

test('配置三方合并更新未编辑字段、保留独立编辑并明确冲突', () => {
  const base={name:'old',port:'8000',enabled:true,probe:'old-url'};
  const local={...base,name:'my-name',probe:'my-url'};
  const remote={...base,port:'9000',enabled:false,probe:'remote-url'};
  const result=mergeFields(base,local,remote);
  assert.deepEqual(result.values,{name:'my-name',port:'9000',enabled:false,probe:'my-url'});
  assert.deepEqual(result.conflicts,['probe']);
  assert.deepEqual(base,{name:'old',port:'8000',enabled:true,probe:'old-url'});
});

test('明确拒绝后的新提交使用新 key；未知提交只能查询原结果', async () => {
  const keys:string[]=[];
  const knownApi={post:async(_path:string,_body:unknown,key:string)=>{keys.push(key);if(keys.length===1)throw new ApiError('说明必填',422,'validation',{effect:'none'});return {ok:true};},get:async()=>null} as unknown as Pick<ReturnType<typeof createApi>,'post'|'get'>;
  const known=new WriteIntent(knownApi,'runs/review');
  await assert.rejects(known.submit({note:''}),/说明必填/);await known.submit({note:'已核对'});
  assert.notEqual(keys[0],keys[1]);
  let posts=0,gets=0;
  const unknownApi={post:async()=>{posts++;throw new ApiError('等待回执',0,'timeout',{effect:'unknown'});},get:async(path:string)=>{gets++;assert.match(path,/receipts\/.+\?path=/);return {state:'completed',response:{ok:true}};}} as unknown as Pick<ReturnType<typeof createApi>,'post'|'get'>;
  const uncertain=new WriteIntent(unknownApi,'runs/one/control');
  await assert.rejects(uncertain.submit({action:'interrupt'}),/等待回执/);
  await assert.rejects(uncertain.submit({action:'resume'}),/先查询原结果/);
  assert.deepEqual(await uncertain.submit({action:'interrupt'}),{ok:true});
  assert.equal(posts,1);assert.equal(gets,1);
});

test('登录路径使用完整能力检查，状态和显示边界保持明确', () => {
  assert.throws(()=>validateSession({contract:'quaymesh.console.v4',user:{name:'Owner',role:'owner'},csrf:'x',capabilities:{write:true}}),/版本不一致/);
  for(const [key,label] of taskStages)assert.ok(status(key).includes(esc(label)),key);
  assert.equal(transferPercent({bytes:0,total:null,status:'running'}),null);
  assert.equal(transferPercent({bytes:0,total:0,status:'completed'}),100);
  assert.equal(transferPercent({bytes:2,total:0,status:'running'}),null);
  assert.equal(percent(0,0),null);
  assert.equal(fullTime(Number.NaN),'未上报');
  setDisplayTimeZone('not/a/timezone');assert.doesNotThrow(()=>day(Date.now()));
  assert.equal(esc('<button data-action="logout">x</button>'),'&lt;button data-action=&quot;logout&quot;&gt;x&lt;/button&gt;');
  const run={executionStatus:'running',startedAt:1,finishedAt:null,observedAt:1000,stale:true} as Run;
  assert.ok(!elapsed(run).includes('data-elapsed'));
  assert.match(elapsed(run),/待核对/);
});

test('概要回退与状态说明相同时只显示一次，真实交付总结完整保留', () => {
  const reason='当前没有后台执行，请求仍然开放';
  const fallback=resultExplanation(' '+reason+'\n',reason,'waiting');
  assert.equal(fallback.split(reason).length-1,1);
  assert.doesNotMatch(fallback,/execution-summary/);
  const summary=reason+'；已生成 <report>，测试通过，等待确认。';
  const delivered=resultExplanation(summary,reason,'waiting');
  assert.ok(delivered.includes(`<p class="execution-summary">${esc(summary)}</p>`));
  assert.ok(delivered.includes(`<p class="notice ">${reason}</p>`));
  assert.match(resultExplanation('交付完成',null,'done'),/execution-summary/);
  assert.equal(resultExplanation('','核对执行结果','unknown'),'<p class="notice warn">核对执行结果</p>');
});

test('文件证据采集状态限定于当前详情，历史检查点和旧节点字段缺失不会误报失败', () => {
  const idle:ChangeCapture={runId:'phase-a',nodeId:'node-a',projectName:'project-a',root:'/work/ProjectA',state:'idle',error:null};
  assert.equal(changeCaptureBlockReason(undefined),null);
  assert.equal(changeCaptureNotice(undefined),'');
  assert.equal(changeCaptureBlockReason([]),null);
  assert.equal(changeCaptureNotice([]),'');
  assert.equal(changeCaptureBlockReason([idle]),null);
  assert.equal(changeCaptureNotice([idle]),'','正常文件列表不显示常驻技术告示');
  const pending={...idle,runId:'phase-b',state:'pending'} as ChangeCapture;
  assert.match(changeCaptureBlockReason([pending])!,/仍在采集/);
  assert.equal(changeCaptureBlockReason([]),null,'新阶段采集不能污染历史详情');
});

test('混合采集状态展示每个工作区和真实错误，不把缺失证据当作无改动', () => {
  const pending:ChangeCapture={runId:'run-pending',nodeId:'node-a',projectName:'project-a',root:'/work/ProjectA',state:'pending',error:null};
  const failed:ChangeCapture={runId:'run-failed',nodeId:'node-b',projectName:'<project-b>',root:'/work/<ProjectB>',state:'failed',error:'cannot read <evidence> & retry'};
  const html=changeCaptureNotice([{...pending,root:'/work/IdleProject',state:'idle'},pending,failed]);
  assert.match(changeCaptureBlockReason([pending,failed])!,/部分采集失败/);
  assert.match(html,/data-capture-state="pending"/);assert.match(html,/data-capture-state="failed"/);
  assert.ok(html.includes('/work/ProjectA'));assert.ok(html.includes(esc(failed.root)));assert.ok(html.includes(esc(failed.error)));
  assert.doesNotMatch(html,/<project-b>|<evidence>|暂无文件改动|IdleProject|data-capture-state="idle"/);
  assert.match(html,/已取得的文件仍可查看/);assert.match(html,/暂不能验收结果、导出补丁或还原文件/);
});

test('采集告示仅去除对应状态与完整错误文本，保留旧节点和其他警告', () => {
  const pending:ChangeCapture={runId:'one',nodeId:'node',projectName:'project',root:'/work',state:'pending',error:null};
  const failed:ChangeCapture={...pending,state:'failed',error:'EISDIR: capture-state.txt'};
  const pendingText='文件改动正在整理，当前列表尚未确认完整。';
  const failedText='文件改动整理失败，当前列表可能不完整：'+failed.error;
  const other=['节点连接超时','来源覆盖不完整',pendingText+' 请另行检查。','文件改动整理失败，当前列表可能不完整：另一个错误'];
  const warnings=[pendingText,failedText,...other];
  assert.deepEqual(dedupeCaptureWarnings(warnings,[pending,failed]),other);
  assert.deepEqual(dedupeCaptureWarnings(warnings,[pending]),[failedText,...other]);
  assert.deepEqual(dedupeCaptureWarnings(warnings,[failed]),[pendingText,...other]);
  for(const captures of [undefined,[],[{...pending,state:'idle' as const}]])assert.deepEqual(dedupeCaptureWarnings(warnings,captures),warnings);
  assert.deepEqual(warnings,[pendingText,failedText,...other],'不能修改原始诊断记录');
});

test('命令输出取消后丢弃迟到分页，游标不推进时退出读取', async () => {
  const pending=deferred<any>();
  const reader=new CommandOutputs(async()=>pending.promise,()=>{});
  const reading=reader.load('commands/one',new Set());reader.cancelAll();
  pending.resolve({chunk:'late',cursor:4,done:true,hasMore:false,truncated:false});await reading;
  assert.equal(reader.entries.get('commands/one')!.text,'');
  let calls=0;
  const stuck=new CommandOutputs(async()=>{calls++;return {chunk:'',cursor:0,done:false,hasMore:true,truncated:false} as any;},()=>{});
  await stuck.load('commands/two',new Set());assert.equal(calls,1);
  assert.match(stuck.entries.get('commands/two')!.error!,/游标无效/);
});

test('错误通知以节点分别推进，离线补读及同时间多事件不会遗漏或重复', async () => {
  const memory:NotificationMemory={a:{cursor:{after:100,afterId:'old'},seen:[]},b:{cursor:{after:10,afterId:'old'},seen:[]}};
  let saved:NotificationMemory=memory, offline=true;
  const emitted:string[]=[],gaps=new Map<string,string|null>(),requests:Array<[string,number|null]>=[];
  const event=(nodeId:string,id:string,time:number)=>({id,nodeId,time,level:'error',message:id,details:{}});
  const reader=new EventNotifications({memory,save:value=>{saved=value;},emit:(_node,items)=>emitted.push(...items.map(item=>item.nodeId+':'+item.id)),gap:(node,message)=>{gaps.set(node,message);},
    read:async(node,cursor)=>{
      requests.push([node,cursor?.after??null]);
      if(node==='b'&&offline)return {items:[],complete:false,observedAt:null,nextAfter:null,total:0};
      const items=node==='a'&&cursor!.after===100?[event('a','one',200),event('a','two',200)]:node==='b'&&cursor!.after===10?[event('b','late',20)]:[];
      return {items,complete:true,observedAt:300,nextAfter:items.length?{after:items.at(-1)!.time,afterId:items.at(-1)!.id}:null,total:items.length};
    }});
  await reader.poll(['a','b']);assert.equal(saved.a.cursor.after,200);assert.equal(saved.b.cursor.after,10);assert.match(gaps.get('b')!,/覆盖不完整/);
  offline=false;await reader.poll(['a','b']);await reader.poll(['a','b']);
  assert.deepEqual(emitted,['a:one','a:two','b:late']);assert.equal(saved.b.cursor.after,20);assert.equal(gaps.get('b'),null);
  assert.ok(requests.some(([node,after])=>node==='b'&&after===10));
});

test('首次错误通知以服务端空页时间建立基线，保留跨重载去重记录', async () => {
  let saved:NotificationMemory={},emitted=0;
  const pages:NotificationPage[]=[{items:[],complete:true,observedAt:123,nextAfter:null,total:0},{items:[{nodeId:'n',id:'e',time:124,level:'error',message:'e',details:{}}],complete:true,observedAt:125,nextAfter:{after:124,afterId:'e'},total:1}];
  const reader=new EventNotifications({save:value=>{saved=value;},emit:()=>{emitted++;},gap(){},read:async(_node,cursor)=>{if(pages.length===1)assert.deepEqual(cursor,{after:123,afterId:''});return pages.shift()!;}});
  await reader.poll(['n']);assert.deepEqual(saved.n.cursor,{after:123,afterId:''});assert.equal(emitted,0);
  await reader.poll(['n']);assert.equal(emitted,1);assert.deepEqual(saved.n.seen,['n:e']);
  const resumed=new EventNotifications({memory:saved,save(){},emit:()=>{emitted++;},gap(){},read:async(_node,cursor)=>{assert.deepEqual(cursor,{after:124,afterId:'e'});return {items:[],complete:true,observedAt:130,nextAfter:null,total:0};}});
  await resumed.poll(['n']);assert.equal(emitted,1);
});

test('需要目标作用域的写请求查询回执时保留原目标', async () => {
  for(const body of [{id:'qm:node:run'}, {projectId:'qm:node:project'}, {previewId:'preview:one'}]) {
    let queried='';
    const api={post:async()=>{throw new ApiError('未知结果',0,'timeout',{effect:'unknown'});},get:async(path:string)=>{queried=path;return {state:'completed',response:{ok:true}};}} as unknown as Pick<ReturnType<typeof createApi>,'post'|'get'>;
    const intent=new WriteIntent(api,'archive/commit');await assert.rejects(intent.submit(body));await intent.submit(body);
    const query=new URLSearchParams(queried.split('?')[1]);assert.equal(query.get('target'),Object.values(body)[0]);
  }
});

test('开放请求的已完成阶段待验收仍属于总览等待组，验收维度独立保留', () => {
  const task={key:'open',taskId:'one',sessionId:'session',title:'open',executionStatus:'waiting',phaseExecutionStatus:'completed',acceptanceStatus:'pending',startedAt:1,finishedAt:null,lastActivityAt:2,nodeIds:[],projectIds:[],roots:[],projectNames:[],phaseRefs:[],changed:true,actionableInterruption:false} as unknown as TaskIndex;
  assert.equal(taskStage(task.executionStatus,task.acceptanceStatus,task.phaseExecutionStatus),'review');
  assert.deepEqual(filterTaskIndex([task],{stage:'waiting,stalled,finalizing',days:'0'},3),[task]);
  assert.deepEqual(filterTaskIndex([task],{stage:'done,accepted,rejected,review,failed,ended,cancelled,handed_off',days:'0'},3),[]);
  assert.match(acceptanceBadge(task),/结果待验收/);
});

test('验收徽章依据真实阶段结果，不把默认pending或请求关闭当成交付完成', () => {
  for (const executionStatus of ['running','stopping','queued','waiting','idle','unknown','ended','failed','cancelled','handed_off']) {
    for (const requestState of ['active','closed']) {
      const run={executionStatus,acceptanceStatus:'pending',requestState,resultStatus:'completed'};
      assert.equal(acceptanceBadge(run),'',`${executionStatus} / ${requestState} 的默认 pending`);
    }
  }
  for (const phaseExecutionStatus of ['waiting','idle','running','unknown','failed','cancelled']) {
    assert.equal(acceptanceBadge({executionStatus:'waiting',phaseExecutionStatus,acceptanceStatus:'pending'}),'',phaseExecutionStatus);
  }
  for (const executionStatus of ['waiting','running','unknown']) {
    assert.match(acceptanceBadge({executionStatus,phaseExecutionStatus:'completed',acceptanceStatus:'pending'}),/结果待验收/,executionStatus);
  }
  for (const [acceptanceStatus,label] of [['accepted','结果已验收'],['passed','结果已验收'],['rejected','结果已驳回'],['failed','结果已驳回']]) {
    for (const executionStatus of ['running','waiting','unknown']) {
      assert.ok(acceptanceBadge({executionStatus,phaseExecutionStatus:'unknown',acceptanceStatus}).includes(label),`${executionStatus} / ${acceptanceStatus}`);
    }
  }
  for (const [acceptanceStatus,state] of [['pending','review'],['accepted','accepted'],['passed','accepted'],['rejected','rejected'],['failed','rejected']]) {
    const run={executionStatus:'completed',acceptanceStatus};
    assert.equal(taskStage(run.executionStatus,run.acceptanceStatus),state,'旧节点缺少阶段字段时使用执行状态');
    assert.equal(acceptanceBadge(run),'','主状态已表达验收事实时不重复徽章');
  }
});

test('写操作收到成功HTTP但非JSON或无效回执时仍按未知结果处理', async t => {
  const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{setTimeout,clearTimeout}});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/console/'}});
  t.after(()=>{for(const [name,original] of [['window',originalWindow],['location',originalLocation]] as const){if(original)Object.defineProperty(globalThis,name,original);else Reflect.deleteProperty(globalThis,name);}});
  let response='';t.mock.method(globalThis,'fetch',async()=>new Response(response,{status:200}));
  for(const body of ['not-json','null','42','[]']){
    response=body;await assert.rejects(createApi(()=>{}).post('archive/commit',{}),error=>error instanceof ApiError&&(error as ApiError&{effect:string}).effect==='unknown');
  }
});

test('文件分页在刷新时被取消，迟到页不能追加到新版本', async () => {
  const delayed=deferred<unknown>();let signal:AbortSignal|undefined;
  const {resources}=resourceFixture(async(path,value)=>{if(path.includes('?cursor=')){signal=value;return delayed.promise;}return {file:{revision:'new',rows:['fresh']},nextCursor:null};});
  resources.entries.set('runs/r/files/f',{data:{file:{revision:'old',rows:['first']},nextCursor:'one'},time:1,error:null,loading:false});
  const paging=resources.moreFile('runs/r/files/f');await resources.load('runs/r/files/f',true);
  assert.equal(signal?.aborted,true);delayed.resolve({file:{revision:'old',rows:['late']},nextCursor:null});assert.equal(await paging,null);
  assert.deepEqual((resources.data<any>('runs/r/files/f')).file.rows,['fresh']);
});

test('强制读向服务端声明fresh且保持缓存键，普通读和认证读不污染参数', async () => {
  const paths:string[]=[];
  const {resources}=resourceFixture(async path=>{paths.push(path);return {items:[]};});
  await resources.load('projects');await resources.load('projects',true);await resources.load('projects?node=n',true);await resources.load('session',true);
  assert.deepEqual(paths,['projects','projects?fresh=1','projects?node=n&fresh=1','session']);
  assert.ok(resources.entries.has('projects'));assert.equal(resources.entries.has('projects?fresh=1'),false);
});

test('已应答但子控制仍accepted的回执保持待结束和查询入口，ISO时间可显示', () => {
  const receipt={scope:'console:/api/v4/runs/a/control:',requestKey:'one',path:'/api/v4/runs/a/control',state:'completed',effect:'applied',createdAt:'2026-10-22T12:00:00.000Z',finishedAt:null,response:{status:'accepted',results:[{targets:[{status:'accepted'}]}]}} as ActionReceipt;
  assert.equal(receiptLabel(receipt),'请求已接收，执行待结束');assert.equal(canQueryReceipt(receipt),true);
  receipt.response={status:'completed',results:[{receipt:{status:'accepted'}}]};assert.equal(canQueryReceipt(receipt),true);
  receipt.response={status:'completed',results:[{receipt:{status:'completed'}}]};assert.equal(canQueryReceipt(receipt),false);
  assert.equal(timestamp(receipt.createdAt),Date.UTC(2026,9,22,12));assert.notEqual(fullTime(timestamp(receipt.createdAt)),'未上报');
  assert.equal(timestamp(Number.NaN),null);assert.equal(timestamp('not-a-date'),null);assert.equal(timestamp(0),0);
  receipt.path='/api/v4/nodes/n/settings';receipt.response={pending:true};assert.equal(receiptLabel(receipt),'配置已保存，仍待应用');
});
