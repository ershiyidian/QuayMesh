import { glob, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { readContextFile } from "../workspace-context.js";
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
  files:CapturedFile[];bytesRead:number;scope:Record<string,unknown>;enumeratedPaths?:string[];
}
interface Position {selectionIndex:number;startLine:number;lineOffset:number;ref?:string}
const EXCLUDED = ["**/.git/**","**/node_modules/**","**/Library/**","**/dist/**","**/build/**","**/.quaymesh/**"];
const CAPTURE_BYTES = 4 * 1024 * 1024;

export async function listDirectories(root:string, depth:number) {
  const rows:Array<{name:string;kind:"directory"|"file"|"symlink"}>=[];
  async function visit(path:string,level:number) {
    const entries=(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries) {
      const name=relative(root,`${path}/${entry.name}`).split(sep).join("/");
      rows.push({name,kind:entry.isSymbolicLink()?"symlink":entry.isDirectory()?"directory":"file"});
      if(entry.isDirectory()&&level<depth&&![".git","node_modules","Library","dist","build",".quaymesh"].includes(entry.name)) {
        await visit(`${path}/${entry.name}`,level+1);
      }
    }
  }
  await visit(root,1);return rows;
}

async function selections(context:ToolRegistrationContext,workspace:{id:string;root:string},input:ContextSelection,enumeratedPaths?:string[]):Promise<{files:FileSelection[];scope:Record<string,unknown>;enumeratedPaths?:string[]}> {
  if(input.files?.length)return {files:input.files,scope:{selection:"explicit",total_files:input.files.length},enumeratedPaths:undefined};
  if(input.action!=="search")throw new Error("CAPTURE_FILES_REQUIRED");
  let paths=enumeratedPaths;
  if(!paths) {
    const directory=await context.workspaces.resolveWorkingDirectory(await context.workspaces.getWorkspace(workspace.id),input.directory??".");
    paths=[];
    for await(const path of glob(input.patterns??["**/*"],{cwd:directory,exclude:EXCLUDED})) {
      if((await stat(`${directory}/${path}`)).isFile())paths.push(relative(workspace.root,`${directory}/${path}`).split(sep).join("/"));
    }
    paths.sort();
  }
  const offset=input.file_offset??0,limit=input.max_files??100;
  return {files:paths.slice(offset,offset+limit).map(path=>({path})),enumeratedPaths:paths,
    scope:{selection:"directory",directory:input.directory??".",patterns:input.patterns??["**/*"],excluded:EXCLUDED,
      total_files:paths.length,file_offset:offset,next_file_offset:offset+limit<paths.length?offset+limit:null}};
}

async function capture(context:ToolRegistrationContext,workspace:{id:string;root:string},input:ContextSelection,enumeratedPaths?:string[]):Promise<Capture> {
  const chosen=await selections(context,workspace,input,enumeratedPaths);
  const queries=input.action==="search"?input.queries??(input.query?[input.query]:[]):[];
  if(input.action==="search"&&!queries.length)throw new Error("SEARCH_QUERY_REQUIRED");
  const reads=new Map<string,Promise<ReturnType<typeof readContextFile>>>();
  let bytesRead=0;
  const load=(path:string)=>{
    let pending=reads.get(path);
    if(!pending) {
      pending=(async()=>{
        const resolved=await context.workspaces.resolveReadPath(await context.workspaces.getWorkspace(workspace.id),path);
        const root=resolved.skillRead?.skill.baseDir??workspace.root;
        const file=readContextFile(root,relative(root,resolved.absolutePath));
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
    try {
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
      if(bytesRead>CAPTURE_BYTES)throw error;
      return {...empty,error:error instanceof Error?error.message:String(error)};
    }
  });
  return {files,bytesRead,scope:{...chosen.scope,queries},enumeratedPaths:chosen.enumeratedPaths};
}

export async function contextPage(context:ToolRegistrationContext,workspace:{id:string;root:string},input:ContextSelection) {
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
      if(input.cursor||!data.enumeratedPaths)throw new Error("CONTEXT_ENUMERATION_INVALID");
      input={...original,file_offset:input.file_offset,result_ref:undefined,cursor:undefined};
      data=await capture(context,workspace,input,data.enumeratedPaths);
      resultRef=store.saveContextResult(invocation.owner_id,invocation.session_id,invocation.member_id,invocation.task_id,input,data);
    }
  } else {
    data=await capture(context,workspace,input);
    resultRef=store.saveContextResult(invocation.owner_id,invocation.session_id,invocation.member_id,invocation.task_id,input,data);
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
  value.complete=next===null;
  if(replyBytes(value)>REPLY_BYTES)throw new Error("CONTEXT_PAGE_TOO_LARGE");
  return value;
}
