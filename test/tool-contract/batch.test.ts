import assert from "node:assert/strict";
import test from "node:test";
import {writeFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {fixture} from "./fixture.js";
import {REPLY_BYTES} from "../../src/bounded-reply.js";

test("BT01/02/03/08：限定选区批量读取、重复文件索引、局部失败与起点越界", {timeout:60000}, async t=>{
  const text=Array.from({length:120},(_,i)=>`第${i+1}行\n`).join("");
  const files=Object.fromEntries(Array.from({length:20},(_,i)=>[`f${i}.txt`,text]));
  const f=await fixture(t,{files});
  const ranges=await f.call("workspace_context",{...f.scope,action:"capture",files:[
    {path:"f0.txt",start_line:20,max_lines:8},{path:"f1.txt",max_lines:8},{path:"f0.txt",start_line:40,max_lines:8}]});
  assert.equal(ranges.entries.length,3);assert.equal(ranges.complete,true);assert.equal(ranges.next_cursor,null);
  assert.deepEqual(ranges.entries.map((e:any)=>[e.selection_index,e.lines.length,e.lines[0].line]),[[0,8,20],[1,8,1],[2,8,40]]);
  assert.equal(ranges.bytesRead,Buffer.byteLength(text)*2);
  const all=await f.call("workspace_context",{...f.scope,action:"capture",files:Object.keys(files).map(path=>({path,max_lines:1}))});
  assert.equal(all.entries.length,20);assert.equal(all.complete,true);
  const partial=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"missing"},{path:"f1.txt",start_line:500},{path:"f2.txt",max_lines:1}]});
  assert.equal(partial.partial,true);assert.ok(partial.entries[0].error);assert.equal(partial.entries[0].selection_index,0);
  assert.equal(partial.entries[1].lines.length,0);assert.equal(partial.entries[1].totalLines,120);assert.equal(partial.entries[2].lines.length,1);
});

test("BT04/05/06/07：字节分页重建中文和CRLF，旧快照不重读源文件",{timeout:60000},async t=>{
  const long="头部\r\n"+"中文😀".repeat(18000)+"\r\n结尾\n";
  const f=await fixture(t,{files:{"long.txt":long,"small.txt":"第二文件\n"}});
  let page=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"long.txt",max_lines:3},{path:"small.txt"}]});
  const ref=page.result_ref;assert.ok(page.next_cursor);
  await writeFile(join(f.project,"long.txt"),"新版\n");
  const fresh=await f.call("workspace_context",{...f.scope,action:"capture",files:[{path:"long.txt"}]});
  assert.equal(fresh.entries[0].lines[0].text,"新版");
  await rm(join(f.project,"long.txt"));
  const pieces=new Map<number,string>();let calls=0;
  while(true) {
    assert.ok(Buffer.byteLength(JSON.stringify(page))<REPLY_BYTES);
    for(const entry of page.entries)for(const line of entry.lines)pieces.set(entry.selection_index,(pieces.get(entry.selection_index)??"")+line.text+line.eol);
    if(page.complete)break;
    assert.ok(++calls<30);page=await f.call("workspace_context",{...f.scope,action:"capture",result_ref:ref,cursor:page.next_cursor});
  }
  assert.equal(pieces.get(0),long);assert.equal(pieces.get(1),"第二文件\n");
});

test("BT09/10/TC05：多查询行去重、目录枚举续读和具体对象schema",{timeout:60000},async t=>{
  const f=await fixture(t,{files:{"src/a.ts":"alpha\nbeta\nalpha beta\n","src/b.ts":"beta\n","src/c.ts":"alpha\n"}});
  const listing=await f.client.listTools();
  for(const name of ["workspace_context","copy_artifact"]) {
    const tool=listing.tools.find(tool=>tool.name===name);
    if(name==="copy_artifact"&&!tool)continue;
    assert.equal(tool?.inputSchema.type,"object");assert.ok(tool.inputSchema.properties?.action);
  }
  const page=await f.call("workspace_context",{...f.scope,action:"search",directory:"src",patterns:["*.ts"],queries:["alpha","beta"],context_lines:1,max_files:1});
  assert.equal(page.entries.length,1);assert.equal(page.scope.next_file_offset,1);
  assert.deepEqual(page.entries[0].lines.map((line:any)=>[line.line,line.matches]),[[1,[0]],[2,[1]],[3,[0,1]]]);
  await writeFile(join(f.project,"src","aa.ts"),"late-added\n");
  const next=await f.call("workspace_context",{...f.scope,action:"search",result_ref:page.result_ref,file_offset:1});
  assert.equal(next.entries[0].path,"src/b.ts");assert.equal(next.scope.total_files,3);
  const invalid=await f.raw("workspace_context",{...f.scope,action:"capture",query:"invalid",files:[{path:"src/a.ts"}]});
  assert.equal(invalid.isError,true);
});
