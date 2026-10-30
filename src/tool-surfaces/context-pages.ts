import { glob, opendir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { readContextFileAsync } from "../workspace-context.js";
import { replyBytes, REPLY_BYTES } from "../bounded-reply.js";
import { mapConcurrent } from "../concurrency.js";
import { currentInvocation } from "../session/invocations.js";
import type { ToolRegistrationContext } from "./types.js";

export interface FileSelection {path:string;start_line?:number;max_lines?:number}
export interface ContextSelection {
  action:"capture"|"search"; files?:FileSelection[]; directory?:string; patterns?:string[];
  query?:string; queries?:string[]; context_lines?:number; file_offset?:number; max_files?:number;
  result_ref?:string; cursor?:string; selection_index?:number; line_offset?:number;
}
interface Line {line:number;text:string;eol:string;matches:number[]}
interface CapturedFile {
  path:string;sha256:string;bytes:number;totalLines:number;startLine:number;maxLines:number;
  selectionIndex:number;lines:Line[];error?:string;
}
interface Capture {
  files:CapturedFile[];bytesRead:number;scope:Record<string,unknown>;enumeratedPaths?:string[];enumerationToken?:string;
}
interface Position {selectionIndex:number;startLine:number;lineOffset:number;ref?:string}
const EXCLUDED = ["**/.git/**","**/node_modules/**","**/Library/**","**/dist/**","**/build/**","**/.quaymesh/**"];
const CAPTURE_BYTES = 4 * 1024 * 1024;
type Enumeration = { iterator: AsyncIterator<string>; paths:string[]; complete:boolean; published:boolean; touched:number; pending?:Promise<void> };
const enumerations = new Map<string,Enumeration>();
const ENUMERATION_TTL_MS = 10 * 60_000;

async function pruneEnumerations() {
  const expired=[...enumerations].filter(([,value])=>Date.now()-value.touched>ENUMERATION_TTL_MS && !value.pending);
  for(const [key,value] of expired) {
    // Closing an earlier iterator may yield to a continuation of this one.
    if(enumerations.get(key)!==value || value.pending || Date.now()-value.touched<=ENUMERATION_TTL_MS)continue;
    enumerations.delete(key);await value.iterator.return?.();
  }
  if(enumerations.size>=32) {
    const oldest=[...enumerations].filter(([,value])=>!value.pending).sort((a,b)=>a[1].touched-b[1].touched)[0];
    if(oldest){enumerations.delete(oldest[0]);await oldest[1].iterator.return?.();}
    else throw new Error("CONTEXT_ENUMERATION_BUSY: retry after another directory search completes");
  }
}

export async function listDirectories(root:string, depth:number, maximum=100_001, signal?:AbortSignal) {
  const rows:Array<{name:string;kind:"directory"|"file"|"symlink"}>=[];
  async function visit(path:string,level:number) {
    signal?.throwIfAborted();
    const entries=await opendir(path);
    for await(const entry of entries) {
      signal?.throwIfAborted();
      const name=relative(root,`${path}/${entry.name}`).split(sep).join("/");
      rows.push({name,kind:entry.isSymbolicLink()?"symlink":entry.isDirectory()?"directory":"file"});
      if(rows.length>=maximum)return;
      if(entry.isDirectory()&&level<depth&&![".git","node_modules","Library","dist","build",".quaymesh"].includes(entry.name)) {
        await visit(`${path}/${entry.name}`,level+1);
        if(rows.length>=maximum)return;
      }
    }
  }
  await visit(root,1);return rows;
}

async function selections(context:ToolRegistrationContext,workspace:{id:string;root:string},input:ContextSelection,enumeratedPaths?:string[],enumerationToken?:string,signal?:AbortSignal):Promise<{files:FileSelection[];scope:Record<string,unknown>;enumeratedPaths?:string[];enumerationToken?:string}> {
  if(input.files?.length)return {files:input.files,scope:{selection:"explicit",total_files:input.files.length},enumeratedPaths:undefined};
  if(input.action!=="search")throw new Error("CAPTURE_FILES_REQUIRED");
  const offset=input.file_offset??0,limit=input.max_files??100;
  let paths=enumeratedPaths,enumeration=enumerationToken ? enumerations.get(enumerationToken) : undefined;
  if(enumerationToken && !enumeration)throw new Error("CONTEXT_ENUMERATION_EXPIRED: start a new search; captured result pages remain readable");
  if(!paths&&!enumeration) {
    await pruneEnumerations();
    signal?.throwIfAborted();
    const directory=await context.workspaces.resolveWorkingDirectory(await context.workspaces.getWorkspace(workspace.id,{touch:false}),input.directory??".");
    const iterator=(async function*(){
      for await(const path of glob(input.patterns??["**/*"],{cwd:directory,exclude:EXCLUDED})) {
        if((await stat(`${directory}/${path}`)).isFile())yield relative(workspace.root,`${directory}/${path}`).split(sep).join("/");
      }
    })();
    enumerationToken=`enum_${randomUUID()}`;
    enumeration={iterator,paths:[],complete:false,published:false,touched:Date.now()};
    enumerations.set(enumerationToken,enumeration);
  }
  if(enumeration) {
    enumeration.touched=Date.now();
    const current=enumeration;
    // 同一结果的并发续页排成一条链，取消的观察不会打断其他续页。
    const advance=(current.pending??Promise.resolve()).catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();
      const target=Math.max(128,offset+limit+1);
      while(!current.complete&&current.paths.length<target) {
        signal?.throwIfAborted();
        if(current.paths.length>=100_000)throw new Error("CONTEXT_ENUMERATION_LIMIT: narrow directory or patterns after 100000 files");
        const next=await current.iterator.next();
        if(next.done){current.complete=true;break;}
        current.paths.push(next.value);
      }
      if(!current.published&&current.complete)current.paths.sort();
      current.published=true;
    });
    current.pending=advance;
    try {await advance;}
    catch(error) {
      // No other caller can own an unpublished enumeration. Drain its iterator
      // before the handler settles; published continuations keep their queue.
      if(!current.published && current.pending===advance) {
        enumerations.delete(enumerationToken!);
        await current.iterator.return?.();
      }
      throw error;
    } finally {if(current.pending===advance)current.pending=undefined;}
    paths=current.paths;
  }
  paths??=[];
  const complete=!enumeration||enumeration.complete;
  return {files:paths.slice(offset,offset+limit).map(path=>({path})),enumeratedPaths:complete?[...paths]:undefined,
    enumerationToken:complete?undefined:enumerationToken,
    scope:{selection:"directory",directory:input.directory??".",patterns:input.patterns??["**/*"],excluded:EXCLUDED,
      total_files:complete?paths.length:null,enumerated_files:paths.length,enumeration_complete:complete,
      ordering:enumeration?.published&&!complete?"stable_traversal":"snapshot",file_offset:offset,
      next_file_offset:!complete||offset+limit<paths.length?offset+limit:null}};
}

