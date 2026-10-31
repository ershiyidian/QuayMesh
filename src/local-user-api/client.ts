import {randomUUID} from "node:crypto";
import {createConnection} from "node:net";
import {lstat,realpath} from "node:fs/promises";
import {dirname,isAbsolute,resolve} from "node:path";
import {LOCAL_USER_API_PROTOCOL,LOCAL_USER_API_MAX_FRAME_BYTES,localApiParams,type LocalUserApiMethod} from "./protocol.js";
import {createWindowsLocalPipe} from "./windows-pipe.js";

export interface LocalUserConnection {endpoint:string;credential:string;}
export class LocalUserClientError extends Error {
  constructor(readonly code:string,message:string,readonly effect:"not_started"|"unknown"="not_started",readonly details?:unknown){
    super(message);this.name="LocalUserClientError";
  }
}
export function validLocalEndpoint(endpoint:unknown,platform:NodeJS.Platform=process.platform):endpoint is string{
  if(typeof endpoint!=="string"||!endpoint||endpoint.includes("\0")||endpoint.length>2048)return false;
  return platform==="win32" ? endpoint.length<=500&&/^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(endpoint) : isAbsolute(endpoint);
}
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const failure=(code:string,message:string,effect:"not_started"|"unknown"="not_started")=>new LocalUserClientError(code,message,effect);

/** Remove credentials even if a broken endpoint echoes one in a result/error.
 * Keys need the same treatment as values. Business payloads remain JSON values. */
export function redactLocalCredentials(value:unknown):unknown{
  const clean=(text:string)=>text.replace(/qml1_[A-Za-z0-9_-]{43}/g,"[redacted]");
  if(typeof value==="string")return clean(value);
  if(Array.isArray(value))return value.map(redactLocalCredentials);
  if(object(value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[clean(key),redactLocalCredentials(item)]));
  return value;
}

async function verifyUnixEndpoint(endpoint:string):Promise<void>{
  if(process.platform==="win32")return;
  try{
    const parent=dirname(endpoint),[directory,socket]=await Promise.all([lstat(parent),lstat(endpoint)]),uid=process.getuid?.();
    if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==uid||(directory.mode&0o077)!==0
      ||!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==uid||(socket.mode&0o077)!==0
      ||await realpath(parent)!==resolve(parent))
      throw failure("LOCAL_API_ENDPOINT_UNSAFE","The local API socket and its directory must be private and owned by this OS user.");
  }catch(error){
    if(error instanceof LocalUserClientError)throw error;
    throw failure("LOCAL_API_UNAVAILABLE","The local API is unavailable. Check that the installed service is running.");
  }
}

/** Dedicated local IPC only. A failed read never starts the service, falls back
 * to an owner credential, or retries a peer mutation with a different key. */
export class LocalUserClient {
  readonly #endpoint:string;
  readonly #credential:string;
  constructor(connection:LocalUserConnection,private readonly options:{requestTimeoutMs?:number;watchIdleTimeoutMs?:number}={}){
    if(!validLocalEndpoint(connection.endpoint))throw failure("LOCAL_API_INVALID_ENDPOINT","The local API endpoint must be a local pipe or Unix socket.");
    if(!/^qml1_[A-Za-z0-9_-]{43}$/.test(connection.credential))throw failure("LOCAL_API_INVALID_CREDENTIAL","The local API credential is invalid.");
    this.#endpoint=connection.endpoint;this.#credential=connection.credential;
  }

  async request(method:Exclude<LocalUserApiMethod,"events.watch">,params:Record<string,unknown>={},signal?:AbortSignal):Promise<unknown>{
    let result:unknown;
    for await(const frame of this.frames(method,params,signal))result=frame;
    return result;
  }

  watch(params:Record<string,unknown>,signal?:AbortSignal):AsyncGenerator<unknown>{
    return this.frames("events.watch",params,signal);
  }

