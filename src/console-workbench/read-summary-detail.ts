import type {ServerConfig} from '../config.js';
import type {readRunDetail} from './detail.js';
import {readLocalRunSummaries} from './isolated-queries.js';
import {WorkbenchError} from './types.js';

export const PARTIAL_DETAIL_MESSAGE = '当前仅显示已读取的任务摘要；完整执行记录暂不可用。';

/** Temporary containment boundary. Full detail currently materializes mutable
 * session state, so it must not run on the Core event loop or in a read worker.
 * Empty arrays below are explicitly unconfirmed, never a complete empty result. */
export async function readSummaryDetail(config:ServerConfig,id:string):Promise<Awaited<ReturnType<typeof readRunDetail>>> {
  const result=await readLocalRunSummaries(config,[id]);
  const saved=result.items.find(run=>run.localId===id);
  if(!saved)throw new WorkbenchError('任务已不在当前节点的可见范围内',404,'run_not_found','none');
  const run={...saved,actions:{...saved.actions,review:false,complete:false,revert:false,patch:false}};
  const summary=[run.reason,PARTIAL_DETAIL_MESSAGE].filter(Boolean).join('\n');
  const missingPhases=[{id:run.id,nodeId:run.nodeId,error:PARTIAL_DETAIL_MESSAGE,pending:true}];
  return {
    run,summary,phases:[{id:run.id,run,summary}],complete:false,sources:[],
    missingPhases,
    evidence:[],files:[],commands:[],agents:[],timeline:[],instructions:[],skills:[],
    warnings:[...run.warnings],changeCaptures:[],revision:run.revision,
  };
}

export function detailTemporarilyUnavailable():never {
  throw new WorkbenchError('完整执行记录暂不可用，请稍后重试；当前任务执行不受此读取影响',
    503,'console_detail_temporarily_unavailable','none');
}
