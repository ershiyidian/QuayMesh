import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbenchFeed } from "../../src/console-workbench/feed.js";
import type { FederationRuntime } from "../../src/federation/runtime.js";
import type { ServerConfig } from "../../src/config.js";

const config = { federation: { nodeId: "cloud" } } as ServerConfig;
const oneNode = [{ id: "desktop", nickname: "Desktop", online: true }];
const payload = (name: string) => ({
  status: 200, body: { projects: [{ name }], roots: [{ id: name }] },
});
function stub(call: (timeoutMs: number) => Promise<unknown>) {
  return { nodes: () => oneNode, request: (_node: string, method: string, args: any, timeoutMs: number) => {
    assert.equal(method, "console");
    assert.equal(args.method, "GET");
    return call(timeoutMs);
  } } as unknown as FederationRuntime;
}

test("Console remote GET budget covers healthy 6–10 second Desktop reads", async () => {
  let observed = 0;
  const feed = new WorkbenchFeed(config,stub(async timeout => {
    observed = timeout;
    return payload("Desktop");
  }));
  const result = await feed.metadata();
  assert.equal(observed,20_000);
  assert.equal(result.complete,true);
  assert.equal(result.projects[0].name,"Desktop");
});

test("TTL refresh returns a timestamped snapshot while one remote refresh replaces it",async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  let requests = 0;
  let release!: (reply: unknown) => void;
  const feed = new WorkbenchFeed(config,stub(async () => {
    requests++;
    if (requests === 1) return payload("old");
    return new Promise(resolve => { release = resolve; });
  }));
  assert.equal((await feed.metadata()).projects[0].name,"old");
  t.mock.timers.tick(13_000);
  const start = performance.now();
  const first = await feed.metadata();
  assert.ok(performance.now()-start < 500,"stale cache must not wait for a blocked remote RPC");
  assert.equal(first.projects[0].name,"old");
  assert.equal(first.sources[0].state,"refreshing");
  assert.equal(first.sources[0].stale,true);
  assert.equal(first.complete,true,"a complete cached snapshot remains usable while refreshing");
  // Give the background job a microtask to begin.
  await delay(10);
  const second = await feed.metadata();
  assert.equal(second.projects[0].name,"old");
  assert.equal(requests,2,"multiple reads must reuse a single pending request");
  release(payload("new"));
  await delay(15);
  const updated = await feed.metadata();
  assert.equal(updated.complete,true);
  assert.equal(updated.projects[0].name,"new");
});

test('a write invalidation waits for a fresh read and an older pending GET cannot repopulate the cache',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  let requests=0;
  const replies:Array<(reply:unknown)=>void>=[];
  const feed=new WorkbenchFeed(config,stub(async()=>{
    requests++;
    return requests===1?payload('before'):new Promise(resolve=>replies.push(resolve));
  }));
  await feed.metadata();t.mock.timers.tick(13_000);
  assert.equal((await feed.metadata()).projects[0].name,'before');
  await delay(1);
  feed.invalidate();
  let settled=false;
  const after=feed.metadata().then(value=>{settled=true;return value;});
  await delay(1);assert.equal(settled,false);
  replies.shift()!(payload('obsolete'));
  await delay(1);assert.equal(settled,false);assert.equal(requests,3);
  replies.shift()!(payload('after'));
  assert.equal((await after).projects[0].name,'after');
  assert.equal((await feed.metadata()).projects[0].name,'after');
});

test("failed remote reads return explicit errors and do not hammer a sleeping node",async () => {
  let requests = 0;
  const feed = new WorkbenchFeed(config,stub(async () => {
    requests++;
    throw Object.assign(new Error("wake network unavailable"),{code:"REQUEST_TIMEOUT"});
  }));
  const first = await feed.metadata();
  assert.equal(first.complete,false);
  assert.equal(first.sources[0].state,"error");
  await feed.metadata();
  assert.equal(requests,1,"a recent failed read must respect retry backoff");
});

test('explicit refresh bypasses a valid TTL and a failed read backoff without discarding saved evidence',async()=>{
  let requests=0,fail=false;
  const feed=new WorkbenchFeed(config,stub(async()=>{
    requests++;if(fail)throw new Error('temporary read failure');return payload('version-'+requests);
  }));
  assert.equal((await feed.metadata()).projects[0].name,'version-1');
  assert.equal((await feed.metadata(true)).projects[0].name,'version-2');
  fail=true;const failed=await feed.metadata(true);assert.equal(failed.projects[0].name,'version-2');assert.equal(failed.sources[0].state,'error');
  fail=false;assert.equal((await feed.metadata()).projects[0].name,'version-2');assert.equal(requests,3);
  assert.equal((await feed.metadata(true)).projects[0].name,'version-4');
});
