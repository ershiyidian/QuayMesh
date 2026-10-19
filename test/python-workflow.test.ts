import assert from "node:assert/strict";
import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,writeFile,readFile,rm,stat} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {inspectPython} from "../src/workspace-environment.js";
import {fixture,until} from "./tool-contract/fixture.js";

const execute=promisify(execFile),scripts=resolve("scripts/analysis");
const times=["--from","2026-10-05T00:00:00+00:00","--to","2026-10-06T00:00:00Z"];
const json=(path:string)=>readFile(path,"utf8").then(JSON.parse);

test("PY01/04/06/08：真实Python处理中文路径、缺失字段与错误位置",{timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-python-中文 "));t.after(()=>rm(root,{recursive:true,force:true}));
  const python=await inspectPython(root);assert.equal(python.available,true);
  if(!("executable" in python))throw new Error("PYTHON_UNAVAILABLE");
  const input=join(root,"事件记录.jsonl"),output=join(root,"汇总.json");
  const records=[
    {ts:"2026-10-05T08:00:00+08:00",event:"mcp_exchange_finished",tool:"read",source:"model",durationMs:10,responseBytes:20,httpStatus:200},
    {ts:"2026-10-05T00:01:00Z",event:"mcp_exchange_finished",tool:"other",durationMs:30,responseBytes:40,httpStatus:503},
    {event:"timestamp-missing",tool:"read"},
  ];
  await writeFile(input,records.map(row=>JSON.stringify(row)).join("\n")+"\n");
  const result=await execute(python.executable,[join(scripts,"summarize-quaymesh-log.py"),"--input",input,...times,"--output",output],{encoding:"utf8",timeout:30000});
  const report=await json(output);
  assert.equal(report.counts.matched,2);assert.equal(report.counts.missing_timestamp,1);
  assert.equal(report.response_bytes.sum,60);assert.equal(report.duration_ms.mean,20);
  assert.equal(report.sources["(missing)"],1);assert.equal(report.errors.http_503,1);
  assert.equal(report.sources.app,undefined);assert.equal(report.host_received,undefined);
  assert.ok(Buffer.byteLength(result.stdout)<1024);assert.equal((await json(join(root,"汇总.progress.json"))).phase,"completed");
  await writeFile(input,"{broken JSON\n");
  await assert.rejects(execute(python.executable,[join(scripts,"summarize-quaymesh-log.py"),"--input",input,...times,"--output",output],{encoding:"utf8"}),
    (error:any)=>error.code!==0&&error.stderr.includes("事件记录.jsonl:1"));
  assert.equal((await json(join(root,"汇总.progress.json"))).phase,"failed");
});

test("PY04/06：报告指标显式选择、分组与缺失计数，布尔值拒绝冒充数值",{timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"qm-reports-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const python=await inspectPython(root);if(!("executable" in python))throw new Error("PYTHON_UNAVAILABLE");
  const a=join(root,"a.json"),b=join(root,"b.json"),output=join(root,"combined.json");
  await writeFile(a,JSON.stringify({records:[{group:"a",score:2},{group:"a",score:4}]}));
  await writeFile(b,JSON.stringify([{group:"b",score:8},{group:"b"}]));
  const args=[join(scripts,"aggregate-json-reports.py"),"--input",a,b,"--metrics","score","--group-by","group","--output",output];
  await execute(python.executable,args,{encoding:"utf8"});
  const report=await json(output);assert.equal(report.records,4);assert.equal(report.metrics.score.count,3);
  assert.equal(report.metrics.score.missing,1);assert.equal(report.metrics.score.sum,14);assert.equal(report.groups.length,2);
  await writeFile(b,JSON.stringify([{group:"b",score:true}]));
  await assert.rejects(execute(python.executable,args,{encoding:"utf8"}),(error:any)=>error.stderr.includes("records[0]:score"));
  assert.equal((await json(join(root,"combined.progress.json"))).phase,"failed");
});

test("PY03：缺失解释器明确报告，显式解释器错误不切换",{timeout:60000},async()=>{
  const absent=await inspectPython(tmpdir(),undefined,{PATH:"",PATHEXT:".EXE"});
  assert.equal(absent.available,false);assert.ok("error" in absent);
  await assert.rejects(inspectPython(tmpdir(),join(tmpdir(),"nonexistent-python-123.exe")),/PYTHON_UNAVAILABLE/);
});

test("PY05/07/09：流式分析与实际MCP脚本重试，报告只执行一次",{timeout:60000},async t=>{
  const f=await fixture(t);
  const env=await f.call("workspace_context",{...f.scope,action:"status",environment:true});
  assert.equal(env.python.verification,"not_run");assert.ok(env.python.candidates.includes(env.python.executable));
  assert.ok(env.python.executable);assert.equal(env.cwd,f.project);assert.ok(env.shell);
  const input=join(f.project,"large.jsonl"),output=join(f.project,"report.json");
  const line=JSON.stringify({ts:"2026-10-05T00:00:00Z",event:"sample",tool:"read",durationMs:2,responseBytes:6});
  await writeFile(input,(line+"\n").repeat(30000));
  const args={...f.scope,cmd:`"${env.python.executable}" "${env.analysis_scripts.logs}" --input "${input}" ${times.join(" ")} --output "${output}"`,
    yield_time_ms:0,operation_key:"python-report-once"};
  const operation=await f.call("exec_command",args);assert.equal(operation.running,true);
  await until(async()=>(await f.call("read_output",{...f.scope,operation_id:operation.operation_id})).process_done,30000);
  const before=await stat(output),replayed=await f.call("exec_command",args);
  assert.equal(replayed.operation_id,operation.operation_id);assert.equal((await stat(output)).mtimeMs,before.mtimeMs);
  assert.equal((await json(output)).counts.matched,30000);
  const stdout=await f.call("read_output",{...f.scope,operation_id:operation.operation_id});
  assert.ok(Buffer.byteLength(stdout.result)<2048);assert.equal(stdout.exit_code,0);
});
