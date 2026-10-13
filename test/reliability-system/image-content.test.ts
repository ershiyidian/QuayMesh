import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {writeFile} from "node:fs/promises";
import {deflateSync} from "node:zlib";
import {IMAGE_BYTES,REPLY_BYTES} from "../../src/bounded-reply.js";
import {callOpen,createRealTestServer,structured} from "../session-card/server-fixture.js";

function crc32(data:Buffer):number {
  let value=0xffffffff;
  for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  return (value^0xffffffff)>>>0;
}
function chunk(type:string,bytes:Buffer):Buffer {
  const kind=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([kind,bytes])));
  return Buffer.concat([size,kind,bytes,crc]);
}
function png(width=180,height=180):Buffer {
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const raw=Buffer.alloc(height*(width*4+1));let seed=0x12345678;
  for(let y=0;y<height;y++)for(let x=1;x<=width*4;x++){
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    raw[y*(width*4+1)+x]=seed&255;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a","hex"),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}

test("IM01：超过 48 KiB 的真实 PNG 通过标准 MCP image 返回模型，正文不复制 Base64",{timeout:60000},async t=>{
  const server=await createRealTestServer({git:false});t.after(()=>server.dispose());
  const data=png();assert.ok(data.length>REPLY_BYTES&&data.length<IMAGE_BYTES);
  await writeFile(join(server.project,"normal-screenshot.png"),data);
  const conversation="image-content-budget-test",meta={"openai/session":conversation};
  await server.client.callTool({name:"start_session",arguments:{title:"图像测试",request_key:"image"},_meta:meta});
  const opened=structured(await callOpen(server.client,server.project,conversation));
  const response=await server.client.callTool({name:"read",arguments:{workspace_id:opened.workspace_id,path:"normal-screenshot.png"},_meta:meta});
  assert.notEqual(response.isError,true,JSON.stringify(response.content).slice(0,500));
  const images=response.content.filter((item):item is {type:"image";data:string;mimeType:string}=>item.type==="image");
  assert.equal(images.length,1);
  assert.equal(images[0]!.mimeType,"image/png");
  const rendered=Buffer.from(images[0]!.data,"base64");
  assert.ok(rendered.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")));
  assert.ok(rendered.length>REPLY_BYTES);
  assert.ok(JSON.stringify(response.structuredContent).length<2048);
});
