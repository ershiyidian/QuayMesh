import { WorkbenchError } from './types.js';

export type TaskReadScope = { taskIds: readonly string[]; sessionId?: never }
  | { sessionId: string; taskIds?: never };

const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const invalid = () => new WorkbenchError('任务读取范围无效', 400, 'invalid_read', 'none');

/** A scope is mandatory on the scoped routes. Empty or malformed selection
 * must never turn into an unrestricted history read. */
export function parseTaskReadScope(value: unknown): TaskReadScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const scope = value as Record<string, unknown>, keys = Object.keys(scope);
  if (keys.length !== 1) throw invalid();
  if (keys[0] === 'sessionId' && identifier(scope.sessionId)) return { sessionId: scope.sessionId };
  if (keys[0] === 'taskId' && identifier(scope.taskId)) return { taskIds: [scope.taskId] };
  if (keys[0] !== 'taskIds' || !Array.isArray(scope.taskIds) || !scope.taskIds.length
    || scope.taskIds.length > 100 || !scope.taskIds.every(identifier)) throw invalid();
  return { taskIds: [...new Set(scope.taskIds)].sort() };
}

export function parseTaskReadScopeQuery(query: unknown): TaskReadScope {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const fields = query as Record<string, unknown>;
  if (Object.keys(fields).length !== 1) throw invalid();
  return parseTaskReadScope('taskIds' in fields
    ? { taskIds: typeof fields.taskIds === 'string' ? fields.taskIds.split(',') : fields.taskIds }
    : fields);
}

/** New route names prevent older nodes from silently ignoring a scope. */
export function scopedTaskReadPath(kind: 'task-index' | 'session-titles', input: TaskReadScope): string {
  const scope = parseTaskReadScope(input);
  const query = new URLSearchParams(scope.taskIds ? { taskIds: scope.taskIds.join(',') } : { sessionId: scope.sessionId });
  return `/workbench/${kind}-scoped?${query}`;
}
