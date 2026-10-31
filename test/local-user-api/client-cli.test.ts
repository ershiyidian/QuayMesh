import test from "node:test";
import assert from "node:assert/strict";
import {createServer,type Socket} from "node:net";
import {chmod,mkdtemp,readdir,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable,Writable} from "node:stream";
import {LocalUserClient,LocalUserClientError,validLocalEndpoint} from "../../src/local-user-api/client.js";
import {createPlatformCredentialVault,importLocalUserEnrollment,localCredentialTarget,localUserConfigDirectory,readLocalUserDiscovery,resolveLocalUserConnection,type LocalCredentialVault} from "../../src/local-user-api/credentials.js";
import {parseLocalUserApiArgs,runLocalUserApiCli} from "../../src/local-user-api/cli.js";
import {LOCAL_USER_API_PROTOCOL as protocol,parseLocalApiRequest} from "../../src/local-user-api/protocol.js";

const secret="qml1_"+"A".repeat(43),task="task_current",targetTask="task_target";
const code=(wanted:string)=>(error:unknown)=>error instanceof LocalUserClientError&&error.code===wanted;
const enrollment=(endpoint:string)=>({audience:protocol,endpoint,clientId:"localclient_test",clientName:"QuayDock desktop",grantId:"localgrant_test",
  credential:secret,expiresAt:Date.now()+60_000,capabilities:["status:read","tasks:read","events:read"],taskIds:null,sourceTaskId:null});
function output(delay=0){
  let text="";
  const stream=new Writable({write(chunk,_encoding,done){setTimeout(()=>{text+=chunk.toString();done();},delay);}});
  return {stream,text:()=>text};
}
async function privateDirectory(){const directory=await mkdtemp(join(tmpdir(),"qm-cli-"));await chmod(directory,0o700);return directory;}
async function discovery(directory:string,endpoint:string,mode=0o600){
  await writeFile(join(directory,"local-user-api.json"),JSON.stringify({protocol,endpoint,nodeId:"test"}),{mode});
}
async function ipc(handler:(request:ReturnType<typeof parseLocalApiRequest>,socket:Socket)=>void){
  const directory=await privateDirectory(),endpoint=join(directory,"api.sock"),connections=new Set<Socket>(),received:ReturnType<typeof parseLocalApiRequest>[]=[];
  const server=createServer(socket=>{
    connections.add(socket);socket.on("close",()=>connections.delete(socket));socket.on("error",()=>{});
    let buffered="";
    socket.on("data",chunk=>{buffered+=chunk.toString();if(!buffered.includes("\n"))return;
      const line=buffered.slice(0,buffered.indexOf("\n"));buffered="";
      const request=parseLocalApiRequest(JSON.parse(line));assert.equal(request.credential,secret);received.push(request);handler(request,socket);
    });
  });
  await new Promise<void>((done,reject)=>{server.once("error",reject);server.listen(endpoint,()=>{server.removeListener("error",reject);done();});});
  await chmod(endpoint,0o600);
  return {directory,endpoint,received,async close(){for(const socket of connections)socket.destroy();await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}};
}
function reply(request:ReturnType<typeof parseLocalApiRequest>,result:unknown,done=true){return JSON.stringify({protocol,id:request.id,ok:true,result,done})+"\n";}

