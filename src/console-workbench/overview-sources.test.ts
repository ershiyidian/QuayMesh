import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewSourceStates } from './feed.js';
import type { SourceState } from './types.js';

function ready(nodeId: string, observedAt: number): SourceState {
  return {nodeId,name:nodeId,online:true,observedAt,state:'ready',stale:false,error:null};
}

test('a failed usage read does not make valid Task observations stale', () => {
  const input={
    tasks:[ready('home',1000),ready('school',1000)],
    titles:[ready('home',990),ready('school',995)],
    details:[ready('school',980)],
    usage:[{...ready('home',100),state:'error' as const,stale:true,error:'usage unavailable'}],
  };
  const before=structuredClone(input);
  const result=overviewSourceStates(input);
  assert.deepEqual(result.taskSources,[ready('home',990),ready('school',980)]);
  assert.equal(result.usageSources[0]!.state,'error');
  assert.equal(result.sources.find(source=>source.nodeId==='home')?.state,'error','legacy clients retain combined observations');
  assert.deepEqual(input,before);
});

test('actual Task-source failures remain visible when usage succeeds', () => {
  const result=overviewSourceStates({
    tasks:[{...ready('school',100),state:'offline',online:false,stale:true,error:'offline'}],
    titles:[ready('school',1000)],details:[],usage:[ready('school',1000)],
  });
  assert.equal(result.taskSources[0]!.state,'offline');
  assert.equal(result.taskSources[0]!.online,false);
  assert.equal(result.taskSources[0]!.stale,true);
  assert.equal(result.usageSources[0]!.state,'ready');
});
