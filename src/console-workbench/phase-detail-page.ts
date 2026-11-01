import {WorkbenchError,type PhaseDetailPage,type Run} from './types.js';

type PhaseCursor={reference:string;anchor:string;direction:'before'|'after'};
const encode=(value:PhaseCursor)=>Buffer.from(JSON.stringify(value)).toString('base64url');

export function selectPhaseDetailPage(reference:string,task:Run,coverageComplete:boolean,input:{cursor?:string;limit?:number}={}):PhaseDetailPage {
  const limit=input.limit??20;
  if(!Number.isInteger(limit)||limit<1||limit>50)
    throw new WorkbenchError('每页阶段数须为 1 至 50',400,'invalid_phase_page','none');
  const current=new Set(task.currentPhaseRefs??[]),all=[...new Set(task.phaseRefs??[])];
  // Current work appears first. Preserve the index's stable created-at ordering
  // within each group, without depending on which summaries arrived first.
  const references=[...all.filter(id=>current.has(id)),...all.filter(id=>!current.has(id))];
  let offset=0;
  if(input.cursor){
    let cursor:PhaseCursor;
    try{
      cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')) as PhaseCursor;
      if(!cursor||Object.keys(cursor).length!==3||cursor.reference!==reference||typeof cursor.anchor!=='string'
        ||!['before','after'].includes(cursor.direction))throw new Error('scope');
    }catch{throw new WorkbenchError('阶段分页引用无效，请重新打开任务',400,'invalid_phase_page','none');}
    const anchor=references.indexOf(cursor.anchor);
    if(anchor<0)throw new WorkbenchError(coverageComplete?'阶段记录已变化，请重新读取第一页':'阶段来源尚未全部确认，请稍后重试此页',
      coverageComplete?409:503,coverageComplete?'phase_cursor_expired':'phase_page_pending','none');
    offset=cursor.direction==='after'?anchor+1:Math.max(0,anchor-limit);
  }
  const page=references.slice(offset,offset+limit);
  return {references:page,offset,limit,total:references.length,complete:false,
    previousCursor:offset>0&&page.length?encode({reference,anchor:page[0]!,direction:'before'}):null,
    nextCursor:coverageComplete&&offset+page.length<references.length&&page.length
      ?encode({reference,anchor:page.at(-1)!,direction:'after'}):null};
}