test("all eight CLI methods parse into the strict wire contract, with no source identity",()=>{
  const examples:[string[],string][]=[[["status"],"status.get"],[["tasks","list","--limit","50","--cursor","opaque"],"tasks.list"],
    [["tasks","get",task],"tasks.get"],[["events","read",task,"--limit","100"],"events.read"],[["events","watch",task],"events.watch"],
    [["peer","send",targetTask,"--message-key","message_1","--stdin"],"peer.send"],
    [["peer","receive","--request-key","receive_1","--after-sequence","0","--limit","8"],"peer.receive"],
    [["peer","ack","delivery_1","--message-id","message_1","--message-id","message_2"],"peer.ack"]];
  for(const [args,method] of examples){const parsed=parseLocalUserApiArgs(["local",...args]);assert.equal(parsed.kind,"request");if(parsed.kind!=="request")throw new Error("unreachable");
    assert.equal(parsed.method,method);assert.equal(Object.hasOwn(parsed.params,"source_task_id"),false);}
  assert.equal(parseLocalUserApiArgs(["local","--client=quaydock","status"]).kind,"request");
  const json=parseLocalUserApiArgs(["local","--json","status","--client","quaydock"]);
  assert.equal(json.kind,"request");if(json.kind==="request")assert.deepEqual(json.params,{});
  assert.deepEqual(parseLocalUserApiArgs(["client","import","quaydock","--stdin"]),{kind:"import",client:"quaydock"});
  assert.deepEqual(parseLocalUserApiArgs(["client","import","quaydock","--stdin","--json"]),{kind:"import",client:"quaydock"});
});

test("unknown methods, identity/auth flags, duplicates and invalid bounds are rejected before I/O",async()=>{
  const invalid=[
    ["local","status","--credential",secret],["local","status","--token",secret],["local","status","--owner","owner"],
    ["local","peer","receive","--source-task-id",task,"--request-key","r"],["local","messages","enqueue",task],
    ["local","tasks","list","--limit","51"],["local","events","read",task,"--limit","0"],
    ["local","peer","receive","--request-key","r","--limit","9"],["local","peer","receive","--request-key","r","--after-sequence","-1"],
    ["local","tasks","list","--limit","1.2"],["local","tasks","list","--limit","1","--limit","2"],
    ["local","peer","send",targetTask,"--stdin"],["local","peer","send",targetTask,"--message-key","k"],
    ["local","peer","ack","d","--message-id","m","--message-id","m"],["local","tasks","get",task,"extra"],
    ["client","import","quaydock"],["local","events","read","bad id"],
  ];
  for(const args of invalid){
    const stdout=output(),stderr=output();let connections=0;
    const status=await runLocalUserApiCli(args,{env:{},stdin:Readable.from([]),stdout:stdout.stream,stderr:stderr.stream,
      resolveConnection:async()=>{connections++;throw new Error("must not connect");}});
    assert.equal(status,1);assert.equal(connections,0);assert.equal(stdout.text(),"");assert.equal(stderr.text().includes(secret),false);
  }
});

test("only local pipe/socket endpoints are accepted",()=>{
  assert.equal(validLocalEndpoint("\\\\.\\pipe\\QuayMesh.LocalUser.test","win32"),true);
  for(const endpoint of ["\\\\remote\\pipe\\api","https://host/api","\\\\.\\pipe\\nested\\api"])
    assert.equal(validLocalEndpoint(endpoint,"win32"),false);
  assert.equal(validLocalEndpoint("/tmp/private/api.sock","linux"),true);
  for(const endpoint of ["tcp://127.0.0.1:9","relative.sock","/tmp/a\0b"])assert.equal(validLocalEndpoint(endpoint,"linux"),false);
});

