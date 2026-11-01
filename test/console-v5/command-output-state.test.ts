import test from 'node:test';
import assert from 'node:assert/strict';
import {CommandOutputs,commandOutputNotice,commandOutputNeedsRetry,type CommandOutputPage} from '../../src/ui/console-v5/command-output.js';

const page=(value:Partial<CommandOutputPage>):CommandOutputPage=>({chunk:'',cursor:0,done:false,hasMore:false,
  totalBytes:0,truncated:false,retainedFrom:0,outputState:'writing',errorCode:null,...value});

test('incomplete output keeps saved bytes, stops automatic polling and clears its notice only on confirmed recovery',async()=>{
  let reads=0;
  const outputs=new CommandOutputs(async()=>++reads===1?page({chunk:'saved',cursor:5,totalBytes:5,outputState:'incomplete',errorCode:'output_tail_missing'})
    :page({chunk:' restored',cursor:14,totalBytes:14,done:true,outputState:'ready'}),()=>{});
  const path='runs/task/commands/command',visible=new Set([path]);
  await outputs.load(path,visible);
  const entry=outputs.entries.get(path)!;
  assert.equal(entry.text,'saved');assert.equal(entry.done,false);
  assert.match(commandOutputNotice(entry),/记录不完整/);
  assert.equal(commandOutputNeedsRetry(entry),true);
  assert.doesNotMatch(commandOutputNotice(entry),/output_tail_missing/);
  await outputs.load(path,visible);assert.equal(reads,1);
  await outputs.load(path,visible,true);
  assert.equal(entry.text,'saved restored');assert.equal(entry.done,true);
  assert.equal(commandOutputNotice(entry),'');assert.equal(entry.errorCode,null);
  assert.equal(commandOutputNeedsRetry(entry),false);
});

test('a partial UTF-8 streaming page can wait at the same cursor without claiming more readable data or failing',async()=>{
  let reads=0;
  const outputs=new CommandOutputs(async()=>++reads===1?page({totalBytes:2})
    :page({chunk:'你',cursor:3,totalBytes:3,done:true,outputState:'ready'}),()=>{});
  const path='runs/task/commands/command',visible=new Set([path]);
  await outputs.load(path,visible);
  const entry=outputs.entries.get(path)!;
  assert.equal(entry.error,null);assert.equal(entry.cursor,0);assert.equal(entry.done,false);
  await outputs.load(path,visible,true);
  assert.equal(entry.text,'你');assert.equal(entry.cursor,3);assert.equal(entry.error,null);
});

test('bad progress and expired output never erase already read text or display a confirmed empty result',async()=>{
  const responses=[page({chunk:'kept',cursor:4,totalBytes:4}),page({cursor:4,totalBytes:8,hasMore:true}),
    page({cursor:4,totalBytes:4,outputState:'expired'})];
  const outputs=new CommandOutputs(async()=>responses.shift()!,()=>{});
  const path='runs/task/commands/command',visible=new Set([path]);
  await outputs.load(path,visible);await outputs.load(path,visible,true);
  const entry=outputs.entries.get(path)!;
  assert.equal(entry.text,'kept');assert.match(entry.error!,/游标无效/);
  assert.equal(commandOutputNeedsRetry(entry),true);
  await outputs.load(path,visible);assert.equal(responses.length,1);
  await outputs.load(path,visible,true);
  assert.equal(entry.text,'kept');assert.equal(entry.error,null);
  assert.match(commandOutputNotice(entry),/已过保留期/);
});
