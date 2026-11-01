import test from 'node:test';
import assert from 'node:assert/strict';
import {Resources} from '../../src/ui/console-v5/resources.js';
import {retainDetail,retainedDetailView,pendingDetailRead,detailRecordsComplete} from '../../src/ui/console-v5/retained-detail.js';
import type {RunDetail,CacheEntry} from '../../src/ui/console-v5/contracts.js';
import type {createApi} from '../../src/ui/console-v5/client.js';

const fixture=(complete:boolean):RunDetail=>({run:{id:'task',revision:1,workspaceRevision:1,
  actions:{review:complete,complete,revert:complete,patch:complete}},complete,summary:'Current summary',
  files:[],commands:[],agents:[],evidence:[],timeline:[],instructions:[],skills:[],sources:[],missingPhases:[],warnings:[]}) as unknown as RunDetail;

test('historical evidence never replaces current Task state, sources or action gates',()=>{
  const previous=fixture(true),next=fixture(false);
  previous.commands=[{id:'saved',command:'previous command',status:'running'}] as RunDetail['commands'];
  const saved=retainDetail(previous,next,1000),view=retainedDetailView(next,saved);
  assert.equal(view.detail.commands[0]?.command,'previous command');
  assert.equal(view.detail.run,next.run);
  assert.equal(view.detail.complete,false);
  assert.equal(view.detail.sources,next.sources);
  assert.equal(view.detail.run.actions.complete,false);
  assert.deepEqual(view.historical,['commands']);assert.equal(view.time,1000);
  assert.deepEqual(next.commands,[],'the new response stays unmodified');
  assert.equal(retainDetail(previous,{...next,run:{...next.run,id:'another-task'}},1000,saved),undefined);
  assert.equal(retainDetail(next,fixture(true),2000,saved),undefined);
  assert.equal(pendingDetailRead({...next,missingPhases:[{pending:true}]}),true);
  assert.equal(pendingDetailRead({...next,missingPhases:[{error:'保存的历史记录缺失'}]}),false);
  assert.equal(pendingDetailRead(fixture(true)),false);
});

test('partial success after invalidation retains the actual older read time and a later complete response clears it',async()=>{
  const previous=fixture(true),partial=fixture(false),complete=fixture(true);
  previous.commands=[{id:'saved',command:'previous command',status:'running'}] as RunDetail['commands'];
  const responses=[previous,partial,complete];
  const api={get:async()=>responses.shift()} as unknown as ReturnType<typeof createApi>;
  const resources=new Resources(api,{freshness:()=>0,paint:()=>{},loaded:()=>{}}),path='runs/task';
  await resources.load(path);
  const time=resources.entries.get(path)!.time;
  resources.invalidate();assert.equal(resources.entries.get(path)!.time,0);
  await resources.load(path,true);
  const entry=resources.entries.get(path) as CacheEntry<RunDetail>;
  assert.equal(entry.retained?.time,time);
  assert.deepEqual(entry.data?.commands,[]);
  assert.equal(entry.retained?.data.commands[0]?.command,'previous command');
  assert.equal(retainedDetailView(entry.data!,entry.retained).time,time);
  await resources.load(path,true);
  assert.equal(resources.entries.get(path)!.retained,undefined);
  resources.entries.clear();assert.equal(resources.data(path),undefined);
});

test('completed phase pages do not become pending history or accumulate full detail across navigation',async()=>{
  const page=(offset:number):RunDetail=>({...fixture(false),taskComplete:true,
    phasePage:{references:['phase-'+offset],offset,limit:1,total:200,previousCursor:offset?'before-'+offset:null,
      nextCursor:offset<199?'after-'+offset:null,complete:true}});
  const api={get:async(path:string)=>page(Number(new URLSearchParams(path.split('?')[1]).get('phaseCursor')??0))} as unknown as ReturnType<typeof createApi>;
  const resources=new Resources(api,{freshness:()=>0,paint(){},loaded(){}});
  for(let offset=0;offset<200;offset++){
    const path='runs/task'+(offset?'?phaseCursor='+offset:'');
    await resources.load(path);
    assert.equal(resources.entries.size,1,'each Task keeps only its selected page body');
    const detail=resources.data<RunDetail>(path)!;
    assert.equal(detailRecordsComplete(detail),true);assert.equal(detail.complete,false);
    assert.equal(pendingDetailRead(detail),false);assert.equal(detail.run.actions.complete,false);
    assert.equal(retainDetail(page(0),detail,1000),undefined,'a complete page must not inherit another page as stale evidence');
  }
  const unknown={...page(0),taskComplete:false,phasePage:{...page(0).phasePage!,references:[],total:0,complete:false}};
  assert.equal(detailRecordsComplete(unknown),false,'missing owner data is not an empty confirmed page');
});