async function capture(context:ToolRegistrationContext,workspace:{id:string;root:string},input:ContextSelection,enumeratedPaths?:string[],enumerationToken?:string,signal?:AbortSignal):Promise<Capture> {
  const chosen=await selections(context,workspace,input,enumeratedPaths,enumerationToken,signal);
  const queries=input.action==="search"?input.queries??(input.query?[input.query]:[]):[];
  if(input.action==="search"&&!queries.length)throw new Error("SEARCH_QUERY_REQUIRED");
  const reads=new Map<string,ReturnType<typeof readContextFileAsync>>();
  let bytesRead=0;
  let failure:{error:unknown}|undefined;
  const load=(path:string)=>{
    let pending=reads.get(path);
    if(!pending) {
      pending=(async()=>{
        signal?.throwIfAborted();
        const resolved=await context.workspaces.resolveReadPath(await context.workspaces.getWorkspace(workspace.id,{touch:false}),path);
        const root=resolved.skillRead?.skill.baseDir??workspace.root;
        const file=await readContextFileAsync(root,relative(root,resolved.absolutePath),signal);
        bytesRead+=file.bytes.length;
        if(bytesRead>CAPTURE_BYTES)throw new Error("CONTEXT_CAPTURE_LIMIT: select at most 4 MiB of source files");
        if(resolved.skillRead)file.path=resolved.absolutePath;
        return file;
      })();
      reads.set(path,pending);
    }
    return pending;
  };
  const files=await mapConcurrent(chosen.files,4,async(selection,selectionIndex):Promise<CapturedFile>=>{
    const first=selection.start_line??1,maxLines=selection.max_lines??(input.action==="search"?Number.MAX_SAFE_INTEGER:80);
    const empty:CapturedFile={path:selection.path,sha256:"",bytes:0,totalLines:0,startLine:first,maxLines,selectionIndex,lines:[]};
    if(failure)return empty;
    try {
      signal?.throwIfAborted();
      const file=await load(selection.path);
      const text=file.bytes.toString("utf8");
      const raw=text?text.split(/(?<=\n)/u):[];
      const all=raw.map((text,index)=>({line:index+1,text:text.replace(/\r?\n$/,""),
        eol:text.endsWith("\r\n")?"\r\n":text.endsWith("\n")?"\n":"",matches:[] as number[]}));
      // 选区上限固定在采集时，传输分页仅切分已经选中的内容。
      const visible=all.slice(first-1,first-1+maxLines);
      let lines=visible;
      if(queries.length) {
        const included=new Set<number>(),padding=input.context_lines??0;
        for(const row of visible) {
          row.matches=queries.flatMap((query,index)=>row.text.includes(query)?[index]:[]);
          if(row.matches.length)for(let n=Math.max(first,row.line-padding);n<=Math.min(first+maxLines-1,all.length,row.line+padding);n++)included.add(n);
        }
        lines=visible.filter(row=>included.has(row.line));
      }
      return {...empty,path:file.path,sha256:file.sha256,bytes:file.bytes.length,totalLines:all.length,
        maxLines:Math.min(maxLines,Math.max(0,all.length-first+1)),lines};
    } catch(error) {
      if(signal?.aborted || bytesRead>CAPTURE_BYTES) {
        // Keep mapConcurrent's workers joined, stop launching new reads, and
        // rethrow only after the already-started reads have all settled.
        failure??={error:signal?.aborted ? signal.reason : error};
        return empty;
      }
      return {...empty,error:error instanceof Error?error.message:String(error)};
    }
  });
  if(failure)throw failure.error;
  return {files,bytesRead,scope:{...chosen.scope,queries},enumeratedPaths:chosen.enumeratedPaths,enumerationToken:chosen.enumerationToken};
}

