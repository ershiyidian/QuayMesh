import assert from "node:assert/strict";
import test from "node:test";
import { writeFile,readFile,mkdir,access } from "node:fs/promises";
import { join,dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRealTestServer,callOpen,structured } from "./server-fixture.js";
import { openDatabase } from "../../src/db/client.js";

const execFileAsync=promisify(execFile);
test("真实指标监控通过固定执行配置运行，源码读取、补丁和测试继续工作",{timeout:60000},async t=>{
  let gate="";
  const server=await createRealTestServer({git:false,configure:async config=>{
    const script=join(dirname(config.stateDir),"metrics.mjs");gate=join(dirname(config.stateDir),"stop-metrics");
    await writeFile(script,`import {totalmem,freemem,hostname} from 'node:os';\nimport {existsSync,writeFileSync} from 'node:fs';\nimport {join} from 'node:path';\nconst sample=()=>writeFileSync(join(process.argv[2],'metrics.json'),JSON.stringify({hostname:hostname(),total:totalmem(),free:freemem(),time:Date.now()}));\nsample();const timer=setInterval(()=>{sample();if(existsSync(process.argv[3])){clearInterval(timer);console.log('metrics complete');}},30);\n`);
    return {...config,commandProfiles:{metrics:{description:"采集系统内存指标",executable:process.execPath,args:[script,"${output}",gate],reads:[script],writes:[],resources:[]}}};
  }});
  t.after(async()=>{await writeFile(gate,"stop");await server.dispose();});
  const code=join(server.project,"code");await mkdir(code);await execFileAsync("git",["init",code]);
  const opened=structured(await callOpen(server.client,server.project));
  t.diagnostic("已打开工作区，启动真实指标进程");
  const started=structured(await server.client.callTool({name:"exec_command",arguments:{workspace_id:opened.workspace_id,profile:"metrics",yield_time_ms:20}}));
  assert.equal(started.running,true);
  t.diagnostic("指标进程已返回持续执行身份");
  const metrics=join(server.config.stateDir,"command-output",started.operation_id,"metrics.json");
  let observed=false;
  for(let attempt=0;attempt<400;attempt++){
    observed=await access(metrics).then(()=>true,()=>false);if(observed)break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(observed,true);
  t.diagnostic("指标输出文件已经存在");
  const sample=JSON.parse(await readFile(metrics,"utf8"));assert.ok(sample.total>0);assert.equal(typeof sample.hostname,"string");
  const reading=await server.client.callTool({name:"read",arguments:{workspace_id:opened.workspace_id,path:"README.md"}});
  assert.notEqual(reading.isError,true,JSON.stringify(reading.content));
  t.diagnostic("监控期间源码读取通过");
  const patch="*** Begin Patch\n*** Add File: code/value.txt\n+one\n*** End Patch";
  const changed=await server.client.callTool({name:"apply_patch",arguments:{workspace_id:opened.workspace_id,patch,expected_content:{"code/value.txt":null}}});
  assert.notEqual(changed.isError,true,JSON.stringify(changed.content));
  t.diagnostic("监控期间补丁写入通过");
  const stale=await server.client.callTool({name:"apply_patch",arguments:{workspace_id:opened.workspace_id,
    patch:"*** Begin Patch\n*** Update File: code/value.txt\n@@\n-one\n+two\n*** End Patch",expected_content:{"code/value.txt":"outdated\n"}}});
  if(stale.isError) {
    assert.match(JSON.stringify(stale.content),/FILE_CONTENT_CHANGED/);
  } else {
    // Modern QuayMesh may return an accepted receipt before the comparison
    // finishes. Inspect the original operation instead of retrying the edit.
    const receipt=structured(stale);
    assert.equal(receipt.accepted,true,JSON.stringify(receipt));
    let finalStatus:Record<string,any>|undefined;
    for(let attempt=0;attempt<300;attempt++){
      const reply=await server.client.callTool({name:"workspace_context",arguments:{
        workspace_id:opened.workspace_id,action:"status",operation_id:receipt.operation_id}});
      assert.notEqual(reply.isError,true,JSON.stringify(reply.content));
      const status=structured(reply);
      if(["failed","succeeded","cancelled"].includes(status.operation_state)){finalStatus=status;break;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(finalStatus,"受理后的补丁操作必须生成最终状态");
    assert.equal(finalStatus.operation_state,"failed");
    assert.match(JSON.stringify(finalStatus),/FILE_CONTENT_CHANGED/);
  }
  t.diagnostic("过期内容修改已经拒绝");
  assert.equal(await readFile(join(code,"value.txt"),"utf8"),"one\n");
  const script=join(code,"read.mjs");await writeFile(script,"import {readFileSync} from 'node:fs'; console.log(readFileSync(new URL('./value.txt',import.meta.url),'utf8'));\n");
  const unscoped=await server.client.callTool({name:"exec_command",arguments:{workspace_id:opened.workspace_id,
    cmd:`"${process.execPath}" "${script}"`,yield_time_ms:1000}});
  assert.notEqual(unscoped.isError,true,JSON.stringify(unscoped.content));
  async function commandResult(receipt:ReturnType<typeof structured>):Promise<{result:string;exit_code:number|null}> {
    const handle=receipt.operation_id;
    assert.ok(handle,"受管命令必须返回稳定 operation_id");
    for(let attempt=0;attempt<300;attempt++){
      const reply=await server.client.callTool({name:"read_output",arguments:{workspace_id:opened.workspace_id,operation_id:handle,wait_ms:100}});
      assert.notEqual(reply.isError,true,JSON.stringify(reply.content));
      const output=structured(reply);
      if(output.process_done) return output as {result:string;exit_code:number|null};
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error("真实命令未在预算内结束");
  }
  const unscopedOutput=await commandResult(structured(unscoped));
  assert.match(unscopedOutput.result,/one/);
  assert.equal(unscopedOutput.exit_code,0);
  t.diagnostic("聚合目录无需手工指定执行范围，保守占用父目录后命令正常运行");
  const result=structured(await server.client.callTool({name:"exec_command",arguments:{workspace_id:opened.workspace_id,
    cmd:`"${process.execPath}" "${script}"`,execution_scope:"code",yield_time_ms:1000}}));
  const scopedOutput=await commandResult(result);
  assert.match(scopedOutput.result,/one/);
  assert.equal(scopedOutput.exit_code,0);
  t.diagnostic("仍可显式指定子项目范围，让其他项目并发执行");
  const db=openDatabase(server.config.stateDir);
  try {
    const claim=db.sqlite.prepare("SELECT operation_id,scopes_json FROM execution_claims WHERE operation_id=?").get(started.operation_id) as {operation_id:string;scopes_json:string};
    assert.ok(claim);assert.ok(JSON.parse(claim.scopes_json).every((scope:{path?:string})=>scope.path!==server.project));
  } finally {db.close();}
  await writeFile(gate,"stop");
  let finished=started;
  const monitor=await commandResult(started);
  assert.equal(monitor.exit_code,0);
  t.diagnostic("监控原操作已正常结束");
});
