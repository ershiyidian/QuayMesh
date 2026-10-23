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
const descendant=mode==="command"?spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:process.platform!=="win32",stdio:"ignore"}):undefined;
descendant?.unref();
process.send({type:"ready",pid:process.pid,start:processStartIdentity(process.pid),runId:run.id,executionId,operationId,
  agentId:agent.id,claimId:claim.id,descendantPid:descendant?.pid});
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
    process.send!({type:"reply",id:message.id,pid:process.pid,start:processStartIdentity(process.pid)});
    if (message.action==="abandon" || message.action==="persist_completion") process.exit(0);
    if (message.action==="close") {
      claim.release();coordinator.close();agents.close();ledger.close();process.disconnect?.();
    }
  } catch(error) {process.send!({type:"error",id:message.id,message:String(error)});}
});
