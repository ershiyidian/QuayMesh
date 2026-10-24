import { activityAgeText, cardPresentation, commandTiming, durationText, hasBackground, type CardStatus } from "./timing.js";
import type { AgentSummary, CommandSummary, FileSummary, InstructionSummary, Snapshot } from "../../session/types.js";
import { safeConsoleUrl } from "../console/validation.js";
import { escapeCode, parseFilePatch } from "./diff.js";
import {
  applyCommandOutput, appendPage, applySnapshot, diffCacheKey, resetAfterRevert,
  selectedAgents, selectedCommands, selectedFiles, selectedInstructions,
  type CardState, type CardTab,
} from "./state.js";

export type CardIntent=
  |{type:"file_diff";file:FileSummary}
  |{type:"command_outputs";commands:CommandSummary[]}
  |{type:"instruction";path:string}
  |{type:"load_more";kind:"files"|"commands"|"agents"}
  |{type:"copy_patch"}
  |{type:"revert";expectedRev:number}
  |{type:"open_link";url:string}
  |{type:"display_mode";mode:"inline"|"fullscreen"}
  |{type:"continue_session";agentId?:string};
export type CardIntentHandler=(intent:CardIntent)=>Promise<unknown>;

export interface CardView {
  render(): void;
  renderPanel(): void;
  renderFooter(): void;
  fillTimers(): void;
  dispose(): void;
}

const OUTPUT_TAIL = 200;

