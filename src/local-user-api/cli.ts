import type {Readable,Writable} from "node:stream";
import {LocalUserClient,LocalUserClientError,redactLocalCredentials,type LocalUserConnection} from "./client.js";
import {importLocalUserEnrollment,localClientAlias,localUserConfigDirectory,readLocalUserDiscovery,resolveLocalUserConnection,type LocalCredentialVault} from "./credentials.js";
import {localApiParams,type LocalUserApiMethod} from "./protocol.js";

type ParsedCommand={kind:"help"}|{kind:"import";client:string;configDir?:string}
  |{kind:"request";client?:string;configDir?:string;method:LocalUserApiMethod;params:Record<string,unknown>;bodyFromStdin?:true};
const invalid=(message:string)=>new LocalUserClientError("LOCAL_API_INVALID_ARGUMENT",message);
const valueOptions=new Set(["client","config-dir","cursor","limit","message-key","reply-to","request-key","after-sequence","message-id"]);
const booleanOptions=new Set(["stdin","help","json"]);
const own=(record:Record<string,string[]>,key:string)=>Object.hasOwn(record,key);

/** Parse the eight fixed local methods only. Unknown identity/authentication
 * flags are rejected before opening discovery, a vault, stdin or an IPC pipe. */
export function parseLocalUserApiArgs(argv:readonly string[]):ParsedCommand{
  const words:string[]=[],options:Record<string,string[]>=Object.create(null) as Record<string,string[]>;
  for(let i=0;i<argv.length;i++){
    const argument=argv[i]!;
    if(argument==="-h"){if(own(options,"help"))throw invalid("An option was supplied more than once.");options.help=["true"];continue;}
    if(!argument.startsWith("--")){words.push(argument);continue;}
    const equal=argument.indexOf("="),name=argument.slice(2,equal<0?undefined:equal);
    if(!valueOptions.has(name)&&!booleanOptions.has(name))throw invalid("Unsupported option. Credentials and source Task identities are not command-line options.");
    if(own(options,name)&&name!=="message-id")throw invalid("An option was supplied more than once.");
    let value:string;
    if(booleanOptions.has(name)){
      if(equal>=0)throw invalid("This flag does not accept a value.");value="true";
    }else{
      value=equal>=0?argument.slice(equal+1):argv[++i]!;
      if(value===undefined)throw invalid("An option is missing its value.");
    }
    (options[name]??=[]).push(value);
  }
  const [namespace,group,action,...rest]=words;
  if(namespace!=="local"&&namespace!=="client")throw invalid("Use quaymesh local or quaymesh client import.");
  if(own(options,"help")||words.length===1)return {kind:"help"};
  const only=(allowed:readonly string[])=>{
    if(Object.keys(options).some(name=>name!=="json"&&!allowed.includes(name)))throw invalid("This option is not supported by this command.");
  };
  const one=(name:string)=>options[name]?.[0];
  const integer=(name:string):number|undefined=>{
    const value=one(name);if(value===undefined)return undefined;
    if(!/^(?:0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(Number(value)))throw invalid("Expected a non-negative integer.");
    return Number(value);
  };
  const requireOption=(name:string)=>{const value=one(name);if(value===undefined)throw invalid("This command requires --"+name+".");return value;};
  const configDir=one("config-dir");
  if(namespace==="client"){
    only(["config-dir","stdin"]);
    if(group!=="import"||!action||rest.length||!own(options,"stdin"))throw invalid("Use quaymesh client import <alias> --stdin [--config-dir <directory>].");
    return {kind:"import",client:localClientAlias(action),...(configDir===undefined?{}:{configDir})};
  }
  const client=one("client");if(client!==undefined)localClientAlias(client);
  const common=["client","config-dir"];
  let method:LocalUserApiMethod,params:Record<string,unknown>={},bodyFromStdin:true|undefined;
  if(group==="status"){
    only(common);if(action!==undefined||rest.length)throw invalid("Status takes no positional arguments.");method="status.get";
  }else if(group==="tasks"&&action==="list"){
    only([...common,"cursor","limit"]);if(rest.length)throw invalid("Tasks list takes no positional arguments.");
    method="tasks.list";params={...(one("cursor")===undefined?{}:{cursor:one("cursor")}),...(one("limit")===undefined?{}:{limit:integer("limit")})};
  }else if(group==="tasks"&&action==="get"){
    only(common);if(rest.length!==1)throw invalid("Tasks get requires one Task ID.");method="tasks.get";params={task_id:rest[0]};
  }else if(group==="events"&&(action==="read"||action==="watch")){
    only([...common,"cursor","limit"]);if(rest.length!==1)throw invalid("Events read/watch requires one Task ID.");
    method=action==="read"?"events.read":"events.watch";
    params={task_id:rest[0],...(one("cursor")===undefined?{}:{cursor:one("cursor")}),...(one("limit")===undefined?{}:{limit:integer("limit")})};
  }else if(group==="peer"&&action==="send"){
    only([...common,"message-key","reply-to","stdin"]);
    if(rest.length!==1||!own(options,"stdin"))throw invalid("Peer send requires one target Task ID, --message-key, and --stdin for the message body.");
    method="peer.send";bodyFromStdin=true;
    params={target_task_id:rest[0],message_key:requireOption("message-key"),...(one("reply-to")===undefined?{}:{reply_to:one("reply-to")})};
  }else if(group==="peer"&&action==="receive"){
    only([...common,"request-key","after-sequence","limit"]);if(rest.length)throw invalid("Peer receive uses the source Task bound to its credential.");
    method="peer.receive";params={request_key:requireOption("request-key"),...(one("after-sequence")===undefined?{}:{after_sequence:integer("after-sequence")}),
      ...(one("limit")===undefined?{}:{limit:integer("limit")})};
  }else if(group==="peer"&&action==="ack"){
    only([...common,"message-id"]);if(rest.length!==1)throw invalid("Peer ack requires one delivery ID and exact --message-id values.");
    const ids=options["message-id"]??[];
    if(new Set(ids).size!==ids.length)throw invalid("A message ID was supplied more than once.");
    method="peer.ack";params={delivery_id:rest[0],message_ids:ids};
  }else throw invalid("Unknown local command. Run quaymesh local --help for the supported commands.");
  try{localApiParams(method,bodyFromStdin?{...params,body:"stdin pending"}:params);}
  catch{throw invalid("The command parameters are invalid or exceed the method's limit.");}
  return {kind:"request",method,params,...(client===undefined?{}:{client}),...(configDir===undefined?{}:{configDir}),...(bodyFromStdin?{bodyFromStdin}: {})};
}

export const LOCAL_USER_API_HELP=[
  "QuayMesh local API — JSON output; events watch emits one JSON result per line.",
  "",
  "  quaymesh local status [--client <alias>]",
  "  quaymesh local tasks list [--client <alias>] [--cursor <cursor>] [--limit 1..50]",
  "  quaymesh local tasks get <task-id> [--client <alias>]",
  "  quaymesh local events read|watch <task-id> [--client <alias>] [--cursor <cursor>] [--limit 1..100]",
  "  quaymesh local peer send <target-task-id> --message-key <key> --stdin [--reply-to <message-id>]",
  "  quaymesh local peer receive --request-key <key> [--after-sequence <n>] [--limit 1..8]",
  "  quaymesh local peer ack <delivery-id> --message-id <id> [--message-id <id> ...]",
  "  quaymesh client import <alias> --stdin [--config-dir <directory>]",
  "",
  "All commands accept --json (JSON is the default) and --config-dir for public IPC discovery.",
  "An enrolled client uses its OS credential vault; no plaintext fallback exists.",
  "An inherited Task credential uses QUAYMESH_LOCAL_API_ENDPOINT and",
  "QUAYMESH_LOCAL_API_CREDENTIAL together, without --client. It cannot choose a source Task.",
  "Peer methods require separate Task-bound capabilities and explicit stable request/message keys.",
  "Import expects the complete owner-issued enrollment on stdin and prints a non-secret receipt.",
  "These commands do not start the service, grant permissions, enqueue user messages, or invoke MCP tools.",
].join("\n")+"\n";

async function stdinText(input:Readable,limit:number,signal:AbortSignal):Promise<string>{
  if(signal.aborted)throw new LocalUserClientError("LOCAL_API_ABORTED","The local API request was cancelled.");
  const parts:Buffer[]=[];let size=0;
  const abort=()=>input.destroy(new LocalUserClientError("LOCAL_API_ABORTED","The local API request was cancelled."));
  signal.addEventListener("abort",abort,{once:true});
  try{
    for await(const chunk of input){
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
      if(size>limit)throw invalid("Standard input exceeds this command's byte limit.");parts.push(bytes);
    }
    try{return new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts));}
    catch{throw invalid("Standard input must be valid UTF-8.");}
  }finally{signal.removeEventListener("abort",abort);}
}

