import type {CommandSummary,FileSummary} from "../../session/types.js";
import {parseFilePatch} from "./diff.js";
import type {SessionCardSource} from "./source.js";
import {
  applyCommandOutput,appendPage,applySnapshot,diffCacheKey,resetAfterRevert,
  selectedCommands,type CardState,
} from "./state.js";
import type {CardIntent,CardView} from "./view.js";
import {needsLocalTimer,refreshDelay} from "./timing.js";

export interface CardController {
  start():void;
  pollOnce():Promise<void>;
  handleIntent(intent:CardIntent):Promise<unknown>;
  setTheme(theme:"light"|"dark"):void;
  dispose():void;
}

const MAX_OUTPUT_BATCH=8;
const MAX_PATCH_BYTES=4*1024*1024;

export function createCardController(state:CardState,view:CardView,source:SessionCardSource,doc:Document=document):CardController {
  let stopped=false,polling:Promise<void>|null=null,request:AbortController|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined,elapsed:ReturnType<typeof setInterval>|undefined;
  let retryDelay=0,retryAt=0,observer:IntersectionObserver|undefined;
  let firstSnapshotRecorded=false,lastVisibility: boolean|null=null;
  const visible=()=>!stopped&&!doc.hidden&&state.inViewport;

  function schedule():void {
    clearTimeout(timer);
    if(!visible()||!source.live)return;
    const interval=refreshDelay(state.snapshot,state.collapsed);
    if(interval===null)return;
    timer=setTimeout(()=>void pollOnce(),Math.max(interval,retryAt-Date.now()));
  }

  function updateElapsedTimer():void {
    clearInterval(elapsed);
    if(!visible()||!needsLocalTimer(state.snapshot))return;
    elapsed=setInterval(()=>view.fillTimers(),1000);
  }

  async function requestSnapshot():Promise<void> {
    request=new AbortController();const signal=request.signal;
    try {
      const next=await source.snapshot(state.snapshot?.rev??-1,signal,state.selectedMemberId??undefined);
      if(signal.aborted||stopped)return;
      state.connection=source.live?"live":"static";state.lastConfirmedAt=Date.now();
      if(next){applySnapshot(state,next);if(!firstSnapshotRecorded){firstSnapshotRecorded=true;void recordStage("first_snapshot");}}
      retryDelay=0;retryAt=0;view.render();updateElapsedTimer();
      await refreshOpenCommandOutputs();
    } catch(error) {
      if(!signal.aborted&&!stopped){
        state.connection="error";
        retryDelay=Math.min(Math.max(5000,retryDelay*2),30000);
        const supplied=(error as {retryAfterMs?:number})?.retryAfterMs;
        retryAt=Date.now()+(typeof supplied==="number"?Math.max(supplied,retryDelay):retryDelay);
        void recordStage("error");
      }
    } finally {request=null;if(!stopped)view.renderFooter();}
  }

  function pollOnce():Promise<void> {
    if(polling)return polling;
    if(!visible()||Date.now()<retryAt){schedule();return Promise.resolve();}
    clearTimeout(timer);
    polling=requestSnapshot().finally(()=>{polling=null;schedule();});
    return polling;
  }

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
      case "continue_session":return source.continueSession(intent.agentId);
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
    try{const page=await source.snapshot(state.snapshot?.rev??-1,undefined,state.selectedMemberId??undefined,cursor);if(page)appendPage(state,page,kind);}
    finally{state.loadingMore=false;view.renderPanel();}
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
    view.render();updateElapsedTimer();
  }

  function visibilityChanged():void{
    clearInterval(elapsed);
    const current=visible();
    if(lastVisibility!==current){lastVisibility=current;void recordStage(current?"visible":"hidden",{visible:current});}
    if(!current){clearTimeout(timer);request?.abort("SESSION_CARD_NOT_VISIBLE");return;}
    view.fillTimers();updateElapsedTimer();void pollOnce();
  }
  const expanded=()=>{if(state.collapsed)schedule();else void pollOnce();};
  function start():void{
    view.render();updateElapsedTimer();
    void recordStage("mount");
    void recordStage("initialized");
    doc.addEventListener("visibilitychange",visibilityChanged);doc.addEventListener("quaymesh:card-expanded",expanded);
    const target=doc.getElementById("card"),Constructor=doc.defaultView?.IntersectionObserver;
    if(Constructor&&target){observer=new Constructor(entries=>{const intersecting=entries.at(-1)?.isIntersecting??true;if(intersecting===state.inViewport)return;state.inViewport=intersecting;visibilityChanged();});observer.observe(target);}
    visibilityChanged();
  }
  function dispose():void{
    void recordStage("teardown");
    stopped=true;clearTimeout(timer);clearInterval(elapsed);observer?.disconnect();request?.abort("SESSION_CARD_DISPOSED");
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
