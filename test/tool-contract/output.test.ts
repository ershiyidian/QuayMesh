import assert from "node:assert/strict";
import test from "node:test";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {fixture,until} from "./fixture.js";
import {REPLY_BYTES} from "../../src/bounded-reply.js";

test("BT13/14/RC01：真实输出预算生效，错误码和余下文本完整保留",{timeout:60000},async t=>{
  const f=await fixture(t),text="中文😀:0123456789\n".repeat(2000);
  const command=await f.execute(`process.stdout.write(${JSON.stringify(text)});process.exitCode=7;`,{max_output_tokens:8,yield_time_ms:2000});
  assert.ok(Buffer.byteLength(command.result)<=32);assert.equal(command.exit_code,7);assert.equal(command.running,false);
  assert.equal(command.output_done,false);assert.ok(command.next_cursor>0);
  assert.equal(command.result,text.slice(0,command.result.length));
  let result=command.result,cursor=command.next_cursor;
  for(let index=0;index<20;index++) {
    const page=await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor,limit_bytes:16384});
    result+=page.result;cursor=page.next_cursor;if(page.done)break;
  }
  assert.equal(result,text);assert.equal(cursor,Buffer.byteLength(text));
  const replay=await f.call("write_stdin",{...f.scope,session_id:command.session_id,cursor:0,chars:"",yield_time_ms:0,max_output_tokens:8});
  assert.equal(replay.result,command.result);assert.equal(replay.exit_code,7);
});

test("BT11/15/PR12/13/RC04：三个独立命令批量读取与整体等待，取消不影响其他进程",{timeout:60000},async t=>{
  const f=await fixture(t,{files:{"a/.keep":"","b/.keep":"","c/.keep":""}});
  const gate=join(f.root,"release"),commands=[];
  for(const [index,scope] of ["a","b","c"].entries()) {
    commands.push(await f.execute(`import {existsSync} from 'node:fs';const t=setInterval(()=>{
      if(existsSync(${JSON.stringify(gate)})){clearInterval(t);process.stdout.write('worker-${index}:'+('x'.repeat(5000)));}},20);`,
      {working_directory:scope,execution_scope:scope,yield_time_ms:0}));
  }
  const inputs=commands.map(command=>({operation_id:command.operation_id,cursor:0}));
  const start=performance.now();
  const empty=await f.call("read_output",{...f.scope,outputs:inputs,wait_ms:200,limit_bytes:1024});
  const elapsed=performance.now()-start;
  assert.ok(elapsed>=150&&elapsed<1500,`整体等待 ${elapsed}ms`);assert.equal(empty.outputs.length,3);
  assert.ok(empty.outputs.every((page:any)=>page.process_done===false&&page.result===""));
  const pending=f.call("read_output",{...f.scope,outputs:inputs,wait_ms:5000,limit_bytes:1024});
  await delay(150);await writeFile(gate,"release");
  const batch=await pending;assert.ok(batch.outputs.some((page:any)=>page.result.length>0));
  assert.ok(batch.outputs.reduce((n:number,p:any)=>n+Buffer.byteLength(p.result),0)<=1024);
  for(let index=0;index<3;index++) {
    const page=batch.outputs[index];assert.equal(page.operation_id,commands[index].operation_id);
    await until(async()=>(await f.call("read_output",{...f.scope,operation_id:page.operation_id,cursor:0})).process_done);
    const repeated=await f.call("read_output",{...f.scope,operation_id:page.operation_id,cursor:0,limit_bytes:100});
    assert.ok(repeated.result.startsWith(`worker-${index}:`));
  }
});

test("TC09/RC06：相同key的非空stdin只发送一次",{timeout:60000},async t=>{
  const f=await fixture(t);
  const command=await f.execute("import {appendFileSync} from 'node:fs';process.stdin.on('data',data=>{appendFileSync('received.txt',data);console.log('accepted');});",{yield_time_ms:0});
  const input={...f.scope,operation_id:command.operation_id,chars:"one\n",operation_key:"one-input",yield_time_ms:0};
  const first=await f.call("write_stdin",input);const repeated=await f.call("write_stdin",input);
  assert.equal(first.operation_id,repeated.operation_id);assert.equal(first.accepted,true);
  await until(async()=>{const page=await f.call("read_output",{...f.scope,operation_id:command.operation_id,cursor:0});return page.result.includes("accepted");});
  assert.equal(await readFile(join(f.project,"received.txt"),"utf8"),"one\n");
  await f.call("cancel_command",{...f.scope,operation_id:command.operation_id});
});

test("BT12/16：一个结果范围过期不会遮蔽其他输出",{timeout:60000},async t=>{
  const f=await fixture(t);
  const large=await f.execute("process.stdout.write('x'.repeat(4*1024*1024+1024));",{yield_time_ms:2000});
  assert.equal(large.output_truncated,true);assert.ok(large.retained_from>0);
  const small=await f.execute("console.log('small-result');",{yield_time_ms:2000});
  const response=await f.raw("read_output",{...f.scope,outputs:[{operation_id:large.operation_id,cursor:0},{operation_id:small.operation_id,cursor:0}],limit_bytes:32768});
  assert.ok(Buffer.byteLength(JSON.stringify(response))<=REPLY_BYTES);
  const result=response.structuredContent as any;
  assert.equal(result.partial,true);assert.match(result.outputs[0].error,/OUTPUT_RANGE_EXPIRED/);
  assert.equal(result.outputs[1].result,"small-result\n");
});
