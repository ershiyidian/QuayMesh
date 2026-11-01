import {useReadonlyDatabases} from '../db/client.js';
import {assertAllowedPath} from '../roots.js';
import {parseConsoleReadRequest,consoleReadFailureCode,type ConsoleReadRequest} from './read-protocol.js';
import {CONSOLE_READ_REQUEST_BYTES,CONSOLE_READ_RESULT_BYTES} from './read-process.js';

// A dedicated sequential read process. Module imports stay warm between reads;
// no HTTP listener, execution manager or SessionRuntime is constructed here.
useReadonlyDatabases();
const output=process.stdout.write.bind(process.stdout);
console.log=console.info=console.warn=console.error=console.debug=()=>{};

async function indexRead(input:ConsoleReadRequest):Promise<unknown> {
  const local=await import('./local-queries.js');
  switch(input.operation) {
    case 'metadata': return local.readLocalMetadata(input.config);
    case 'page': return local.readLocalPage(input.config,input.query??{});
    case 'task-index': return local.readLocalTaskIndex(input.config,input.at,input.scope);
    case 'task-state-index': return local.readLocalTaskStateIndex(input.config,input.at);
    case 'session-titles': return local.readLocalSessionTitles(input.config,input.scope);
    case 'run-summaries': return local.readLocalRunSummaries(input.config,input.ids??[]);
    case 'usage': return local.readLocalUsage(input.config,input.query??{},input.at);
    case 'overview-usage': return local.readLocalOverviewUsage(input.config,input.zone,input.at);
    case 'overview': return local.readLocalOverview(input.config,input.zone,input.at);
    default: throw new Error('invalid_read');
  }
}

async function execute(frame:Buffer):Promise<string> {
  let id:number|null=null;
  try {
    const envelope=JSON.parse(frame.toString('utf8')) as {id?:unknown;request?:unknown};
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)
      ||Object.keys(envelope).some(key=>!['id','request'].includes(key))
      ||!Number.isSafeInteger(envelope.id)||(envelope.id as number)<=0)throw new Error('invalid_frame');
    id=envelope.id as number;
    const input=parseConsoleReadRequest(envelope.request);
    if(input.query?.root){
      try{assertAllowedPath(input.query.root,input.config.allowedRoots);}
      catch{throw {code:'project_scope',status:403};}
    }
    let value:unknown;
    switch(input.operation) {
      case 'activity-calls': case 'activity-events': {
        const {readLocalActivity}=await import('./activity.js');
        value=readLocalActivity(input.config,input.operation==='activity-calls'?'calls':'events',{
          ...input.query,limit:Math.min(1_000_100,Math.max(1,Number(input.query?.limit)||100))});break;
      }
      case 'audit': {
        const {readConsoleAudit}=await import('./audit-read.js');
        value=await readConsoleAudit(input.config,{q:input.query?.q,limit:Number(input.query?.limit)||100,offset:0});break;
      }
      case 'project-sessions': {
        if(input.ids?.length!==1)throw new Error('invalid_read');
        const {readProjectSessions}=await import('./project-sessions-read.js');
        value=readProjectSessions(input.config,input.ids[0]!);break;
      }
      case 'task-message-state': {
        if(input.ids?.length!==1)throw new Error('invalid_read');
        const {readTaskMessageState}=await import('./read-task-state.js');
        value=readTaskMessageState(input.config,input.ids[0]!);break;
      }
      case 'detail': {
        if(input.ids?.length!==1)throw new Error('invalid_read');
        const {readConsoleDetail}=await import('./detail-read-model.js');
        value=await readConsoleDetail(input.config,{kind:'detail',runId:input.ids[0]!},input.fence);break;
      }
      case 'file-diff': case 'patch': case 'command-output': {
        if(input.ids?.length!==1)throw new Error('invalid_read');
        const {readConsoleDetail}=await import('./detail-read-model.js');
        const common={runId:input.ids[0]!,cursor:input.cursor,expectedTaskId:input.expectedTaskId,expectedSessionId:input.expectedSessionId};
        const request=input.operation==='file-diff'?{...common,kind:'file-diff' as const,fileId:input.fileId!}
          :input.operation==='command-output'?{...common,kind:'command-output' as const,commandId:input.commandId!}
          :{...common,kind:'patch' as const};
        value=await readConsoleDetail(input.config,request,input.fence);break;
      }
      default: value=await indexRead(input);
    }
    const encoded=JSON.stringify({id,ok:true,value});
    return Buffer.byteLength(encoded)>CONSOLE_READ_RESULT_BYTES?JSON.stringify({id,ok:false,code:'console_read_too_large'}):encoded;
  }catch(error){
    // Never return raw native/SQLite errors, stacks, paths or request contents.
    return JSON.stringify({id,ok:false,code:consoleReadFailureCode(error)});
  }
}

async function writeFrame(value:string):Promise<void> {
  await new Promise<void>((resolve,reject)=>output(value+'\n',error=>error?reject(error):resolve()));
}

let chunks:Buffer[]=[],size=0;
try {
  for await(const raw of process.stdin) {
    const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
    let offset=0;
    while(offset<chunk.length) {
      const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline;
      const part=chunk.subarray(offset,end);size+=part.length;
      if(size>CONSOLE_READ_REQUEST_BYTES)throw new Error('oversized_frame');
      chunks.push(part);
      if(newline<0)break;
      const frame=Buffer.concat(chunks);chunks=[];size=0;
      await writeFrame(await execute(frame));
      offset=newline+1;
    }
  }
  if(size)process.exitCode=1;
}catch{
  // A broken parent pipe or malformed oversized transport ends only this reader.
  process.exitCode=1;
}
