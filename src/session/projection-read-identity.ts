import type { SessionStore } from './store.js';
import type { ProjectionIdentity } from './projection-read-protocol.js';

/** Small indexed identity/version reads only; never events, files or saved JSON. */
export function projectionIdentity(store:SessionStore,sessionId:string,memberId:string,taskId:string|undefined,nodeId?:string):ProjectionIdentity {
  const session = store.getSession(sessionId), member = store.getMember(sessionId,memberId);
  const task = taskId ? store.getTask(taskId) : null;
  if (task) store.taskData.requireScope(task.id,session.id,member.id);
  if (nodeId !== undefined && member.node_id !== nodeId) throw Object.assign(new Error('projection_scope'),{code:'project_scope'});
  return {ownerId:session.owner_id,sessionId:session.id,memberId:member.id,taskId:task?.id??null,nodeId:member.node_id,
    workspaceId:member.workspace_id,root:member.root,sourceRoot:member.source_root,recoveryRoot:member.recovery_root,mode:member.mode,
    sessionRevision:session.revision,memberRevision:member.revision,taskRevision:task?.revision??null,
    currentTaskId:session.current_task_id,sessionState:session.execution_state,sessionReview:session.review_state,sessionHost:session.host_state,
    sessionTitle:session.title,taskState:task?.state??null,taskTitle:task?.title??null};
}
