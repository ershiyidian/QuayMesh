import { isAbsolute } from 'node:path';

/** Internal request. Identity is copied from the accepted invocation, never
 * from tool arguments; the child checks it against its readonly DB snapshot. */
export interface StatusReadRequest {
  operation: 'workspace-status';
  stateDir: string;
  ownerId: string;
  sessionId: string;
  memberId: string;
  workspaceId: string;
  nodeId: string;
  root: string;
  taskId?: string;
  limit: number;
}

export interface StatusOperationRow {
  operation_id: string;
  kind: string;
  label: string;
  state: string;
  effect: string;
  created_at: string;
  finished_at: string | null;
  process_handle?: string;
  agent_id?: string;
  result_ref?: string;
  outcome: string;
  error?: { code: string; message: string; next_action: string };
}

export interface StatusReadResult {
  session_id: string;
  workspace_id: string;
  execution_state: string;
  review_state: string;
  host_state: string;
  operations: StatusOperationRow[];
  unknown_effects: string[];
  note: string;
}

export function parseStatusReadRequest(value: unknown): StatusReadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_status_read');
  const row = value as Record<string, unknown>;
  const keys = ['operation','stateDir','ownerId','sessionId','memberId','workspaceId','nodeId','root','taskId','limit'];
  if (Object.keys(row).some(key => !keys.includes(key)) || row.operation !== 'workspace-status'
    || !Number.isInteger(row.limit) || Number(row.limit) < 1 || Number(row.limit) > 20) throw new Error('invalid_status_read');
  for (const key of ['ownerId','sessionId','memberId','workspaceId','nodeId']) {
    if (typeof row[key] !== 'string' || !row[key] || row[key].length > 256) throw new Error('invalid_status_read');
  }
  for (const key of ['stateDir','root']) {
    if (typeof row[key] !== 'string' || row[key].length > 4096 || !isAbsolute(row[key])) throw new Error('invalid_status_read');
  }
  if (row.taskId !== undefined && (typeof row.taskId !== 'string' || !row.taskId || row.taskId.length > 256))
    throw new Error('invalid_status_read');
  return row as unknown as StatusReadRequest;
}
