import type {RunDetail} from './contracts.js';

export interface RetainedDetail { data:RunDetail; time:number }
const recordKeys=['files','commands','agents','evidence','timeline','instructions','skills'] as const;
export type DetailRecordKey=typeof recordKeys[number];
const rows=(value:unknown)=>Array.isArray(value)?value.length:0;

/** A deliberate history page is complete without loading other pages. */
export function detailRecordsComplete(detail:Pick<RunDetail,'complete'|'phasePage'>):boolean {
  return detail.phasePage?detail.phasePage.complete:detail.complete!==false;
}

export function pendingDetailRead(value:unknown):boolean {
  const detail=value as {run?:unknown;complete?:boolean;missingPhases?:Array<{pending?:boolean}>}|null;
  return Boolean(detail?.run&&detail.complete===false&&Array.isArray(detail.missingPhases)
    &&detail.missingPhases.some(phase=>phase.pending===true));
}

/** Keep the previous successful evidence separately from the new partial
 * response. Its timestamp and historical state must never become a fresh fact. */
export function retainDetail(previous:RunDetail|null,next:RunDetail,time:number,saved?:RetainedDetail):RetainedDetail|undefined {
  if(detailRecordsComplete(next))return undefined;
  if(saved?.data.run.id!==next.run.id)saved=undefined;
  if(previous?.run.id!==next.run.id||!time)return saved;
  const lost=recordKeys.some(key=>rows(previous[key])>0&&rows(next[key])===0);
  return lost&&(!saved||detailRecordsComplete(previous))?{data:previous,time}:saved;
}

export function retainedDetailView(current:RunDetail,saved?:RetainedDetail) {
  const detail={...current},historical:DetailRecordKey[]=[];
  const use=<K extends DetailRecordKey>(key:K)=>{
    if(saved&&rows(current[key])===0&&rows(saved.data[key])>0){detail[key]=saved.data[key];historical.push(key);}
  };
  if(!detailRecordsComplete(current)&&saved?.data.run.id===current.run.id)for(const key of recordKeys)use(key);
  return {detail,historical,time:historical.length?saved!.time:null};
}
