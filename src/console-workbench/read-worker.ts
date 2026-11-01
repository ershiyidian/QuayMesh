import {useReadonlyDatabases} from '../db/client.js';
import {assertAllowedPath} from '../roots.js';
import {parseConsoleReadRequest,consoleReadFailureCode} from './read-protocol.js';
import {CONSOLE_READ_REQUEST_BYTES, CONSOLE_READ_RESULT_BYTES} from './read-process.js';

// A one-request process, with no HTTP listener, execution manager, SessionRuntime
// or FederationRuntime. Query modules are loaded only after readonly mode is set.
useReadonlyDatabases();
const output=process.stdout.write.bind(process.stdout);
console.log=console.info=console.warn=console.error=console.debug=()=>{};

try {
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin) {
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=bytes.length;
    if(size>CONSOLE_READ_REQUEST_BYTES)throw new Error('invalid_read');
    chunks.push(bytes);
  }
  const input=parseConsoleReadRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if(input.query?.root){
    try{assertAllowedPath(input.query.root,input.config.allowedRoots);}
    catch{throw {code:'project_scope',status:403};}
  }
  const local=await import('./local-queries.js');
  let value:unknown;
  switch(input.operation) {
    case 'metadata': value=local.readLocalMetadata(input.config); break;
    case 'page': value=local.readLocalPage(input.config,input.query??{}); break;
    case 'task-index': value=local.readLocalTaskIndex(input.config,input.at); break;
    case 'session-titles': value=local.readLocalSessionTitles(input.config); break;
    case 'run-summaries': value=local.readLocalRunSummaries(input.config,input.ids??[]); break;
    case 'usage': value=local.readLocalUsage(input.config,input.query??{},input.at); break;
    case 'overview-usage': value=local.readLocalOverviewUsage(input.config,input.zone,input.at); break;
    case 'overview': value=local.readLocalOverview(input.config,input.zone,input.at); break;
    case 'activity-calls': case 'activity-events': {
      const {readLocalActivity}=await import('./activity.js');
      value=readLocalActivity(input.config,input.operation==='activity-calls'?'calls':'events',{
        ...input.query,limit:Math.min(1_000_100,Math.max(1,Number(input.query?.limit)||100))});break;
    }
    case 'task-message-state': {
      if(input.ids?.length!==1)throw new Error('invalid_read');
      const {readTaskMessageState}=await import('./read-task-state.js');
      value=readTaskMessageState(input.config,input.ids[0]!);break;
    }
  }
  const encoded=JSON.stringify({ok:true,value});
  const response=Buffer.byteLength(encoded)>CONSOLE_READ_RESULT_BYTES ? JSON.stringify({ok:false,code:'console_read_too_large'}) : encoded;
  await new Promise<void>((resolve,reject)=>output(response,error=>error?reject(error):resolve()));
} catch(error) {
  // No raw SQLite error, stack, path, request or credential is sent or logged.
  await new Promise<void>(resolve=>output(JSON.stringify({ok:false,code:consoleReadFailureCode(error)}),()=>resolve()));
}