test("real Unix IPC drives all eight CLI methods; watch streams fragmented Unicode frames and flushes output",async()=>{
  const fixture=await ipc((request,socket)=>{
    if(request.method==="events.watch"){
      const buffer=Buffer.from(reply(request,{items:[{body:"中文事件"}],nextCursor:"1",hasMore:false},false)+reply(request,{items:[],nextCursor:"1",hasMore:false,heartbeat:true},true));
      const cut=buffer.indexOf(Buffer.from("中文"))+1;socket.write(buffer.subarray(0,cut));setTimeout(()=>socket.end(buffer.subarray(cut)),5);
    }else socket.end(reply(request,{method:request.method,params:request.params}));
  });
  try{
    const commands=[...["status"].map(value=>[value]),["tasks","list"],["tasks","get",task],["events","read",task],["events","watch",task],
      ["peer","send",targetTask,"--message-key","stable_send","--stdin"],["peer","receive","--request-key","stable_receive"],
      ["peer","ack","delivery_1","--message-id","message_1"]];
    for(const args of commands){
      const stdout=output(2),stderr=output();
      const status=await runLocalUserApiCli(["local",...args],{env:{QUAYMESH_LOCAL_API_ENDPOINT:fixture.endpoint,QUAYMESH_LOCAL_API_CREDENTIAL:secret},
        stdin:Readable.from(["message body\n"]),stdout:stdout.stream,stderr:stderr.stream});
      assert.equal(status,0,stderr.text());assert.equal(stderr.text(),"");assert.equal(stdout.text().includes(secret),false);
      const values=stdout.text().trim().split("\n").map(line=>JSON.parse(line));
      if(args[0]==="events"&&args[1]==="watch"){assert.equal(values.length,2);assert.equal(values[0].items[0].body,"中文事件");assert.equal(values[1].heartbeat,true);}
      else assert.equal(values.length,1);
    }
    assert.equal(fixture.received.length,8);assert.equal(fixture.received.find(value=>value.method==="peer.send")!.params.body,"message body\n");
  }finally{await fixture.close();}
});

test("client rejects arbitrary method/identity fields before connecting",async()=>{
  const fixture=await ipc(()=>{});
  try{
    const client=new LocalUserClient({endpoint:fixture.endpoint,credential:secret});
    await assert.rejects(client.request("status.get",{source_task_id:task}),code("LOCAL_API_INVALID_REQUEST"));
    await assert.rejects(client.request("tasks.list",{limit:51}),code("LOCAL_API_INVALID_REQUEST"));assert.equal(fixture.received.length,0);
  }finally{await fixture.close();}
});

test("unsafe Unix socket permissions fail before sending the credential",async()=>{
  const fixture=await ipc(()=>{});
  try{
    await chmod(fixture.endpoint,0o666);
    await assert.rejects(new LocalUserClient({endpoint:fixture.endpoint,credential:secret}).request("status.get"),code("LOCAL_API_ENDPOINT_UNSAFE"));
    assert.equal(fixture.received.length,0);
  }finally{await fixture.close();}
});

test("sent peer mutation timeout is unknown and is never silently retried",async()=>{
  const fixture=await ipc(()=>{});
  try{
    const client=new LocalUserClient({endpoint:fixture.endpoint,credential:secret},{requestTimeoutMs:35});
    await assert.rejects(client.request("peer.send",{target_task_id:targetTask,message_key:"stable_key",body:"hello"}),
      error=>code("LOCAL_API_TIMEOUT")(error)&&(error as LocalUserClientError).effect==="unknown");
    assert.equal(fixture.received.length,1);
  }finally{await fixture.close();}
});

test("connection close without a completed response is not a successful empty result",async()=>{
  const fixture=await ipc((_request,socket)=>socket.end());
  try{await assert.rejects(new LocalUserClient({endpoint:fixture.endpoint,credential:secret}).request("status.get"),code("LOCAL_API_CONNECTION_CLOSED"));}
  finally{await fixture.close();}
});

test("malformed, mismatched, nonfinal and oversized IPC responses are rejected",async()=>{
  const responses=[(request:ReturnType<typeof parseLocalApiRequest>)=>JSON.stringify({protocol,id:"wrong",ok:true,result:{},done:true})+"\n",
    ()=>Buffer.from([255,10]),()=>"x".repeat(65_537),
    (request:ReturnType<typeof parseLocalApiRequest>)=>reply(request,{},false),
    (request:ReturnType<typeof parseLocalApiRequest>)=>JSON.stringify({protocol,id:request.id,ok:true,result:{}})+"\n"];
  for(const response of responses){
    const fixture=await ipc((request,socket)=>socket.end(response(request)));
    try{await assert.rejects(new LocalUserClient({endpoint:fixture.endpoint,credential:secret}).request("status.get"),code("LOCAL_API_INVALID_RESPONSE"));}
    finally{await fixture.close();}
  }
});