export async function contextPage(context:ToolRegistrationContext,workspace:{id:string;root:string},input:ContextSelection,signal?:AbortSignal) {
  const invocation=currentInvocation();
  if(!context.sessionRuntime||!invocation)throw new Error("SESSION_RUNTIME_REQUIRED");
  const store=context.sessionRuntime.store;
  let resultRef=input.result_ref,data:Capture;
  if(resultRef) {
    const saved=store.contextResult(invocation.owner_id,context.config.federation?.nodeId??"local",workspace.root,resultRef);
    const original=saved.input as ContextSelection;
    if(original.action!==input.action)throw new Error("CONTEXT_ACTION_MISMATCH");
    data=saved.result as Capture;
    if(input.file_offset!==undefined&&input.file_offset!==data.scope.file_offset) {
      if(input.cursor||(!data.enumeratedPaths&&!data.enumerationToken))throw new Error("CONTEXT_ENUMERATION_INVALID");
      input={...original,file_offset:input.file_offset,result_ref:undefined,cursor:undefined};
      data=await capture(context,workspace,input,data.enumeratedPaths,data.enumerationToken,signal);
      signal?.throwIfAborted();
      resultRef=await store.writeAsync(()=>store.saveContextResult(invocation.owner_id,invocation.session_id,invocation.member_id,invocation.task_id,input,data),{signal});
    }
  } else {
    data=await capture(context,workspace,input,undefined,undefined,signal);
    signal?.throwIfAborted();
    resultRef=await store.writeAsync(()=>store.saveContextResult(invocation.owner_id,invocation.session_id,invocation.member_id,invocation.task_id,input,data),{signal});
  }
  let position:Position={selectionIndex:input.selection_index??0,startLine:1,lineOffset:input.line_offset??0};
  if(input.cursor) {
    if(!input.result_ref)throw new Error("CONTEXT_CURSOR_REQUIRES_RESULT_REF");
    const parsed=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8")) as Position;
    if(![parsed.selectionIndex,parsed.startLine,parsed.lineOffset].every(Number.isSafeInteger)||parsed.selectionIndex<0||parsed.startLine<1||parsed.lineOffset<0)throw new Error("CONTEXT_CURSOR_INVALID");
    if(parsed.ref&&parsed.ref!==resultRef)throw new Error("CONTEXT_CURSOR_REFERENCE_MISMATCH");
    position=parsed;
  } else position.startLine=data.files[position.selectionIndex]?.startLine??1;
  if(position.selectionIndex>data.files.length)throw new Error("CONTEXT_SELECTION_INVALID");
  return packPage(data,resultRef,position,invocation.operation_id);
}

