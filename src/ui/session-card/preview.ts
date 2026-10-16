import {ExecutionState,HostState,ReviewState,type Snapshot} from "../../session/types.js";
import type {SessionCardSource} from "./source.js";

const now=Date.now();
const operationId="op_preview_verify";

export const previewSnapshot:Snapshot={
  sessionId:"preview-session",
  taskId:"task_preview_card",
  rev:12,
  changeRev:7,
  title:"恢复可靠性与卡片修改并完成提交",
  status:"running",
  execution_status:ExecutionState.active,
  review_status:ReviewState.unknown,
  host_status:HostState.connected,
  taskState:"active",
  taskResult:null,
  startedAt:now-5*60_000-34_000,
  endedAt:null,
  observedAt:now,
  lastActivityAt:now-11_000,
  consoleUrl:null,
  workspace:{id:"preview-member",node_id:"desktop",workspace_id:"preview-workspace",online:true,observedAt:now,
    root:"E:\\Chromium-GPT\\QuayMesh",sourceRoot:null,branch:"master",baseRef:null,baseSha:null,dirtySource:false,mode:"local"},
  workspaces:[{id:"preview-member",node_id:"desktop",workspace_id:"preview-workspace",root:"E:\\Chromium-GPT\\QuayMesh",
    source_root:null,mode:"checkout",first_seen_at:new Date(now-360_000).toISOString(),last_observed_at:new Date(now).toISOString(),online:true,revision:12,recovery_root:"E:\\Chromium-GPT\\QuayMesh"}],
  files:[
    file("f1","M","src/ui/session-card/view.ts",48,20),
    file("f2","M","src/ui/session-card/controller.ts",32,18),
    file("f3","A","src/ui/session-card/timing.ts",34,0),
    file("f4","M","src/session/output.ts",26,8),
    file("f5","A","docs/RELIABILITY.md",86,0),
  ],
  commands:[
    command(operationId,"node .planning/reliability-delivery/verify.mjs browser","run",now-42_000,null,null),
    command("op_typecheck","pnpm typecheck","ok",now-80_000,now-71_000,0),
    command("op_build","pnpm build","ok",now-100_000,now-94_000,0),
  ],
  agents:[
    {id:"agent-review",member_id:"preview-member",role:"subagent",name:"Codex reviewer",provider:"codex",model:"gpt-5.6",effort:null,state:"working",task:"检查持久输出与断线恢复",tokens:null,usage_quality:"unavailable",startedAt:now-120_000,endedAt:null,steps:null,result_available:false,result_ref:null},
    {id:"agent-ui",member_id:"preview-member",role:"subagent",name:"UI reviewer",provider:"codex",model:"gpt-5.6",effort:null,state:"done",task:"检查折叠卡片与窄屏布局",tokens:null,usage_quality:"unavailable",startedAt:now-180_000,endedAt:now-45_000,steps:null,result_available:true,result_ref:"preview-agent-result"},
  ],
  instructions:[{path:"AGENTS.md",status:"available",actor_id:"host",source:"workspace",observed_at:null,content_ref:null}],
  skills:[{name:"planning-with-files",description:"Persistent plan files for long work.",path:"~/.codex/skills/planning-with-files/SKILL.md",actor_id:"host",state:"available",uses:null}],
  totals:{files:5,commands:3,agents:2},cursors:{files:null,commands:null,agents:null},
  capabilities:{refresh:true,revert:false,continue:true,open_file:true},notices:[],
  currentCommand:command(operationId,"node .planning/reliability-delivery/verify.mjs browser","run",now-42_000,null,null),
  lastOperation:{operation_id:operationId,member_id:"preview-member",kind:"command",label:"node .planning/reliability-delivery/verify.mjs browser",state:"running",startedAt:now-42_000,endedAt:null},
};

const diffs:Record<string,string>={
  f1:"@@ card header @@\n+ designer compact header\n+ task elapsed time\n+ current activity\n- legacy expanded header\n",
  f2:"@@ polling @@\n+ hidden/offscreen stop\n+ terminal stops polling\n",
  f3:"+ export function elapsedText(ms) { ... }\n",
  f4:"@@ output @@\n+ durable absolute cursor\n",
  f5:"+ # 长任务可靠性说明\n",
};
const outputs:Record<string,string>={
  [operationId]:"Running 9 tests using 1 worker\n[7/9] ✓ card reliability\n[8/9] ✓ a11y\n",
  op_typecheck:"Process exited with code 0.\n",
  op_build:"Build completed in 5.8s.\n",
};

export function createPreviewSource():SessionCardSource{
  return {
    live:false,
    async snapshot(){return null;},
    async fileDiff(fileId){return{patch:diffs[fileId]??"",cursor:null,done:true};},
    async commandOutput(commandId,cursor){const text=outputs[commandId]??"";return{chunk:text.slice(cursor),cursor:text.length,done:true};},
    async commandOutputs(requests){return requests.map(({command_id,cursor})=>{const text=outputs[command_id]??"";return{command_id,chunk:text.slice(cursor),cursor:text.length,done:true};});},
    async instruction(){return{content:"# AGENTS.md\n\n生产主模型默认不自动读取；此处仅演示按需查看。\n"};},
    async patch(){return{patch:Object.values(diffs).join("\n"),cursor:null,done:true};},
    async revert(){throw new Error("PREVIEW_READ_ONLY");},
    async openFile(){throw new Error("PREVIEW_READ_ONLY");},
    async openLink(){throw new Error("PREVIEW_READ_ONLY");},
    async continueSession(){throw new Error("PREVIEW_READ_ONLY");},
    async widgetStage(){},
    dispose(){},
  };
}

function file(id:string,status:"A"|"M"|"D"|"R",path:string,additions:number,removals:number){
  return{id,member_id:"preview-member",status,path,from:null,additions,removals,hash:`preview-${id}`,large:false,binary:false,coverage:"session_owned" as const,revertible:false};
}
function command(id:string,cmd:string,status:"run"|"ok",startedAt:number,endedAt:number|null,exitCode:number|null){
  return{id,operation_id:id,member_id:"preview-member",cmd,agent:"host",status,startedAt,endedAt,exitCode,signal:null,attempt:1,supersededBy:null,summary:null,output_ref:id,output_available:true};
}