test("credential echoes are redacted in success/error values and object keys",async()=>{
  for(const ok of [true,false]){
    const fixture=await ipc((request,socket)=>socket.end(ok?reply(request,{[secret]:secret}):JSON.stringify({protocol,id:request.id,ok:false,done:true,
      error:{code:"LOCAL_API_CAPABILITY_DENIED",message:secret,details:{[secret]:secret}}})+"\n"));
    try{
      const stdout=output(),stderr=output();const status=await runLocalUserApiCli(["local","status"],{env:{QUAYMESH_LOCAL_API_ENDPOINT:fixture.endpoint,QUAYMESH_LOCAL_API_CREDENTIAL:secret},stdout:stdout.stream,stderr:stderr.stream});
      assert.equal(status,ok?0:1);assert.equal((stdout.text()+stderr.text()).includes(secret),false);assert.match(stdout.text()+stderr.text(),/redacted/);
    }finally{await fixture.close();}
  }
});

test("watch heartbeats keep the stream alive, and cancellation stops only its connection",async()=>{
  const fixture=await ipc((request,socket)=>{
    const tick=setInterval(()=>socket.write(reply(request,{items:[],heartbeat:true,nextCursor:null,hasMore:false},false)),15);
    socket.once("close",()=>clearInterval(tick));socket.write(reply(request,{items:[],nextCursor:null,hasMore:false},false));
  });
  try{
    const abort=new AbortController(),client=new LocalUserClient({endpoint:fixture.endpoint,credential:secret},{watchIdleTimeoutMs:30});let seen=0;
    await assert.rejects(async()=>{for await(const _frame of client.watch({task_id:task},abort.signal))if(++seen===5)abort.abort();},code("LOCAL_API_ABORTED"));
    assert.equal(seen,5);assert.equal(fixture.received.length,1);
  }finally{await fixture.close();}
});

test("pre-cancelled client request never reaches the server",async()=>{
  const fixture=await ipc(()=>{});try{const abort=new AbortController();abort.abort();
    await assert.rejects(new LocalUserClient({endpoint:fixture.endpoint,credential:secret}).request("status.get",{},abort.signal),code("LOCAL_API_ABORTED"));assert.equal(fixture.received.length,0);
  }finally{await fixture.close();}
});

test("CLI watch cancellation returns an explicit cancelled status without retrying",async()=>{
  const fixture=await ipc((request,socket)=>socket.write(reply(request,{items:[],heartbeat:true,nextCursor:null,hasMore:false},false)));
  try{
    const abort=new AbortController(),stderr=output();let body="";
    const stdout=new Writable({write(chunk,_encoding,done){body+=chunk.toString();done();abort.abort();}});
    const status=await runLocalUserApiCli(["local","events","watch",task],{env:{QUAYMESH_LOCAL_API_ENDPOINT:fixture.endpoint,QUAYMESH_LOCAL_API_CREDENTIAL:secret},stdout,stderr:stderr.stream,signal:abort.signal});
    assert.equal(status,130);assert.equal(body.trim().split("\n").length,1);assert.equal(JSON.parse(stderr.text()).error.code,"LOCAL_API_ABORTED");assert.equal(fixture.received.length,1);
  }finally{await fixture.close();}
});

test("closed stdout returns a safe output error rather than an uncaught stream exception",async()=>{
  const fixture=await ipc((request,socket)=>socket.end(reply(request,{ok:true})));
  try{
    const stderr=output(),stdout=new Writable({write(_chunk,_encoding,done){done(Object.assign(new Error("output closed"),{code:"EPIPE"}));}});
    const status=await runLocalUserApiCli(["local","status"],{env:{QUAYMESH_LOCAL_API_ENDPOINT:fixture.endpoint,QUAYMESH_LOCAL_API_CREDENTIAL:secret},stdout,stderr:stderr.stream});
    assert.equal(status,1);assert.equal(JSON.parse(stderr.text()).error.code,"LOCAL_API_OUTPUT_FAILED");
  }finally{await fixture.close();}
});