export function createCardView(doc: Document, state: CardState, onIntent:CardIntentHandler): CardView {
  const card=required<HTMLElement>(doc,"#card");
  const header=required<HTMLElement>(doc,"#hd");
  const details=required<HTMLElement>(doc,"#details");
  const tabs=required<HTMLElement>(doc,"#tabs");
  let noteTimer:ReturnType<typeof setTimeout>|undefined;
  let revertTimer:ReturnType<typeof setTimeout>|undefined;

  const click=(event:MouseEvent)=>{
    const target=event.target;
    if(!(target instanceof Element))return;
    const action=target.closest<HTMLElement>("[data-act]");
    if(action){void handleAction(action.dataset.act??"",action).catch(error=>note(errorMessage(error)));return;}
    const expandable=target.closest<HTMLElement>("[data-x]");
    if(expandable){void toggleDetail(expandable.dataset.x??"");return;}
    const copy=target.closest<HTMLElement>("[data-copy]");
    if(copy)void copyText(copy.dataset.copy??"").then(ok=>note(ok?"已复制":"宿主拒绝访问剪贴板"));
  };
  const headerClick=(event:MouseEvent)=>{
    if(event.target instanceof Element&&event.target.closest("button"))return;
    if(doc.getSelection()?.toString())return;
    void toggleCard().catch(error=>note(errorMessage(error)));
  };
  const keydown=(event:KeyboardEvent)=>{
    const target=event.target;
    if(!(target instanceof Element)||!target.matches(".tab"))return;
    const list=$$<HTMLButtonElement>(".tab",tabs);
    const index=list.indexOf(target as HTMLButtonElement);
    const next={ArrowRight:index+1,ArrowLeft:index-1,Home:0,End:list.length-1}[event.key];
    if(next===undefined)return;
    event.preventDefault();
    const button=list[(next+list.length)%list.length];
    if(button){state.tab=(button.dataset.tab??"changes") as CardTab;render();button.focus();}
  };
  card.addEventListener("click",click);
  header.addEventListener("click",headerClick);
  tabs.addEventListener("keydown",keydown);

  function render():void {
    const snapshot=state.snapshot;
    card.classList.toggle("collapsed",state.collapsed);
    details.hidden=state.collapsed;
    details.inert=state.collapsed;
    const toggle=required<HTMLButtonElement>(doc,"#toggle");
    toggle.setAttribute("aria-expanded",String(!state.collapsed));
    toggle.setAttribute("aria-label",state.collapsed?"展开详情":"收起详情");
    if(!snapshot){required<HTMLElement>(doc,"#title").textContent="正在读取任务…";return;}
    renderSummary(snapshot);
    renderActions(snapshot);
    renderTabs(snapshot);
    if(!state.collapsed)renderPanel();
    fillTimers();
  }

  function renderSummary(snapshot:Snapshot):void {
    const now=cardNow(state),presentation=cardPresentation(snapshot,now);
    card.dataset.status=presentation.status;
    const statusElement=required<HTMLElement>(doc,"#stIc");
    if(statusElement.dataset.status!==presentation.status){statusElement.innerHTML=statusIcon(presentation.status);statusElement.dataset.status=presentation.status;}
    setText(required<HTMLElement>(doc,"#title"),snapshot.title);
    required<HTMLElement>(doc,"#title").title=snapshot.sourceTaskId?`接续任务 ${snapshot.sourceTaskId}`:snapshot.title;
    const workspace=snapshot.workspaces[0];
    const ws=required<HTMLElement>(doc,"#ws");
    setText(ws,workspace?`${snapshot.sourceTaskId?"接续 · ":""}${workspace.node_id}/${shortPath(workspace.root)}`:"等待工作区");
    ws.title=snapshot.workspaces.map(item=>`${item.node_id}: ${item.root}`).join("\n");
    const running=snapshot.runningCommand??snapshot.commands.find(command=>command.status==="run"||command.status==="queued")??null;
    const lastCommand=snapshot.lastCommand??snapshot.currentCommand??null;
    const activity=required<HTMLElement>(doc,"#act");
    const label=running?.cmd??lastCommand?.cmd??snapshot.lastOperation?.label??presentation.label;
    activity.className=`act${running?" mono":""}${["stalled","failed","unavailable","finalizing","archived"].includes(presentation.status)?" tone":""}`;
    if(snapshot.taskState==='closed')
      setText(activity,`${presentation.label}${presentation.backgroundLabel?` · ${presentation.backgroundLabel}`:''}`);
    else if(presentation.status==='idle'||presentation.status==='stalled'||presentation.status==='unavailable')
      setText(activity,presentation.label);
    else if(presentation.status==="running")
      setText(activity,`${presentation.label} · ${label}`);
    else setText(activity,`${presentation.label}${label&&label!==presentation.label?` · ${label}`:""}`);
    activity.title=label;
    const files=selectedFiles(state),adds=total(files,"additions"),dels=total(files,"removals");
    const stats=required<HTMLElement>(doc,"#stats"),statsMarkup=`<span class="nf">${snapshot.totals.files} 文件</span><span>${snapshot.totals.commands} 命令</span>${snapshot.totals.agents?`<span>${snapshot.totals.agents} 代理</span>`:""}<span class="add mono">+${adds??"?"}</span><span class="del mono">−${dels??"?"}</span>`;
    if(stats.innerHTML!==statsMarkup)stats.innerHTML=statsMarkup;
    const clock=required<HTMLElement>(doc,"#clock");
    setText(clock,presentation.taskElapsedMs===null?"耗时未确认":`${presentation.taskClockLabel} ${durationText(Math.floor(presentation.taskElapsedMs/1000)*1000)}`);
    clock.title=presentation.taskClockLabel;
    clock.dataset.dynamic=String(presentation.taskClockDynamic);
    const prog=required<HTMLElement>(doc,"#prog");
    setText(prog,`最近活动 ${activityAgeText(presentation.activityAgeMs)}`);
    const bar=required<HTMLElement>(doc,"#bar");
    bar.classList.toggle("indet",presentation.commandClockDynamic);
    bar.style.setProperty("--p",snapshot.taskResult||snapshot.closureReason?"1":"0");
    if(state.connection==="error"){
      prog.textContent=`更新延迟 · 上次确认 ${activityAgeText(now-presentation.confirmedAt)}`;
      prog.title=`正在重新读取状态；上次确认 ${new Date(presentation.confirmedAt).toLocaleString()}`;
    }else if(presentation.observationStale){
      prog.textContent=`${presentation.status==='running'?'部分状态待更新 · ':''}上次确认 ${activityAgeText(now-presentation.confirmedAt)}`;
      prog.title=new Date(presentation.confirmedAt).toLocaleString();
    }else if(snapshot.host_status==='disconnected'){
      prog.textContent=['running','queued'].includes(presentation.backgroundStatus)?'节点连接异常 · 仍有后台执行'
        :snapshot.taskState==='closed'&&snapshot.taskResult?'节点暂不可达 · 交付结果已保存':'节点暂不可达';
      prog.title='';
    }else if(snapshot.taskState!=='closed'&&snapshot.finalization&&presentation.status==='running'){
      prog.textContent=snapshot.finalization.state==='failed'?'交付确认失败':'交付确认中';
      prog.title=snapshot.finalization.error??'';
    }else prog.title='';
  }

  function renderActions(snapshot:Snapshot):void {
    const box=required<HTMLElement>(doc,"#acts"),parts:string[]=[];
    if(snapshot.totals.files>0)parts.push(`<button class="ib" data-act="copy-patch" aria-label="复制补丁" title="复制补丁">${icon("copy")}</button>`);
    const url=safeConsoleUrl(snapshot.consoleUrl??undefined);
    if(url)parts.push(`<button class="ib" data-act="review" data-url="${esc(url)}" aria-label="打开完整详情" title="打开完整详情">${icon("max")}</button>`);
    if(snapshot.capabilities.revert&&!hasBackground(snapshot)&&snapshot.totals.files>0){
      parts.push(`<button class="ib${state.revertArmed?" confirm":""}" data-act="revert" aria-label="${state.revertArmed?"确认撤销全部修改":"撤销全部修改"}" title="撤销全部修改">${state.revertArmed?"确认撤销":icon("stop")}</button>`);
    }
    const markup=parts.join("");if(box.innerHTML!==markup)box.innerHTML=markup;
  }

  function renderTabs(snapshot:Snapshot):void {
    required<HTMLElement>(doc,"#n-changes").textContent=String(snapshot.totals.files);
    required<HTMLElement>(doc,"#n-commands").textContent=String(snapshot.totals.commands);
    required<HTMLElement>(doc,"#n-agents").textContent=String(snapshot.totals.agents);
    required<HTMLElement>(doc,"#n-commands").classList.toggle("bad",selectedCommands(state).some(item=>item.status==="fail"&&!item.supersededBy));
    const buttons=$$<HTMLButtonElement>(".tab",tabs);
    for(const button of buttons){const active=button.dataset.tab===state.tab;button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;}
    const active=buttons.find(button=>button.dataset.tab===state.tab);
    const indicator=required<HTMLElement>(doc,"#ind");
    if(active)indicator.style.transform=`translateX(${active.offsetLeft+8}px) scaleX(${Math.max(0,active.offsetWidth-16)/100})`;
    for(const panel of $$<HTMLElement>(".panel",details))panel.hidden=panel.id!==`p-${state.tab}`;
  }

  function renderPanel():void {
    if(state.collapsed||!state.inViewport||doc.hidden||!state.snapshot)return;
    const panel=required<HTMLElement>(doc,`#p-${state.tab}`);
    const markup=panelMarkup();
    if(panel.innerHTML!==markup){panel.innerHTML=markup;panel.classList.remove("enter");void panel.offsetWidth;panel.classList.add("enter");}
  }

  function panelMarkup():string {
    if(state.tab==="changes")return changesMarkup();
    if(state.tab==="commands")return commandsMarkup();
    if(state.tab==="agents")return agentsMarkup();
    return contextMarkup();
  }

  function changesMarkup():string {
    const files=selectedFiles(state),more=moreButton("files",state.pageCursors.files);
    if(!files.length)return `<div class="empty">暂无修改</div>${more}`;
    return files.map(file=>{
      const key=`f:${file.id}`,open=state.openFiles.has(file.id),path=normalizePath(file.path),split=path.lastIndexOf("/")+1;
      const cached=state.diffCache.get(diffCacheKey(file));
      let body="";
      if(open){
        if(file.binary)body='<div class="code"><div class="x">二进制文件，无文本差异</div></div>';
        else if(!cached)body='<div class="code"><div class="x">正在读取修改…</div></div>';
        else if(cached.error)body=`<div class="code"><div class="x">${esc(cached.error)}</div></div>`;
        else body=`<div class="code">${(cached.rows??[]).map(row=>`<div class="${row.kind==="add"?"a":row.kind==="delete"?"d":row.kind==="header"?"h":""}">${esc(row.text)||" "}</div>`).join("")||'<div class="x">无文本差异</div>'}</div>`;
      }
      return `<div class="grp"><button class="row" data-x="${key}" aria-expanded="${open}">${icon("chev","chev")}<span class="fs ${file.status}">${file.status}</span><span class="path" title="${esc(file.path)}"><span class="dir">${esc(path.slice(0,split))}</span>${esc(path.slice(split))}</span><span class="num"><span class="add">+${file.additions??"?"}</span> <span class="del">−${file.removals??"?"}</span></span></button>${body}</div>`;
    }).join("")+more;
  }

  function commandsMarkup():string {
    const commands=[...selectedCommands(state)].reverse(),more=moreButton("commands",state.pageCursors.commands);
    if(!commands.length)return `<div class="empty">暂无命令</div>${more}`;
    return commands.map(command=>{
      const key=`c:${command.id}`,open=state.openCommands.has(command.id),output=state.outputCache.get(command.id);
      const body=!open?"":!output?'<div class="code"><div class="x">正在读取输出…</div></div>':commandOutputMarkup(output.text,output.error,output.truncated,output.retainedFrom);
      const timing=commandTiming(state.snapshot!,command,cardNow(state));
      const duration=commandDurationLabel(command,timing);
      const displayedStatus=command.status==='run'&&!timing.dynamic?'unknown':command.status;
      return `<div class="grp"><button class="row" data-x="${key}" aria-expanded="${open}" ${command.status==="queued"?"disabled":""}>${icon("chev","chev")}<span class="cs ${statusClass(displayedStatus)}">${commandIcon(displayedStatus)}</span><span class="path" title="${esc(command.cmd)}">${esc(command.cmd)}</span><time class="num" data-command-id="${esc(command.id)}">${duration}</time></button>${body}</div>`;
    }).join("")+more;
  }

  function agentsMarkup():string {
    const agents=selectedAgents(state).filter(agent=>agent.role!=="main"),more=moreButton("agents",state.pageCursors.agents);
    if(!agents.length)return `<div class="empty">没有子代理</div>${more}`;
    return agents.map(agent=>`<div class="ag"><span class="dot ${agentDot(agent.state)}"></span><b>${esc(agent.name||agent.id)}</b><span class="mono num">${esc(agent.model??agent.provider)}</span><span class="task" title="${esc(agent.task)}">${esc(agent.task)}</span><span class="s">${agentLabel(agent.state)}</span></div>`).join("")+more;
  }

  function contextMarkup():string {
    const snapshot=state.snapshot;if(!snapshot)return"";
    const rows:Array<[string,string]>=[["Session",snapshot.sessionId],["Task",snapshot.taskId??""],["状态",cardPresentation(snapshot,cardNow(state)).label]];
    for(const workspace of snapshot.workspaces)rows.push([workspace.node_id,workspace.root]);
    let html=rows.map(([key,value])=>kv(key,value)).join("");
    const instructions=selectedInstructions(state);
    if(instructions.length)html+=instructions.map(instructionMarkup).join("");
    if(snapshot.skills.length)html+=snapshot.skills.map(skill=>kv(`Skill · ${skill.state}`,`${skill.name}${skill.description?` · ${skill.description}`:""}`)).join("");
    return html||'<div class="empty">暂无上下文</div>';
  }

  function instructionMarkup(instruction:InstructionSummary):string {
    const key=`i:${instruction.path}`,open=instruction.status==="loaded"&&state.openInstructions.has(instruction.path),cached=state.instructionCache.get(instruction.path);
    const body=!open?"":!cached?'<div class="code"><div class="x">正在读取指令…</div></div>':`<div class="code"><div>${esc(cached.error??cached.content??"")}</div></div>`;
    return `<div class="grp"><button class="row" data-x="${esc(key)}" aria-expanded="${open}" ${instruction.status!=="loaded"?"disabled":""}>${instruction.status==="loaded"?icon("chev","chev"):"<span style=\"width:14px\"></span>"}<span class="path">${esc(instruction.path)}</span><span class="num">${instruction.status==="loaded"?"已读取":"按需"}</span></button>${body}</div>`;
  }

  async function handleAction(action:string,button:HTMLElement):Promise<void>{
    if(action==="toggle"){await toggleCard();return;}
    if(action==="tab"){state.tab=(button.dataset.tab??"changes") as CardTab;render();return;}
    if(action==="copy-patch"){const text=await onIntent({type:"copy_patch"});note(await copyText(String(text??""))?`已复制补丁 · ${(String(text??"").length/1024).toFixed(1)} KB`:"宿主拒绝访问剪贴板");return;}
    if(action==="review"){const url=safeConsoleUrl(button.dataset.url??state.snapshot?.consoleUrl??undefined);if(url)await onIntent({type:"open_link",url});return;}
    if(action==="revert"){await revert();return;}
    if(action==="more"){await onIntent({type:"load_more",kind:button.dataset.kind as "files"|"commands"|"agents"});return;}
    if(action==="continue-session"){await onIntent({type:"continue_session",agentId:button.dataset.id});note("已发送继续请求");}
  }

  async function toggleDetail(key:string):Promise<void>{
    if(key.startsWith("f:")){const id=key.slice(2),opening=!state.openFiles.has(id);toggleSet(state.openFiles,id);renderPanel();if(opening){const file=selectedFiles(state).find(item=>item.id===id);if(file)await onIntent({type:"file_diff",file});}return;}
    if(key.startsWith("c:")){const id=key.slice(2),opening=!state.openCommands.has(id);toggleSet(state.openCommands,id);renderPanel();if(opening){const command=selectedCommands(state).find(item=>item.id===id);if(command)await onIntent({type:"command_outputs",commands:[command]});}return;}
    if(key.startsWith("i:")){const path=key.slice(2),opening=!state.openInstructions.has(path);toggleSet(state.openInstructions,path);renderPanel();if(opening)await onIntent({type:"instruction",path});return;}
    renderPanel();
  }

  async function toggleCard():Promise<void>{
    if(state.hostDisplayMode==="inline"&&state.collapsed){
      // A host may decline fullscreen; keep the compact inline fallback functional.
      try{await onIntent({type:"display_mode",mode:"fullscreen"});}catch{/* Host support is optional. */}
    }else if(state.hostDisplayMode==="fullscreen"&&!state.collapsed){
      try{await onIntent({type:"display_mode",mode:"inline"});}catch{/* Host support is optional. */}
    }
    state.collapsed=!state.collapsed;
    if(!state.collapsed){details.classList.remove("enter");void details.offsetWidth;details.classList.add("enter");}
    render();doc.dispatchEvent(new Event("quaymesh:card-expanded"));
  }

  async function revert():Promise<void>{
    const snapshot=state.snapshot;if(!snapshot)return;
    if(!state.revertArmed){state.revertArmed=true;clearTimeout(revertTimer);revertTimer=setTimeout(()=>{state.revertArmed=false;renderActions(snapshot);},3000);renderActions(snapshot);return;}
    state.revertArmed=false;clearTimeout(revertTimer);if(snapshot.changeRev==null)throw new Error("改动版本尚未取得");
    await onIntent({type:"revert",expectedRev:snapshot.changeRev});note("已撤销全部修改");
  }

  function fillTimers():void{
    const snapshot=state.snapshot;if(!snapshot)return;
    renderSummary(snapshot);
    const now=cardNow(state);
    const commands=new Map(selectedCommands(state).map(command=>[command.id,command]));
    for(const timer of doc.querySelectorAll<HTMLElement>("[data-command-id]")){
      const command=commands.get(timer.dataset.commandId??'');if(!command)continue;
      const timing=commandTiming(snapshot,command,now);
      setText(timer,commandDurationLabel(command,timing));
      timer.title=timing.confirmed?'命令耗时':'截至最近确认，正在核对结果';
      const status=command.status==='run'&&!timing.dynamic?'unknown':command.status;
      const statusElement=timer.parentElement?.querySelector<HTMLElement>('.cs');
      if(statusElement){statusElement.className=`cs ${statusClass(status)}`;const markup=commandIcon(status);if(statusElement.innerHTML!==markup)statusElement.innerHTML=markup;}
    }
  }

  function renderFooter():void{if(state.snapshot){renderSummary(state.snapshot);renderActions(state.snapshot);}}
  function note(message:string):void{
    required<HTMLElement>(doc,"#live").textContent=message;
    clearTimeout(noteTimer);
    noteTimer=setTimeout(()=>{required<HTMLElement>(doc,"#live").textContent="";},2200);
  }
  function dispose():void{
    card.removeEventListener("click",click);header.removeEventListener("click",headerClick);tabs.removeEventListener("keydown",keydown);
    clearTimeout(noteTimer);clearTimeout(revertTimer);
  }
  return{render,renderPanel,renderFooter,fillTimers,dispose};
}

