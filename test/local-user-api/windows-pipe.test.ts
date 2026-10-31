import assert from "node:assert/strict";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {once} from "node:events";
import {test} from "node:test";
import {createWindowsLocalPipe, type WindowsLocalPipeOptions} from "../../src/local-user-api/windows-pipe.js";

const endpoint = "\\\\.\\pipe\\QuayMesh.LocalUser.test";
const credential = "qml1_" + "x".repeat(43);
const code = (value: string) => (error: unknown) => (error as {code?: string})?.code === value;
function helper(source: string) {
  const writes: string[] = [];
  let child: ChildProcessWithoutNullStreams | undefined;
  let invocation: {file: string; args: string[]; env: NodeJS.ProcessEnv | undefined} | undefined;
  const run: NonNullable<WindowsLocalPipeOptions["spawn"]> = (file, args, options) => {
    invocation = {file, args, env: options.env};
    child = spawn(process.execPath, ["-e", source], {env: options.env, stdio: ["pipe", "pipe", "pipe"]});
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((...arguments_: Parameters<typeof child.stdin.write>) => {
      writes.push(Buffer.isBuffer(arguments_[0]) ? arguments_[0].toString() : String(arguments_[0]));
      return write(...arguments_);
    }) as typeof child.stdin.write;
    return child;
  };
  return {run, writes, child: () => child!, invocation: () => invocation!};
}
const echo = `
let header=false, pending=Buffer.alloc(0);
process.stdin.on('data',data=>{
  if(header){process.stdout.write(data);return;}
  pending=Buffer.concat([pending,data]);const index=pending.indexOf(10);
  if(index<0)return;header=true;
  if(index!==pending.length-1)process.exit(9);
  setTimeout(()=>process.stderr.write('QM_PIPE_READY\\n'),20);
});
`;

test("Windows transport keeps early credentials in Node until verified READY, with fixed helper argv", async () => {
  const mock=helper(echo), stream=createWindowsLocalPipe(endpoint,{spawn:mock.run,
    env:{SystemRoot:"C:\\Windows",QUAYMESH_LOCAL_API_CREDENTIAL:credential,QUAYMESH_LOCAL_API_BRIDGE_KEY:"bridge-secret",NODE_OPTIONS:"bad-option"}});
  const connected=once(stream,"connect"), output=once(stream,"data");
  stream.write(credential+"\n");
  assert.deepEqual(mock.writes,[endpoint+"\n"]);
  assert.equal(mock.invocation().args.join(" ").includes(credential),false);
  assert.equal(mock.invocation().args.join(" ").includes(endpoint),false);
  assert.equal(Object.keys(mock.invocation().env??{}).some(key=>/^QUAYMESH_/i.test(key)),false);
  assert.equal(mock.invocation().env?.NODE_OPTIONS,undefined);
  await connected;
  assert.equal((await output)[0].toString(),credential+"\n");
  assert.deepEqual(mock.writes,[endpoint+"\n",credential+"\n"]);
  const exited=once(mock.child(),"close");stream.destroy();await exited;
});

test("refused Windows server identity never receives a queued credential", async () => {
  const mock=helper("process.stdin.once('data',()=>process.stderr.write('QM_PIPE_ERROR LOCAL_API_ENDPOINT_UNSAFE\\n'));"),
    stream=createWindowsLocalPipe(endpoint,{spawn:mock.run});
  const rejected=once(stream,"error"), exited=once(mock.child(),"close");
  let connected=false;stream.on("connect",()=>{connected=true;});stream.write(credential+"\n",()=>{});
  assert.equal(code("LOCAL_API_ENDPOINT_UNSAFE")((await rejected)[0]),true);
  await exited;assert.equal(connected,false);assert.deepEqual(mock.writes,[endpoint+"\n"]);
});

test("data before verified READY fails closed without forwarding the queued credential", async () => {
  const mock=helper("process.stdin.once('data',()=>process.stdout.write('unverified data'));"),
    stream=createWindowsLocalPipe(endpoint,{spawn:mock.run});
  const rejected=once(stream,"error"), exited=once(mock.child(),"close");
  stream.write(credential+"\n",()=>{});
  assert.equal(code("LOCAL_API_ENDPOINT_UNSAFE")((await rejected)[0]),true);
  await exited;assert.deepEqual(mock.writes,[endpoint+"\n"]);
});

test("Windows watch bytes stream separately and cancellation exits only its helper", async () => {
  const mock=helper(echo), stream=createWindowsLocalPipe(endpoint,{spawn:mock.run});
  await once(stream,"connect");
  const first=once(stream,"data");stream.write("first\n");assert.equal((await first)[0].toString(),"first\n");
  const second=once(stream,"data");stream.write("second\n");assert.equal((await second)[0].toString(),"second\n");
  const exited=once(mock.child(),"close");stream.destroy();await exited;
  assert.equal(stream.destroyed,true);assert.equal(mock.child().killed,true);
});

test("oversized helper control output is bounded and cannot expose a raw helper error", async () => {
  const mock=helper("process.stdin.once('data',()=>process.stderr.write('untrusted '+ 'z'.repeat(5000)));"),
    stream=createWindowsLocalPipe(endpoint,{spawn:mock.run});
  const rejected=once(stream,"error"), exited=once(mock.child(),"close");
  const error=(await rejected)[0] as Error;
  assert.equal(error.message,"LOCAL_API_UNAVAILABLE");await exited;
});

test("remote and control-character pipe endpoints are rejected before helper creation", () => {
  let invoked=false;
  const run: NonNullable<WindowsLocalPipeOptions["spawn"]> = () => {invoked=true;throw new Error("must not run");};
  for(const unsafe of ["\\\\other\\pipe\\test", "https://remote.invalid", endpoint+"\n", endpoint+"/suffix", endpoint+"\\suffix"])
    assert.throws(()=>createWindowsLocalPipe(unsafe,{spawn:run}),code("LOCAL_API_ENDPOINT_UNSAFE"));
  assert.equal(invoked,false);
});
