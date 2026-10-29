import type {CommandSummary,FileSummary} from "../../session/types.js";
import {parseFilePatch} from "./diff.js";
import type {SessionCardSource} from "./source.js";
import {
  applyCommandOutput,appendPage,applySnapshot,diffCacheKey,resetAfterRevert,
  selectedCommands,type CardState,
} from "./state.js";
import type {CardContinuationResult,CardIntent,CardView} from "./view.js";
import {needsLocalTimer,refreshDelay} from "./timing.js";
import {createTaskMessagesController} from "./message-controller.js";
import {createTaskResumeController} from "./task-resume-controller.js";
import {applyTaskBinding,canContinueTask} from "./task-binding.js";
import {createPendingMessageState,type PendingMessageState} from "./pending-message-state.js";

export interface CardController {
  start():void;
  pollOnce():Promise<void>;
  handleIntent(intent:CardIntent):Promise<unknown>;
  setTheme(theme:"light"|"dark"):void;
  dispose():void;
}

const MAX_OUTPUT_BATCH=8;
const MAX_PATCH_BYTES=4*1024*1024;
const MAX_FIRST_SNAPSHOT_FAILURES=3;

export function createCardController(state:CardState,renderer:CardView,source:SessionCardSource,doc:Document=document,
  pendingState:PendingMessageState=createPendingMessageState(()=>(doc.defaultView as (Window&{openai?:unknown})|null)?.openai)):CardController {
  let stopped=false,started=false,snapshotRead:Promise<void>|null=null,request:AbortController|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined,elapsed:ReturnType<typeof setInterval>|undefined;
  let retryDelay=0,retryAt=0,observer:IntersectionObserver|undefined;
  let firstSnapshotRecorded=false,firstSnapshotFailures=0,lastVisibility: boolean|null=null,renderFailed=false;
  const visible=()=>!stopped&&!renderFailed&&!doc.hidden&&state.inViewport;
  function draw(action:()=>void):void{
    if(renderFailed)return;
    try{action();}catch(error){
      renderFailed=true;state.connection='error';clearTimeout(timer);clearInterval(elapsed);request?.abort('SESSION_CARD_RENDER_FAILED');messages.visibilityChanged();
      const target=doc.getElementById('card');
      if(target){
        const title=doc.createElement('strong'),message=doc.createElement('p');
        title.textContent=state.snapshot?.title??'QuayMesh';message.textContent='卡片显示失败，已保存的执行结果仍可在 Console 查看。';
        target.replaceChildren(title,message);target.dataset.status='unavailable';
        const url=state.snapshot?.consoleUrl;
        if(url&&/^https?:\/\//i.test(url)){const link=doc.createElement('a');link.href=url;link.textContent='打开 Console';link.target='_blank';link.rel='noopener noreferrer';target.append(link);}
      }
      state.message=messageOf(error);void recordStage('error');
    }
  }
  const view:CardView={render:()=>draw(()=>renderer.render()),renderPanel:()=>draw(()=>renderer.renderPanel()),
    renderFooter:()=>draw(()=>renderer.renderFooter()),fillTimers:()=>draw(()=>renderer.fillTimers()),dispose:()=>renderer.dispose()};
  const messages=createTaskMessagesController(state,source,()=>visible()&&!state.taskResume.busy,()=>view.renderPanel(),pendingState);
  const binding=createTaskResumeController(state,source,()=>{view.renderFooter();view.renderPanel();},
    ()=>{clearTimeout(timer);request?.abort("SESSION_CARD_BINDING_ACTION");messages.visibilityChanged();},()=>schedule());

  const canReadSnapshot=()=>firstSnapshotRecorded||firstSnapshotFailures<MAX_FIRST_SNAPSHOT_FAILURES;

  function schedule():void {
    clearTimeout(timer);
    if(!visible()||!source.live||state.taskResume.busy)return;
    const interval=refreshDelay(state.snapshot,state.collapsed);
    if(interval===null&&firstSnapshotRecorded)return;
    const mailbox=messages.canRefresh();
    if(!canReadSnapshot()&&(!mailbox||interval===null))return;
    // Coordinator messages do not inherit a worker snapshot's retry delay or exhausted handshake budget.
    timer=setTimeout(tick,mailbox?interval??5000:Math.max(interval??5000,retryAt-Date.now()));
  }

  function updateElapsedTimer():void {
    clearInterval(elapsed);
    if(!visible()||!needsLocalTimer(state.snapshot))return;
    elapsed=setInterval(()=>view.fillTimers(),1000);
  }

  async function requestSnapshot(signal:AbortSignal):Promise<void> {
    const previousConnection=state.connection;
    try {
      const next=await source.snapshot(state.snapshot?.rev??-1,signal,state.selectedMemberId??undefined);
      if(signal.aborted||stopped)return;
      // The first full reply negotiates fields omitted from legacy bootstrap metadata.
      const changed=next ? applySnapshot(state,next,{acceptSameRevision:!firstSnapshotRecorded}).snapshot : false;
      messages.restorePending();
      if(source.live&&!firstSnapshotRecorded&&!changed)throw new Error("SESSION_CARD_FIRST_SNAPSHOT_UNCONFIRMED");
      if(next&&changed&&!firstSnapshotRecorded){firstSnapshotRecorded=true;void recordStage("first_snapshot");}
      state.connection=source.live?"live":"static";state.lastConfirmedAt=Date.now();
      const bindingChanged=binding.sync();
      retryDelay=0;retryAt=0;
      if(changed)view.render();
      else if(bindingChanged){view.renderFooter();view.renderPanel();}
      updateElapsedTimer();
      await refreshOpenCommandOutputs();
    } catch(error) {
      if(!signal.aborted&&!stopped){
        if(state.taskResume.available&&applyTaskBinding(state,null))view.renderPanel();
        if(source.live&&!firstSnapshotRecorded)firstSnapshotFailures++;
        const exhausted=!firstSnapshotRecorded&&firstSnapshotFailures>=MAX_FIRST_SNAPSHOT_FAILURES;
        state.connection=exhausted?"unconfirmed":"error";
        if(exhausted&&state.snapshot){
          state.snapshot={...state.snapshot,capabilities:{...state.snapshot.capabilities,continue:false,revert:false}};
          view.render();
        }
        retryDelay=Math.min(Math.max(5000,retryDelay*2),30000);
        const supplied=(error as {retryAfterMs?:number})?.retryAfterMs;
        retryAt=Date.now()+(typeof supplied==="number"?Math.max(supplied,retryDelay):retryDelay);
        if(previousConnection!=="error")void recordStage("error");
      }
    } finally {if(!stopped&&state.connection!==previousConnection)view.renderFooter();}
  }

  function readSnapshot():Promise<void> {
    if(snapshotRead)return snapshotRead;
    request=new AbortController();
    snapshotRead=requestSnapshot(request.signal).finally(()=>{request=null;snapshotRead=null;schedule();});
    return snapshotRead;
  }

  function refreshResources():Array<Promise<void>> {
    if(!visible()||state.taskResume.busy){schedule();return [];}
    clearTimeout(timer);
    const pending:Array<Promise<void>>=[];
    if(snapshotRead)pending.push(snapshotRead);
    else if(canReadSnapshot()&&Date.now()>=retryAt)pending.push(readSnapshot());
    if(messages.canRefresh())pending.push(messages.poll());
    // Keep one timer ticking even when one resource is still pending. Each reader owns its single flight.
    schedule();
    return pending;
  }

  function tick():void {refreshResources();}
  function pollOnce():Promise<void> {return Promise.all(refreshResources()).then(()=>{});}

  async function handleIntent(intent:CardIntent):Promise<unknown>{
    if(stopped)throw new Error("SESSION_CARD_CONTROLLER_DISPOSED");
    switch(intent.type){
      case "file_diff":return loadDiff(intent.file);
      case "command_outputs":return loadCommandOutputs(intent.commands);
      case "instruction":return loadInstruction(intent.path);
      case "load_more":return loadMore(intent.kind);
      case "copy_patch":return loadCompletePatch();
      case "revert":return revert(intent.expectedRev);
      case "open_link":return source.openLink(intent.url);
      case "display_mode":return false;
      case "continue_session":{
        if(state.busy)return {sent:false,reason:"busy"} satisfies CardContinuationResult;
        if(state.taskResume.available&&!canContinueTask(state))throw new Error("TASK_BINDING_NOT_CONFIRMED: 请先确认并恢复此任务的关联。");
        state.busy=true;view.renderFooter();view.renderPanel();
        try{await source.continueSession(intent.agentId);return {sent:true} satisfies CardContinuationResult;}
        finally{state.busy=false;if(!stopped){view.renderFooter();view.renderPanel();}}
      }
      case "inspect_task_binding":return binding.inspect();
      case "resume_task":return binding.resume();
      case "request_host_resume":return binding.requestHost();
      case "task_messages":return messages.refresh(intent.beforeSequence);
      case "send_task_message":return messages.send();
      case "tab_changed":messages.visibilityChanged();schedule();return state.tab==="messages"?messages.refresh():undefined;
    }
  }

  async function loadDiff(file:FileSummary):Promise<void>{
    const key=diffCacheKey(file),loading=`diff:${key}`;
    if(state.loading.has(loading)||state.diffCache.has(key))return;
    state.loading.add(loading);
    try{const page=await source.fileDiff(file.id,file.hash);state.diffCache.set(key,page.patch?{rows:parseFilePatch(page.patch)}:{note:page.note??"无文本差异"});}
    catch(error){state.diffCache.set(key,{error:messageOf(error)});}
    finally{state.loading.delete(loading);view.renderPanel();}
  }

  async function loadCommandOutputs(commands:CommandSummary[]):Promise<void>{
    const pending=commands.filter(command=>command.status!=="queued"&&!state.loading.has(`out:${command.id}`)&&!state.outputCache.get(command.id)?.done).slice(0,MAX_OUTPUT_BATCH);
    if(!pending.length)return;
    for(const command of pending)state.loading.add(`out:${command.id}`);
    try{
      const rows=await source.commandOutputs(pending.map(command=>({command_id:command.id,member_id:command.member_id,cursor:state.outputCache.get(command.id)?.cursor??0})));
      for(const row of rows){
        const previous=state.outputCache.get(row.command_id)??{text:"",cursor:0,done:false};
        if(row.error)state.outputCache.set(row.command_id,{...previous,error:row.error});
        else if(typeof row.chunk==="string"&&typeof row.cursor==="number"&&typeof row.done==="boolean")
          applyCommandOutput(state,row.command_id,{chunk:row.chunk,cursor:row.cursor,done:row.done,truncated:row.truncated,retained_from:row.retained_from});
      }
    }catch(error){for(const command of pending){const previous=state.outputCache.get(command.id)??{text:"",cursor:0,done:false};state.outputCache.set(command.id,{...previous,error:messageOf(error)});}}
    finally{for(const command of pending)state.loading.delete(`out:${command.id}`);view.renderPanel();}
  }

  async function refreshOpenCommandOutputs():Promise<void>{
    if(state.collapsed||!visible()||state.tab!=="commands")return;
    const commands=selectedCommands(state).filter(command=>state.openCommands.has(command.id));
    await loadCommandOutputs(commands);
  }

  async function loadInstruction(path:string):Promise<void>{
    if(state.instructionCache.has(path)||state.loading.has(`ins:${path}`))return;
    state.loading.add(`ins:${path}`);
    try{const result=await source.instruction(path);state.instructionCache.set(path,{content:result.content??""});}
    catch(error){state.instructionCache.set(path,{error:messageOf(error)});}
    finally{state.loading.delete(`ins:${path}`);view.renderPanel();}
  }

  async function loadMore(kind:"files"|"commands"|"agents"):Promise<void>{
    if(state.loadingMore)return;const cursor=state.pageCursors[kind];if(!cursor)return;
    state.loadingMore=true;
    try{const page=await source.snapshot(state.snapshot?.rev??-1,undefined,state.selectedMemberId??undefined,cursor);if(page)appendPage(state,page,kind);binding.sync();}
    finally{state.loadingMore=false;view.renderFooter();view.renderPanel();}
  }

  async function loadCompletePatch():Promise<string>{
    let page=await source.patch(undefined),text=page.patch,pages=1;
    while(!page.done&&page.cursor){
      if(new TextEncoder().encode(text).byteLength>=MAX_PATCH_BYTES||pages>=128)throw new Error("PATCH_COPY_LIMIT_EXCEEDED");
      page=await source.patch(page.cursor);text+=page.patch;pages++;
    }
    return text;
  }

  async function revert(expectedRev:number):Promise<void>{
    await source.revert(expectedRev);resetAfterRevert(state);
    const next=await source.snapshot(-1);if(next)applySnapshot(state,next);
    binding.sync();
    view.render();updateElapsedTimer();
  }

  function visibilityChanged():void{
    clearInterval(elapsed);
    messages.visibilityChanged();
    const current=visible();
    if(lastVisibility!==current){lastVisibility=current;void recordStage(current?"visible":"hidden",{visible:current});}
    if(!current){clearTimeout(timer);request?.abort("SESSION_CARD_NOT_VISIBLE");return;}
    view.fillTimers();updateElapsedTimer();tick();
  }
  const expanded=()=>{messages.visibilityChanged();if(state.collapsed)schedule();else tick();};
  function start():void{
    if(stopped)throw new Error("SESSION_CARD_CONTROLLER_DISPOSED");
    if(started)return;
    started=true;
    view.render();updateElapsedTimer();
    void recordStage("mount");
    void recordStage("initialized");
    doc.addEventListener("visibilitychange",visibilityChanged);doc.addEventListener("quaymesh:card-expanded",expanded);
    const target=doc.getElementById("card"),Constructor=doc.defaultView?.IntersectionObserver;
    if(Constructor&&target){observer=new Constructor(entries=>{const intersecting=entries.at(-1)?.isIntersecting??true;if(intersecting===state.inViewport)return;state.inViewport=intersecting;visibilityChanged();});observer.observe(target);}
    visibilityChanged();
  }
  function dispose():void{
    if(stopped)return;
    void recordStage("teardown");
    stopped=true;clearTimeout(timer);clearInterval(elapsed);observer?.disconnect();request?.abort("SESSION_CARD_DISPOSED");
    messages.dispose();
    binding.dispose();
    doc.removeEventListener("visibilitychange",visibilityChanged);doc.removeEventListener("quaymesh:card-expanded",expanded);
    view.dispose();source.dispose();state.diffCache.clear();state.outputCache.clear();state.instructionCache.clear();
  }
  return{start,pollOnce,handleIntent,setTheme(theme){doc.body.dataset.theme=theme;},dispose};

  async function recordStage(stage:"mount"|"initialized"|"first_snapshot"|"visible"|"hidden"|"teardown"|"error",options?:{visible?:boolean}):Promise<void>{
    try{await source.widgetStage(stage,{displayMode:state.hostDisplayMode,...options});}
    catch(error){console.warn("QuayMesh 卡片阶段记录失败",stage,error);}
  }
}

function messageOf(error:unknown):string{return error instanceof Error?error.message:String(error);}