test("discovery is only public metadata and rejects permissive, linked or malformed files",async()=>{
  const directory=await privateDirectory(),endpoint=join(directory,"api.sock"),file=join(directory,"local-user-api.json");
  try{
    await discovery(directory,endpoint);await writeFile(join(directory,"auth.json"),"not consulted: "+secret,{mode:0o000});
    assert.deepEqual(await readLocalUserDiscovery(directory),{protocol,endpoint});
    await chmod(file,0o644);await assert.rejects(readLocalUserDiscovery(directory),code("LOCAL_API_DISCOVERY_UNSAFE"));await chmod(file,0o600);
    await chmod(directory,0o755);assert.deepEqual(await readLocalUserDiscovery(directory),{protocol,endpoint});
    await chmod(directory,0o775);await assert.rejects(readLocalUserDiscovery(directory),code("LOCAL_API_DISCOVERY_UNSAFE"));await chmod(directory,0o700);
    await rm(file);await symlink(join(directory,"auth.json"),file);await assert.rejects(readLocalUserDiscovery(directory));await rm(file);
    await writeFile(file,"not json",{mode:0o600});await assert.rejects(readLocalUserDiscovery(directory),code("LOCAL_API_DISCOVERY_UNAVAILABLE"));
    await writeFile(file,JSON.stringify({protocol,endpoint:"https://remote.invalid"}));await assert.rejects(readLocalUserDiscovery(directory),code("LOCAL_API_DISCOVERY_INVALID"));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("discovery directory selection follows explicit/env/installed defaults without loading owner configuration",()=>{
  assert.equal(localUserConfigDirectory(undefined,{},"linux","/home/test"),"/home/test/.config/quaymesh");
  assert.equal(localUserConfigDirectory(undefined,{XDG_CONFIG_HOME:"/config"},"linux","/home/test"),"/config/quaymesh");
  assert.equal(localUserConfigDirectory("/chosen",{QUAYMESH_CONFIG_DIR:"/env"},"linux","/home/test"),"/chosen");
  assert.equal(localUserConfigDirectory(undefined,{QUAYMESH_CONFIG_DIR:"/env"},"linux","/home/test"),"/env");
  assert.equal(localUserConfigDirectory(undefined,{QUAYMESH_LOCAL_API_CONFIG_DIR:"/stable",QUAYMESH_CONFIG_DIR:"/generated/core"},"linux","/home/test"),"/stable");
  assert.equal(localUserConfigDirectory("/explicit",{QUAYMESH_LOCAL_API_CONFIG_DIR:"/stable"},"linux","/home/test"),"/explicit");
  assert.equal(localUserConfigDirectory(undefined,{LOCALAPPDATA:"C:\\Users\\test\\AppData\\Local"},"win32","C:\\Users\\test"),"C:\\Users\\test\\AppData\\Local\\QuayMesh\\config");
});

test("Task environment bypasses vault/discovery, but cannot be mixed with a selected client or be incomplete",async()=>{
  const endpoint="/does/not/need/to/exist.sock",env={QUAYMESH_LOCAL_API_ENDPOINT:endpoint,QUAYMESH_LOCAL_API_CREDENTIAL:secret};
  const vault:LocalCredentialVault={read:async()=>{throw new Error("must not read vault");},write:async()=>{throw new Error("must not write vault");}};
  assert.deepEqual(await resolveLocalUserConnection({env,configDir:"/missing",vault}),{endpoint,credential:secret});
  await assert.rejects(resolveLocalUserConnection({env,client:"quaydock",configDir:"/missing",vault}),code("LOCAL_API_AMBIGUOUS_CREDENTIAL"));
  await assert.rejects(resolveLocalUserConnection({env:{QUAYMESH_LOCAL_API_CREDENTIAL:secret},configDir:"/missing",vault}),code("LOCAL_API_INVALID_CREDENTIAL"));
  await assert.rejects(resolveLocalUserConnection({env:{QUAYMESH_OAUTH_OWNER_TOKEN:"not-a-local-credential"},configDir:"/missing",vault}),code("LOCAL_API_CLIENT_REQUIRED"));
});

test("stdin enrollment persists only in the vault and returns no credential; enrolled lookup matches the endpoint",async()=>{
  const directory=await privateDirectory(),endpoint=join(directory,"api.sock"),records=new Map<string,string>();
  const vault:LocalCredentialVault={read:async name=>records.get(name)??null,write:async(name,value)=>{records.set(name,value);}};
  try{
    await discovery(directory,endpoint);const initial=await readdir(directory),stdout=output(),stderr=output(),value=enrollment(endpoint);
    const result=await runLocalUserApiCli(["client","import","quaydock","--stdin","--config-dir",directory],{env:{},stdin:Readable.from([JSON.stringify(value)]),stdout:stdout.stream,stderr:stderr.stream,vault});
    assert.equal(result,0,stderr.text());assert.equal(records.size,1);assert.equal(stdout.text().includes(secret),false);assert.equal(JSON.parse(stdout.text()).stored,true);
    assert.equal(records.get(localCredentialTarget("quaydock",endpoint))!.includes(secret),true);assert.deepEqual(await readdir(directory),initial);
    assert.deepEqual(await resolveLocalUserConnection({env:{},client:"quaydock",configDir:directory,vault}),{endpoint,credential:secret});
    assert.equal((await readFile(join(directory,"local-user-api.json"),"utf8")).includes(secret),false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("invalid/expired/mismatched enrollment, peer without source Task and vault failure never create a plaintext fallback",async()=>{
  const endpoint="/private/api.sock",metadata={protocol,endpoint};let writes=0;
  const vault:LocalCredentialVault={read:async()=>null,write:async()=>{writes++;}};
  const invalid=[{expiresAt:Date.now()-1},{audience:"owner"},{endpoint:"/other.sock"},{credential:"owner-token"},
    {capabilities:["admin:write"]},{capabilities:["tasks:read","tasks:read"]},{capabilities:["peer:send"],sourceTaskId:null},
    {capabilities:["peer:read"],sourceTaskId:task,taskIds:[targetTask]}];
  for(const fields of invalid)await assert.rejects(importLocalUserEnrollment("quaydock",{...enrollment(endpoint),...fields},metadata,vault));
  assert.equal(writes,0);
  const broken:LocalCredentialVault={read:async()=>null,write:async()=>{throw new Error(secret);}};
  await assert.rejects(importLocalUserEnrollment("quaydock",enrollment(endpoint),metadata,broken),error=>code("LOCAL_API_SECURE_STORAGE_UNAVAILABLE")(error)&&!String(error).includes(secret));
});

test("Windows vault uses fixed code/argv with secrets only on stdin and removes inherited QuayMesh secrets",async()=>{
  const endpoint="\\\\.\\pipe\\QuayMesh.LocalUser.test",value=JSON.stringify(enrollment(endpoint)),calls:{program:string;args:readonly string[];input:string;env:NodeJS.ProcessEnv}[]=[];
  const vault=createPlatformCredentialVault({platform:"win32",env:{SystemRoot:"C:\\Windows",QUAYMESH_LOCAL_API_CREDENTIAL:secret,QUAYMESH_OAUTH_OWNER_TOKEN:"owner-secret",QUAYMESH_TUNNEL_API_KEY:"api-secret"},
    run:async(program,args,input,env)=>{calls.push({program,args,input,env});return {code:0,stderr:"",stdout:JSON.parse(input).action==="write"?'{"stored":true}':JSON.stringify({found:true,value})};}});
  const name=localCredentialTarget("quaydock",endpoint);await vault.write(name,value);assert.equal(await vault.read(name),value);
  assert.equal(calls.length,2);assert.deepEqual(calls[0]!.args,calls[1]!.args);assert.equal(calls[0]!.args.join(" ").includes(secret),false);
  assert.equal(calls[0]!.input.includes(secret),true);assert.equal(calls[0]!.env.QUAYMESH_LOCAL_API_CREDENTIAL,undefined);assert.equal(calls[0]!.env.QUAYMESH_OAUTH_OWNER_TOKEN,undefined);assert.equal(calls[0]!.env.QUAYMESH_TUNNEL_API_KEY,undefined);
  const script=Buffer.from(calls[0]!.args.at(-1)!,"base64").toString("utf16le");assert.match(script,/CredWriteW/);assert.match(script,/InputEncoding/);assert.equal(script.includes(secret),false);
});

test("Linux Secret Service puts the credential only on stdin and fails closed without a usable vault",async()=>{
  const calls:{program:string;args:readonly string[];input:string}[]=[],stored=JSON.stringify(enrollment("/private/api.sock"));
  const vault=createPlatformCredentialVault({platform:"linux",env:{},run:async(program,args,input)=>{calls.push({program,args,input});return{code:0,stderr:"",stdout:args[0]==="lookup"?stored+"\n":""};}});
  await vault.write("target-name",stored);assert.equal(await vault.read("target-name"),stored);
  assert.equal(calls[0]!.program,"/usr/bin/secret-tool");assert.equal(calls[0]!.args.includes(stored),false);assert.equal(calls[0]!.input,stored);
  const broken=createPlatformCredentialVault({platform:"linux",env:{},run:async()=>({code:1,stdout:"",stderr:secret})});
  await assert.rejects(broken.write("target",stored),error=>code("LOCAL_API_SECURE_STORAGE_UNAVAILABLE")(error)&&!String(error).includes(secret));
  await assert.rejects(createPlatformCredentialVault({platform:"darwin"}).write("target",stored),code("LOCAL_API_SECURE_STORAGE_UNAVAILABLE"));
});

test("Windows discovery requires protected private ACL verification and rejects failed/broad ACL reports",async()=>{
  const directory=await privateDirectory(),endpoint="\\\\.\\pipe\\QuayMesh.LocalUser.test";try{
    await discovery(directory,endpoint);let script="",stdin="";
    const metadata=await readLocalUserDiscovery(directory,{platform:"win32",env:{SystemRoot:"C:\\Windows"},run:async(_program,args,input)=>{
      script=Buffer.from(args.at(-1)!,"base64").toString("utf16le");stdin=input;return {code:0,stdout:'{"private":true}',stderr:""};}});
    assert.equal(metadata.endpoint,endpoint);assert.match(script,/AreAccessRulesProtected/);assert.match(script,/IsInherited/);assert.match(script,/ReparsePoint/);assert.equal(JSON.parse(stdin).directory,directory);
    await assert.rejects(readLocalUserDiscovery(directory,{platform:"win32",run:async()=>({code:1,stdout:"",stderr:secret})}),
      error=>code("LOCAL_API_DISCOVERY_UNSAFE")(error)&&!String(error).includes(secret));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("stdin errors and model-environment import fail without leaking credentials or using the vault",async()=>{
  for(const [args,input,env] of [
    [["client","import","quaydock","--stdin"],'{"credential":"'+secret,{ }],
    [["client","import","quaydock","--stdin"],"{}",{QUAYMESH_LOCAL_API_ENDPOINT:"/x",QUAYMESH_LOCAL_API_CREDENTIAL:secret}],
    [["local","peer","send",targetTask,"--message-key","stable","--stdin"]," ",{ }],
    [["local","peer","send",targetTask,"--message-key","stable","--stdin"],"x".repeat(16_385),{ }],
  ] as [string[],string,NodeJS.ProcessEnv][]){
    const stdout=output(),stderr=output();let reads=0,writes=0;
    const status=await runLocalUserApiCli(args,{env,stdin:Readable.from([input]),stdout:stdout.stream,stderr:stderr.stream,vault:{read:async()=>{reads++;return null;},write:async()=>{writes++;}}});
    assert.equal(status,1);assert.equal(stdout.text(),"");assert.equal(stderr.text().includes(secret),false);assert.equal(reads+writes,0);
  }
});
