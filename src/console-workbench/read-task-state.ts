import type {ServerConfig} from '../config.js';
import {WorkLedger} from '../work-ledger.js';
import {SessionStore} from '../session/store.js';
import {permitted} from './local.js';
import {WorkbenchError} from './types.js';

/** The parent checks the fixed Coordinator authority and live service. Scope
 * and mirror checks happen here before reading message state, with readonly DB. */
export function readTaskMessageState(config:ServerConfig,taskId:string) {
  const node=config.federation?.nodeId??'local';
  const ledger=new WorkLedger(config.stateDir);
  try {
    const store=new SessionStore(ledger.db);
    const task=store.getTask(taskId);
    if(task.source_kind==='federation_mirror')throw new WorkbenchError('镜像记录不能作为任务权威',409,'task_owner_mismatch','none');
    store.getSession(task.session_id);
    const members=store.taskMemberIds(task.id).map(id=>store.getMember(task.session_id,id));
    if(members.some(member=>member.node_id===node&&!permitted(config,member.root)))
      throw new WorkbenchError('任务不在允许访问的项目内',403,'task_scope','none');
    return {available:true as const,ownerNodeId:node,observedAt:Date.now(),...store.taskMessageState(task.id)};
  }finally{ledger.close();}
}
