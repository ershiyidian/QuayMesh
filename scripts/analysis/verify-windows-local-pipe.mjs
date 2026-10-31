import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {win32, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {parseArgs} from "node:util";
import {once} from "node:events";

// Independent fixture only. Every server uses a new test pipe; no installed
// QuayMesh pipe, service, vault, Task or real credential is accessed.
const SERVER = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
public static class QuayMeshPipeFixture {
  public static int Run() {
    string name=Console.ReadLine(), allowed=Console.ReadLine();
    if(name==null || !Regex.IsMatch(name,@"\AQuayMesh\.LocalApiTest\.[A-Za-z0-9._-]+\z")) return 2;
    using(var current=WindowsIdentity.GetCurrent()) {
      var user=current.User;
      if(user==null) return 2;
      var client=String.IsNullOrEmpty(allowed) ? user : new SecurityIdentifier(allowed);
      var acl=new PipeSecurity(); acl.SetOwner(user); acl.SetAccessRuleProtection(true,false);
      acl.AddAccessRule(new PipeAccessRule(user,PipeAccessRights.FullControl,AccessControlType.Allow));
      if(!client.Equals(user)) acl.AddAccessRule(new PipeAccessRule(client,PipeAccessRights.ReadWrite,AccessControlType.Allow));
      using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,8192,8192,acl)) {
        Console.WriteLine("READY "+user.Value+" "+client.Value); Console.Out.Flush();
        pipe.WaitForConnection(); long bytes=0; var buffer=new byte[8192];
        try {
          int count;
          while((count=pipe.Read(buffer,0,buffer.Length))>0) {
            bytes+=count; pipe.Write(buffer,0,count); pipe.Flush();
          }
        } catch(IOException) { }
        Console.WriteLine("CLOSED "+bytes); Console.Out.Flush(); return 0;
      }
    }
  }
}
'@
$result=[QuayMeshPipeFixture]::Run()
exit $result
} catch { [Console]::Error.WriteLine('FIXTURE_FAILED'); exit 1 }
`;

const assert = (condition, code) => {if (!condition) throw new Error(code);};
function deadline(promise, milliseconds, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {timer=setTimeout(()=>reject(new Error(code)),milliseconds);})])
    .finally(()=>clearTimeout(timer));
}
function lines(stream) {
  const queued=[], readers=[];let bytes=Buffer.alloc(0), failed;
  const fail=error=>{failed=error;for(const reader of readers.splice(0))reader.reject(error);};
  stream.on("error",()=>fail(new Error("FIXTURE_STREAM_FAILED")));
  stream.on("end",()=>fail(new Error("FIXTURE_STREAM_ENDED")));
  stream.on("data",chunk=>{
    bytes=Buffer.concat([bytes,Buffer.from(chunk)]);
    if(bytes.length>65536){fail(new Error("FIXTURE_LINE_TOO_LARGE"));return;}
    let end;
    while((end=bytes.indexOf(10))>=0){
      const line=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,end)).replace(/\r$/,"");bytes=bytes.subarray(end+1);
      const reader=readers.shift();if(reader)reader.resolve(line);else queued.push(line);
    }
  });
  return ()=>queued.length?Promise.resolve(queued.shift()):failed?Promise.reject(failed):new Promise((resolve,reject)=>readers.push({resolve,reject}));
}
let server, pipe;
const cases=[];
try {
  assert(process.platform==="win32","WINDOWS_REQUIRED");
  const {values}=parseArgs({options:{module:{type:"string"},"foreign-endpoint":{type:"string"},serve:{type:"string"},"allow-client-sid":{type:"string"}},strict:true});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&!/^QUAYMESH_/i.test(key)&&!/^(NODE_OPTIONS|NODE_PATH)$/i.test(key)));
  const powershell=win32.join(env.SystemRoot||env.SYSTEMROOT||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
  const name=values.serve||"QuayMesh.LocalApiTest."+process.pid+"."+randomUUID().replaceAll("-","");
  assert(/^QuayMesh\.LocalApiTest\.[A-Za-z0-9._-]+$/.test(name),"INVALID_TEST_PIPE");
  server=spawn(powershell,["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(SERVER,"utf16le").toString("base64")],
    {env,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  server.stderr.resume();
  const serverLine=lines(server.stdout), serverExit=once(server,"close");
  server.stdin.end(name+"\n"+(values["allow-client-sid"]||"")+"\n");
  const ready=await deadline(serverLine(),15000,"SERVER_READY_TIMEOUT");
  assert(/^READY S-1-[0-9-]+ S-1-[0-9-]+$/.test(ready),"SERVER_NOT_READY");
  const endpoint="\\\\.\\pipe\\"+name;
  if(values.serve){
    console.log(JSON.stringify({ready:true,endpoint,serverPid:server.pid,ownerSid:ready.split(" ")[1],allowedSid:ready.split(" ")[2]}));
    const closed=await deadline(serverLine(),45000,"SERVER_CONNECTION_TIMEOUT");
    console.log(JSON.stringify({closed:true,receivedBytes:Number(closed.split(" ")[1])}));
    await deadline(serverExit,3000,"SERVER_EXIT_TIMEOUT");
  }else{
    assert(values.module,"REQUIRE_MODULE_PATH");
    const {createWindowsLocalPipe}=await import(pathToFileURL(resolve(values.module)).href);
    pipe=createWindowsLocalPipe(endpoint);
    const read=lines(pipe), connected=once(pipe,"connect");
    const first="first "+String.fromCodePoint(38634), second="watch heartbeat";
    pipe.write(first+"\n");
    await deadline(connected,15000,"VERIFIED_CONNECT_TIMEOUT");
    assert(await deadline(read(),5000,"FIRST_FRAME_TIMEOUT")===first,"FIRST_FRAME_MISMATCH");
    pipe.write(second+"\n");
    assert(await deadline(read(),5000,"WATCH_FRAME_TIMEOUT")===second,"WATCH_FRAME_MISMATCH");
    cases.push({name:"same_connected_server_sid_and_streaming",passed:true,serverPid:server.pid,ownerSid:ready.split(" ")[1]});
    pipe.destroy();pipe=undefined;
    const closed=await deadline(serverLine(),3000,"CANCEL_DID_NOT_CLOSE_PIPE");
    assert(closed==="CLOSED "+Buffer.byteLength(first+"\n"+second+"\n"),"SERVER_RECEIVED_UNEXPECTED_BYTES");
    assert((await deadline(serverExit,3000,"SERVER_EXIT_TIMEOUT"))[0]===0,"SERVER_EXIT_FAILED");
    cases.push({name:"cancel_closes_only_test_connection",passed:true});server=undefined;
    if(values["foreign-endpoint"]){
      assert(/^\\\\\.\\pipe\\QuayMesh\.LocalApiTest\.[A-Za-z0-9._-]+$/.test(values["foreign-endpoint"]),"FOREIGN_FIXTURE_PIPE_REQUIRED");
      pipe=createWindowsLocalPipe(values["foreign-endpoint"]);let connectedForeign=false;
      pipe.on("connect",()=>{connectedForeign=true;});const rejected=once(pipe,"error");
      pipe.write("fixture-only-no-real-credential\n",()=>{});
      const error=(await deadline(rejected,15000,"FOREIGN_SERVER_NOT_REJECTED"))[0];
      assert(error.code==="LOCAL_API_ENDPOINT_UNSAFE"&&!connectedForeign,"FOREIGN_SERVER_IDENTITY_ACCEPTED");
      pipe=undefined;cases.push({name:"foreign_windows_user_rejected_before_payload",passed:true});
    }
    console.log(JSON.stringify({ok:true,cases,foreignUserTested:Boolean(values["foreign-endpoint"]),productionServicesTouched:false,realCredentialsUsed:false}));
  }
}catch(error){
  console.error(JSON.stringify({ok:false,code:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:"WINDOWS_PIPE_FIXTURE_FAILED",cases}));
  process.exitCode=1;
}finally{
  pipe?.destroy();
  if(server&&server.exitCode===null&&!server.killed)server.kill();
}