function statusIcon(status:CardStatus):string{return status==="running"||status==="finalizing"?icon("run","spin"):status==="stalled"||status==="unavailable"?icon("warn"):status==="failed"?icon("fail"):status==="success"?icon("ok"):status==="cancelled"||status==="archived"?icon("stop"):icon("run");}
function statusClass(status:CommandSummary["status"]):string{return status==="run"||status==="queued"?"running":status==="ok"?"ok":status==="fail"?"failed":"cancelled";}
function commandIcon(status:CommandSummary["status"]):string{return status==="run"?icon("run","spin"):status==="ok"?icon("ok"):status==="fail"?icon("fail"):status==='unknown'?icon('warn'):icon("stop");}
function agentDot(status:AgentSummary["state"]):string{return status==="working"?"working":status==="done"?"done":status==="failed"?"failed":"";}
function agentLabel(status:AgentSummary["state"]):string{return{queued:"排队",working:"工作中",done:"已完成",failed:"失败",cancelled:"已停止",unknown:"未知"}[status];}
function total(files:FileSummary[],field:"additions"|"removals"):number|null{return files.some(file=>file[field]===null)?null:files.reduce((sum,file)=>sum+(file[field]??0),0);}
function commandOutputMarkup(text:string,error?:string,truncated?:boolean,retainedFrom?:number):string{
  const lines=text.split("\n"),tail=lines.slice(-OUTPUT_TAIL),cut=Math.max(0,lines.length-tail.length);
  return `<div class="code">${cut?`<div class="x">… 省略前 ${cut} 行</div>`:""}${tail.map(line=>`<div>${esc(line)||" "}</div>`).join("")}${truncated?`<div class="x">输出从 byte ${retainedFrom??0} 开始保留</div>`:""}${error?`<div class="x">${esc(error)}</div>`:""}</div>`;
}
function moreButton(kind:string,cursor:string|null):string{return cursor?`<div class="empty"><button class="ib" data-act="more" data-kind="${kind}">读取更多</button></div>`:"";}
function kv(key:string,value:string):string{return `<div class="kv"><span class="k">${esc(key)}</span><span class="v" title="${esc(value)}">${esc(value)}</span><button class="ib" data-copy="${esc(value)}" aria-label="复制">${icon("copy")}</button></div>`;}
function toggleSet(set:Set<string>,value:string):void{set.has(value)?set.delete(value):set.add(value);}
function icon(name:string,extra=""):string{return `<svg class="i ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;}
function normalizePath(value:string):string{return value.replaceAll("\\","/");}
function shortPath(value:string):string{return normalizePath(value).split("/").filter(Boolean).at(-1)??value;}
async function copyText(value:string):Promise<boolean>{try{await navigator.clipboard.writeText(value);return true;}catch{return false;}}
function required<T extends Element>(doc:Document,selector:string):T{const value=doc.querySelector<T>(selector);if(!value)throw new Error(`SESSION_CARD_ELEMENT_MISSING: ${selector}`);return value;}
function $$<T extends Element>(selector:string,root:ParentNode):T[]{return[...root.querySelectorAll<T>(selector)];}
function esc(value:unknown):string{return escapeCode(String(value??""));}
function errorMessage(error:unknown):string{return error instanceof Error?error.message:String(error);}
function cardNow(state:CardState):number{const candidate=Date.now()+state.clockOffsetMs;state.lastNowMs=Math.max(state.lastNowMs,candidate);return state.lastNowMs;}

function setText(element:HTMLElement,value:string):void{if(element.textContent!==value)element.textContent=value;}

function commandDurationLabel(command:CommandSummary,timing:ReturnType<typeof commandTiming>):string {
  if(timing.elapsedMs===null)return command.status==='queued'?'尚未开始':'耗时待核对';
  return `${timing.confirmed?'耗时':'已确认耗时'} ${durationText(timing.elapsedMs)}`;
}
