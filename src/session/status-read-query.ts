import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openReadonlyDatabase } from '../db/client.js';
import { SessionStore } from './store.js';
import { currentOperationEvents } from './activity.js';
import type { StatusOperationRow, StatusReadRequest, StatusReadResult } from './status-read-protocol.js';

const pathIdentity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/** Saved observations only: no Runtime, process manager, write or migration.
 * This function is deliberately invoked only by the bounded read child. */
export function readStatusSnapshot(db: Database.Database, request: StatusReadRequest): StatusReadResult {
  const store = new SessionStore(db);
  const session = store.requireSession(request.ownerId, request.sessionId);
  const member = store.getMember(session.id, request.memberId);
  if (member.node_id !== request.nodeId || member.workspace_id !== request.workspaceId
    || pathIdentity(member.root) !== pathIdentity(request.root)) throw Object.assign(new Error('status_scope'), {code:'project_scope'});
  // Status has always observed the authorized Session/member history. Binding
  // the calling Task must not silently turn that history into only its rows.
  if (request.taskId && store.getTask(request.taskId).session_id !== session.id)
    throw Object.assign(new Error('status_scope'), {code:'project_scope'});
  const byOperation = new Map<string, StatusOperationRow>();
  // Keep the existing retry filter and first-insertion ordering. Limiting raw
  // events would lose starts/finishes or reorder a long-running old operation.
  for (const event of currentOperationEvents(store.eventsForSession(session.id))) {
    if (event.member_id !== member.id || !['operation_started','operation_finished'].includes(event.type)) continue;
    const id = String(event.payload.operation_id ?? event.source_id);
    const previous = byOperation.get(id);
    const running = event.type === 'operation_started';
    const state = String(event.payload.status ?? (running ? 'running' : 'unknown'));
    const errorCode = event.payload.error_code == null ? null : String(event.payload.error_code);
    const errorMessage = event.payload.error_message == null ? null : String(event.payload.error_message);
    const agentId = event.payload.agent_id == null ? previous?.agent_id : String(event.payload.agent_id);
    byOperation.set(id, {
      operation_id:id, kind:String(event.payload.kind ?? previous?.kind ?? 'unknown'),
      label:String(event.payload.label ?? previous?.label ?? ''), state:running ? 'running' : state,
      effect:String(event.payload.effect ?? previous?.effect ?? (running ? 'started' : 'unknown')),
      created_at:previous?.created_at ?? event.timestamp, finished_at:running ? null : event.timestamp,
      ...(agentId === undefined ? {} : {agent_id:agentId}),
      ...(typeof event.payload.result_ref === 'string' ? {result_ref:event.payload.result_ref}
        : previous?.result_ref ? {result_ref:previous.result_ref} : {}),
      outcome:running ? 'unknown' : state === 'succeeded' ? 'completed' : ['failed','cancelled'].includes(state) ? state : 'unknown',
      ...(errorCode || errorMessage ? {error:{code:errorCode ?? 'OPERATION_ERROR',
        message:errorMessage ?? 'Operation failed without a stored message.',
        next_action:'Inspect stored evidence; do not repeat a side effect until its effect is known.'}} : {}),
    });
  }
  const operations = [...byOperation.values()].slice(-request.limit).reverse();
  // One mapping lookup per returned operation, not one per historical event.
  for (const operation of operations) {
    const agentId = store.agentForOperation(operation.operation_id, session.id, member.id)?.agentId;
    if (agentId !== undefined) operation.agent_id = agentId;
  }
  return {session_id:session.id,workspace_id:member.workspace_id,execution_state:session.execution_state,
    review_state:session.review_state,host_state:session.host_state,operations,
    unknown_effects:operations.filter(row => row.effect === 'unknown' || row.state === 'unknown').map(row => row.operation_id),
    note:'This read does not change execution state. Use read, write_stdin, wait_agent or Console for detailed evidence.'};
}

export function readWorkspaceStatus(request: StatusReadRequest): StatusReadResult {
  const handle = openReadonlyDatabase(request.stateDir);
  try {
    handle.sqlite.exec('BEGIN');
    return readStatusSnapshot(handle.sqlite, request);
  } finally {
    try {if (handle.sqlite.inTransaction) handle.sqlite.exec('ROLLBACK');}
    finally {handle.close();}
  }
}