export interface LocalCliOptions {
  env?:NodeJS.ProcessEnv;stdin?:Readable;stdout?:Writable;stderr?:Writable;signal?:AbortSignal;vault?:LocalCredentialVault;
  resolveConnection?:(options:{client?:string;configDir:string;env:NodeJS.ProcessEnv;vault?:LocalCredentialVault})=>Promise<LocalUserConnection>;
}

export async function runLocalUserApiCli(argv:readonly string[],options:LocalCliOptions={}):Promise<number>{
  const env=options.env??process.env,input=options.stdin??process.stdin,output=options.stdout??process.stdout,errorOutput=options.stderr??process.stderr;
  const controller=new AbortController(),signal=options.signal??controller.signal,stop=()=>controller.abort();
  if(!options.signal){process.once("SIGINT",stop);process.once("SIGTERM",stop);}
  const write=(stream:Writable,text:string,cancellable=true)=>new Promise<void>((done,reject)=>{
    let settled=false;
    const cleanup=()=>{stream.removeListener("error",onError);signal.removeEventListener("abort",aborted);};
    const failed=(fromCallback=false)=>{if(settled)return;settled=true;signal.removeEventListener("abort",aborted);
      // Node emits the stream's error after calling the write callback. Keep
      // its once-listener until that event so an EPIPE cannot escape uncaught.
      if(!fromCallback)stream.removeListener("error",onError);
      reject(new LocalUserClientError("LOCAL_API_OUTPUT_FAILED","The command output could not be written."));};
    const onError=()=>failed();
    const aborted=()=>{if(settled)return;settled=true;signal.removeEventListener("abort",aborted);
      reject(new LocalUserClientError("LOCAL_API_ABORTED","The local API request was cancelled."));};
    if(cancellable&&signal.aborted){aborted();return;}
    stream.once("error",onError);if(cancellable)signal.addEventListener("abort",aborted,{once:true});
    stream.write(text,error=>{if(error){failed(true);return;}if(settled){cleanup();return;}settled=true;cleanup();done();});
  });
  const json=(stream:Writable,value:unknown,cancellable=true)=>write(stream,JSON.stringify(redactLocalCredentials(value))+"\n",cancellable);
  try{
    const command=parseLocalUserApiArgs(argv);
    if(command.kind==="help"){await write(output,LOCAL_USER_API_HELP);return 0;}
    const configDir=localUserConfigDirectory(command.configDir,env);
    if(command.kind==="import"){
      if(env.QUAYMESH_LOCAL_API_ENDPOINT!==undefined||env.QUAYMESH_LOCAL_API_CREDENTIAL!==undefined)
        throw new LocalUserClientError("LOCAL_API_AMBIGUOUS_CREDENTIAL","Import an enrolled user client outside an inherited Task credential environment.");
      const text=await stdinText(input,65_536,signal);let enrollment:unknown;
      try{enrollment=JSON.parse(text.replace(/^\uFEFF/,""));}catch{throw invalid("Standard input must contain one complete enrollment JSON object.");}
      const discovery=await readLocalUserDiscovery(configDir);
      const receipt=await importLocalUserEnrollment(command.client,enrollment,discovery,options.vault);
      await json(output,receipt);return 0;
    }
    if(command.bodyFromStdin)command.params.body=await stdinText(input,16_384,signal);
    try{localApiParams(command.method,command.params);}catch{throw invalid("The command parameters or message body are invalid.");}
    const connection=await (options.resolveConnection??resolveLocalUserConnection)({client:command.client,configDir,env,vault:options.vault});
    const client=new LocalUserClient(connection);
    if(command.method==="events.watch"){
      for await(const batch of client.watch(command.params,signal))await json(output,batch);
    }else await json(output,await client.request(command.method,command.params,signal));
    return 0;
  }catch(error){
    const safe=error instanceof LocalUserClientError?error:new LocalUserClientError("LOCAL_API_FAILED","The local API command failed without completing. No credential was printed or saved as plaintext.");
    try{await json(errorOutput,{ok:false,error:{code:safe.code,message:safe.message,effect:safe.effect,...(safe.details===undefined?{}:{details:safe.details})}},false);}catch{/* An unavailable output stream must not expose raw errors. */}
    return safe.code==="LOCAL_API_ABORTED"?130:1;
  }finally{
    if(!options.signal){process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);}
  }
}
