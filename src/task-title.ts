export type TaskTitleSource = 'task' | 'session' | 'user_message' | 'work_item' | 'workspace' | 'fallback';

export interface TaskTitleInput {
  title?: string | null;
  sessionTitle?: string | null;
  userMessage?: string | null;
  workItemTitle?: string | null;
  workspaceNames?: readonly string[];
  createdAt?: number | null;
}

export function placeholderTaskTitle(value: string | null | undefined): boolean {
  return !value?.trim() || /^(?:QuayMesh task|TaskQuay task|Federated session|Workspace (?:tq|qm):\S+|read|workspace_context|exec_command|write_stdin|apply_patch|cancel_command)$/iu.test(value.trim());
}

export function taskTitleMessage(body: string): string | null {
  const value=body.trim();
  if (!value || /^(?:```|<(?:environment_context|system|developer|app-context|permissions|instructions)\b|#\s*AGENTS\.md\b)/iu.test(value)) return null;
  const message=value.replace(/\s+/gu,' ');
  return placeholderTaskTitle(message) || /^(?:继续|继续执行|继续处理|从这里继续|continue|resume)[。.!！]?$/iu.test(message) ? null : message;
}

/** Resolve from saved context; this read projection never renames a Task. */
export function resolveTaskTitle(input: TaskTitleInput): {title: string; titleSource: TaskTitleSource} {
  if (!placeholderTaskTitle(input.title)) return {title:input.title!.trim(),titleSource:'task'};
  const message = input.userMessage ? taskTitleMessage(input.userMessage) : null;
  if (message) {
    const points = Array.from(message);
    return {title:points.slice(0,120).join('')+(points.length>120?'…':''),titleSource:'user_message'};
  }
  if (!placeholderTaskTitle(input.sessionTitle)) return {title:input.sessionTitle!.trim(),titleSource:'session'};
  if (!placeholderTaskTitle(input.workItemTitle)) return {title:input.workItemTitle!.trim(),titleSource:'work_item'};
  const names = [...new Set((input.workspaceNames ?? []).map(name=>name.trim()).filter(name=>name&&!placeholderTaskTitle(name)))];
  const at = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) && input.createdAt > 0
    ? new Date(input.createdAt).toISOString().slice(0,16).replace('T',' ')+' UTC' : null;
  const context = names.length ? names[0]+(names.length>1?' 等 '+names.length+' 个工作区':'') : '未命名任务';
  return {title:context+(at?' · '+at:''),titleSource:names.length?'workspace':'fallback'};
}
