import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFailureMessage,readWarningMessage} from '../../src/ui/console-v5/read-state.js';
import {sourceNeedsAttention,sourceWarning,resourceHealth} from '../../src/ui/console-v5/source-state.js';
import type {SourceState} from '../../src/ui/console-v5/contracts.js';

test('读取错误说明用户影响，内部请求路径不进入正常页面',()=>{
  const timeout=Object.assign(new Error('请求 /internal/quaymesh/console 超时'),{code:'timeout',status:504});
  assert.match(readFailureMessage(timeout),/读取用时较长/);
  assert.doesNotMatch(readFailureMessage(timeout),/\/internal\/|quaymesh\/console/);
  assert.match(readWarningMessage(timeout.message),/读取用时较长/);
  assert.match(readFailureMessage(Object.assign(new Error('opaque'),{status:403})),/无权/);
  assert.equal(readWarningMessage('改动证据尚在采集，请稍后刷新。'),'改动证据尚在采集，请稍后刷新。');
});

test('旧快照与后台刷新为中性待更新，真实失败仍需关注',()=>{
  const now=Date.now(),source:SourceState={nodeId:'n1',name:'Node',online:true,state:'ready',stale:true,observedAt:now-60_000,error:null};
  assert.equal(sourceNeedsAttention(source,now),false);
  assert.match(sourceWarning(source,now)!,/状态待更新/);
  assert.doesNotMatch(sourceWarning(source,now)!,/正在刷新/);
  assert.equal(resourceHealth([{data:{sources:[source]},time:now,error:null,loading:false}]).tone,'muted');
  assert.equal(sourceNeedsAttention({...source,state:'refreshing'},now),false);
  assert.equal(sourceNeedsAttention({...source,state:'refreshing',stale:false,observedAt:now-1000},now),false);
  assert.equal(sourceNeedsAttention({...source,error:'request timeout'},now),true);
  assert.equal(sourceNeedsAttention({...source,state:'offline'},now),true);
});