  private async *frames(method:LocalUserApiMethod,params:Record<string,unknown>,signal?:AbortSignal):AsyncGenerator<unknown>{
    if(signal?.aborted)throw failure("LOCAL_API_ABORTED","The local API request was cancelled.");
    try{localApiParams(method,params);}catch{throw failure("LOCAL_API_INVALID_REQUEST","The local API method or parameters are invalid.");}
    await verifyUnixEndpoint(this.#endpoint);
    if(signal?.aborted)throw failure("LOCAL_API_ABORTED","The local API request was cancelled.");
    const id=randomUUID(),watch=method==="events.watch";
    const frame=Buffer.from(JSON.stringify({protocol:LOCAL_USER_API_PROTOCOL,id,credential:this.#credential,method,params})+"\n");
    if(frame.length>LOCAL_USER_API_MAX_FRAME_BYTES)throw failure("LOCAL_API_REQUEST_TOO_LARGE","The request exceeds the local API frame budget.");
    const socket=process.platform==="win32"?createWindowsLocalPipe(this.#endpoint):createConnection({path:this.#endpoint});
    let sent=false,complete=false,buffer=Buffer.alloc(0),timer:ReturnType<typeof setTimeout>|undefined;
    let stopped:LocalUserClientError|undefined;
    const effect=()=>sent&&method.startsWith("peer.")?"unknown" as const:"not_started" as const;
    const stop=(error:LocalUserClientError)=>{if(!stopped)stopped=error;socket.destroy();};
    const arm=(ms:number)=>{clearTimeout(timer);timer=setTimeout(()=>stop(failure("LOCAL_API_TIMEOUT","The local API did not respond in time.",effect())),ms);};
    const abort=()=>stop(failure("LOCAL_API_ABORTED","The local API request was cancelled.",effect()));
    signal?.addEventListener("abort",abort,{once:true});
    if(signal?.aborted)abort();
    arm(this.options.requestTimeoutMs??10_000);
    socket.once("connect",()=>{if(stopped)return;sent=true;socket.write(frame,error=>{if(error)stop(failure("LOCAL_API_CONNECTION_FAILED","The local API connection was interrupted.",effect()));});});
    try{
      for await(const chunk of socket){
        if(stopped)break;
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        // Each chunk may contain several bounded frames. Never concatenate an
        // unbounded response before checking the individual line budget.
        let offset=0;
        while(offset<bytes.length){
          const newline=bytes.indexOf(10,offset),end=newline<0?bytes.length:newline;
          if(buffer.length+end-offset+(newline<0?0:1)>LOCAL_USER_API_MAX_FRAME_BYTES)
            throw failure("LOCAL_API_INVALID_RESPONSE","The local API response exceeded its frame budget.",effect());
          buffer=Buffer.concat([buffer,bytes.subarray(offset,end)]);offset=newline<0?bytes.length:newline+1;
          if(newline<0)continue;
          let value:unknown;
          try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));}
          catch{throw failure("LOCAL_API_INVALID_RESPONSE","The local API returned an invalid response.",effect());}
          buffer=Buffer.alloc(0);
          if(!object(value)||value.protocol!==LOCAL_USER_API_PROTOCOL||value.id!==id||typeof value.ok!=="boolean"||typeof value.done!=="boolean")
            throw failure("LOCAL_API_INVALID_RESPONSE","The local API returned an unexpected response.",effect());
          if(value.ok===false){
            if(value.done!==true||!object(value.error)||typeof value.error.code!=="string"||!/^[A-Z0-9_]{1,96}$/.test(value.error.code)||typeof value.error.message!=="string")
              throw failure("LOCAL_API_INVALID_RESPONSE","The local API returned an invalid error response.",effect());
            throw new LocalUserClientError(value.error.code,String(redactLocalCredentials(value.error.message)).slice(0,2048),effect(),redactLocalCredentials(value.error.details));
          }
          if(!Object.hasOwn(value,"result")||(!watch&&!value.done))
            throw failure("LOCAL_API_INVALID_RESPONSE","The local API response does not match the requested method.",effect());
          complete=value.done;
          if(watch&&!complete)arm(this.options.watchIdleTimeoutMs??45_000);else clearTimeout(timer);
          yield redactLocalCredentials(value.result);
          if(complete)return;
        }
      }
      if(stopped)throw stopped;
      if(!complete)throw failure("LOCAL_API_CONNECTION_CLOSED","The local API connection ended before the response completed.",effect());
    }catch(error){
      if(stopped)throw stopped;
      if(error instanceof LocalUserClientError)throw error;
      if((error as {code?:unknown}|null)?.code==="LOCAL_API_ENDPOINT_UNSAFE")
        throw failure("LOCAL_API_ENDPOINT_UNSAFE","The connected local API pipe server is not owned by this Windows user.",effect());
      throw failure("LOCAL_API_UNAVAILABLE","The local API is unavailable. Check that the installed service is running.",effect());
    }finally{
      clearTimeout(timer);signal?.removeEventListener("abort",abort);socket.destroy();frame.fill(0);buffer.fill(0);
    }
  }
}
