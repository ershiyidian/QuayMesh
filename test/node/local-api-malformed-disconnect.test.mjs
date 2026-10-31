import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {stripTypeScriptTypes} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";

test("malformed local IPC followed by immediate disconnect cannot terminate Core", {skip:process.platform==="win32"}, async () => {
  const directory=await mkdtemp(join(tmpdir(),"qm-malformed-close-test-"));
  try {
    await writeFile(join(directory,"package.json"),'{"type":"module"}\n');
    for(const name of ["ipc","protocol"]){
      const source=await readFile(new URL("../../src/local-user-api/"+name+".ts",import.meta.url),"utf8");
      await writeFile(join(directory,name+".js"),stripTypeScriptTypes(source,{mode:"transform"}));
    }
    const child=join(directory,"child.mjs");
    await writeFile(child,String.raw`
import {mkdir,rm} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createConnection} from "node:net";
import {startLocalUnixApi} from "./ipc.js";
const directory=join(dirname(fileURLToPath(import.meta.url)),"private-config");
await mkdir(directory,{mode:0o700});
let api;
try{
  api=await startLocalUnixApi({configDir:directory,nodeId:"fixture",sessions:{close(){},async run(){throw new Error("Malformed input reached dispatch");}}});
  for(let round=0;round<3;round++)await Promise.all(Array.from({length:8},()=>new Promise(resolve=>{
    const socket=createConnection({path:api.endpoint});socket.on("error",()=>{});socket.once("close",resolve);
    socket.once("connect",()=>socket.write("{\n",()=>socket.destroy()));
  })));
  await new Promise(resolve=>setTimeout(resolve,60));
  console.log(JSON.stringify({survived:true,connections:24}));
}finally{await api?.close();await rm(directory,{recursive:true,force:true});}
`);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!/^QUAYMESH_/i.test(key)&&!/^(NODE_OPTIONS|NODE_PATH)$/i.test(key)));
    // No unhandledRejection handler is installed. A rejected error-write must
    // fail this isolated process exactly as it would fail the real Core.
    const result=spawnSync(process.execPath,["--unhandled-rejections=strict",child],{env,encoding:"utf8",timeout:10000,maxBuffer:16384,windowsHide:true});
    assert.equal(result.error,undefined,"isolated IPC process must execute");
    assert.equal(result.signal,null,"isolated IPC process must finish without timeout");
    assert.equal(result.status,0,"malformed input/disconnect must not produce an uncaught rejection: "+result.stderr.slice(0,300));
    assert.deepEqual(JSON.parse(result.stdout.trim()),{survived:true,connections:24});
  } finally {await rm(directory,{recursive:true,force:true});}
});
