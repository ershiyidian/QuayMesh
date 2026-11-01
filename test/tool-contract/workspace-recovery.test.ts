import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {twoNodes} from "./fixture.js";

test("public MCP schema and federated tool route support exact-claim recovery release/stop",{timeout:30000},async t=>{
  const {cloud}=await twoNodes(t);
  const listing=await cloud.client.listTools();
  const schema=listing.tools.find(tool=>tool.name==="workspace_context")?.inputSchema;
  assert.deepEqual(schema?.properties?.recovery_action,{type:"string",enum:["inspect","release","stop"]});
  const meta={"openai/session":randomUUID()};
  const call=async(name:string,args:Record<string,unknown>)=>{
    const reply=await cloud.client.callTool({name,arguments:args,_meta:meta});
    assert.notEqual(reply.isError,true,JSON.stringify(reply));
    assert.ok(reply.structuredContent,JSON.stringify(reply));
    return reply.structuredContent as Record<string,any>;
  };
  await call("start_session",{title:"Exact-claim recovery routing",request_key:randomUUID()});
  const opened=await call("open_workspace",{root_id:"worker/main"});
  for(const recovery_action of ["release","stop"]){
    // A missing exact identity exercises the public mutation route safely;
    // no running process or other claim is selected for control.
    const reply=await call("workspace_context",{workspace_id:opened.workspace_id,action:"recovery",
      claim_id:`missing-${randomUUID()}`,recovery_action});
    assert.equal(reply.node_id,"worker");
    assert.equal(reply.recovery_action,recovery_action);
    assert.equal(reply.resource_recovery.state,"not_found");
  }
});
