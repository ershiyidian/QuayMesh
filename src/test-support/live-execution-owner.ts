import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WorkLedger } from "../work-ledger.js";
import { LocalAgentStore } from "../local-agent-store.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { processStartIdentity } from "../process-identity.js";

const [stateDir,mode="agent"]=process.argv.slice(2);
if (!stateDir || !process.send) throw new Error("Owner fixture requires its own state directory and IPC channel.");
const root=join(stateDir,"project");mkdirSync(root,{recursive:true});
const ledger=new WorkLedger(stateDir),agents=new LocalAgentStore(stateDir),coordinator=new ExecutionCoordinator(stateDir);
const run=ledger.begin({root,workspaceId:"ws",workItemId:"fixture",runKey:"owner",title:"Live owner",
  origin:{entryPoint:"qm_cli",evidence:"server_entry"}});
const operationId=ledger.operation({runId:run.id,requestKey:"command",kind:"command",label:"Owned command",status:"running"});
const agent=agents.create({workspaceRoot:root,workspaceId:"ws",profileName:"fixture",provider:"codex"});
const executionId=mode==="agent"?ledger.beginExecution({runId:run.id,agentId:agent.id,provider:"codex"}):undefined;
const turn=executionId?agents.beginTurn(agent.id,{prompt:"Local owner fixture"}).turn:undefined;
if (executionId) {ledger.requestStarted(executionId);ledger.observeAgent(agent.id);}
const claim=coordinator.acquire({workspaceRoot:root,kind:mode==="agent"?"agent":"command",
  ...(executionId?{agentId:agent.id}:{}),operationId});
// This fixture deliberately leaves a real orphan. On Windows, unref alone
// does not let a non-detached child survive its owner's exit.
const descendant=mode==="command"?spawn(process.execPath,["-e",`
  setInterval(()=>{},1000);
  setTimeout(()=>process.exit(0),30_000);
  process.send({type:'descendant-ready',pid:process.pid,parentPid:process.ppid},error=>{
    if(error)throw error;
    process.disconnect();
  });
`],{detached:true,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]}):undefined;
if (descendant) {
  try {
    await new Promise<void>((resolve,reject)=>{
      let ready=false;
      const timer=setTimeout(()=>finish(new Error("Descendant fixture readiness timed out")),5_000);
      const onMessage=(value:any)=>{
        if(value.type!=="descendant-ready" || value.pid!==descendant.pid || value.parentPid!==process.pid) {
          finish(new Error("Descendant fixture returned an unexpected process identity"));return;
        }
        ready=true;
      };
      const onDisconnect=()=>finish(ready?undefined:new Error("Descendant disconnected before readiness"));
      const onExit=(code:number|null,signal:string|null)=>finish(new Error(`Descendant exited before readiness: ${code}/${signal}`));
      const onError=(error:Error)=>finish(error);
      function finish(error?:Error) {
        clearTimeout(timer);descendant!.off("message",onMessage);descendant!.off("disconnect",onDisconnect);
        descendant!.off("exit",onExit);descendant!.off("error",onError);
        error?reject(error):resolve();
      }
      descendant.on("message",onMessage);descendant.once("disconnect",onDisconnect);
      descendant.once("exit",onExit);descendant.once("error",onError);
    });
  } catch(error) {descendant.kill();throw error;}
  // The readiness IPC is already closed, so it cannot retain the owner.
  descendant.unref();
}
process.send({type:"ready",pid:process.pid,start:processStartIdentity(process.pid),runId:run.id,executionId,operationId,
  agentId:agent.id,claimId:claim.id,descendantPid:descendant?.pid,
  descendantStart:descendant?.pid?processStartIdentity(descendant.pid):null});
process.on("message",(message:{id:number;action:string})=>{
  try {
    if (message.action==="complete" || message.action==="persist_completion") {
      if (executionId && turn) {
        ledger.providerFinished(executionId);ledger.saveResponse(executionId,"durable completed response");
        const result=agents.finishTurnResult(agent.id,turn.id,{status:"completed",response:"durable completed response"});
        if (result.isErr()) throw result.error;
        if (message.action==="complete") ledger.endExecution(executionId,"completed");
      }
      ledger.endOperation(operationId,"completed");if (message.action==="complete") claim.release();
    }
    if (message.action==="cancel") {
      if (executionId) {ledger.endExecution(executionId,"cancelled");ledger.endExecution(executionId,"completed");}
      ledger.endOperation(operationId,"cancelled");ledger.endOperation(operationId,"completed");claim.release();
    }
    process.send!({type:"reply",id:message.id,pid:process.pid,start:processStartIdentity(process.pid)},error=>{
      if(error)throw error;
      if (message.action==="abandon" || message.action==="persist_completion") process.exit(0);
      if (message.action==="close") {
        claim.release();coordinator.close();agents.close();ledger.close();process.disconnect?.();
      }
    });
  } catch(error) {process.send!({type:"error",id:message.id,message:String(error)});}
});