function packPage(data:Capture,resultRef:string,from:Position,operationId?:string) {
  const entries:Array<Record<string,any>>=[];
  const value={operation_id:operationId,result_ref:resultRef,entries,bytesRead:data.bytesRead,scope:data.scope,
    partial:data.files.some(file=>Boolean(file.error)),next_cursor:null as string|null,complete:false};
  let next:Position|null=null;
  const budget=REPLY_BYTES-512;
  outer:for(let index=from.selectionIndex;index<data.files.length;index++) {
    const file=data.files[index]!,first=index===from.selectionIndex?from.startLine:1;
    const lines:Array<{line:number;text:string;offset:number;eol:string;lineTruncated:boolean;matches?:number[]}>=[];
    const entry={selection_index:file.selectionIndex??index,path:file.path,sha256:file.sha256,bytes:file.bytes,totalLines:file.totalLines,
      start_line:file.startLine,max_lines:file.maxLines,lines,...(file.error?{error:file.error}:{}),truncated:false};
    entries.push(entry);
    if(replyBytes(value)>budget) {entries.pop();next={selectionIndex:index,startLine:first,lineOffset:index===from.selectionIndex?from.lineOffset:0};break;}
    for(const candidate of file.lines) {
      if(candidate.line<first)continue;
      const offset=index===from.selectionIndex&&candidate.line===first?from.lineOffset:0;
      const points=Array.from(candidate.text);
      if(offset>points.length)throw new Error("CONTEXT_LINE_OFFSET_INVALID");
      const row={line:candidate.line,text:points.slice(offset).join(""),offset,eol:candidate.eol,lineTruncated:false,
        ...(candidate.matches?.length?{matches:candidate.matches}:{})};
      lines.push(row);
      if(replyBytes(value)<=budget)continue;
      let lo=0,hi=points.length-offset;
      row.eol="";row.lineTruncated=true;
      while(lo<hi) {
        const mid=Math.ceil((lo+hi)/2);row.text=points.slice(offset,offset+mid).join("");
        if(replyBytes(value)<=budget)lo=mid;else hi=mid-1;
      }
      row.text=points.slice(offset,offset+lo).join("");
      if(!lo)lines.pop();
      next={selectionIndex:index,startLine:candidate.line,lineOffset:offset+lo};
      entry.truncated=true;break outer;
    }
  }
  if(next) {
    if(next.selectionIndex===from.selectionIndex&&next.startLine===from.startLine&&next.lineOffset===from.lineOffset)throw new Error("CONTEXT_PAGE_CANNOT_PROGRESS");
    value.next_cursor=Buffer.from(JSON.stringify({...next,ref:resultRef})).toString("base64url");
  }
  // Exhausting this reply does not exhaust a directory search's remaining files.
  const scopeComplete = data.scope.selection !== "directory"
    || (data.scope.enumeration_complete === true && data.scope.next_file_offset === null);
  value.complete = next === null && scopeComplete;
  if(replyBytes(value)>REPLY_BYTES)throw new Error("CONTEXT_PAGE_TOO_LARGE");
  return value;
}
