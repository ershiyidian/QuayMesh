import { stat } from 'node:fs/promises';
import { canonicalResourcePath, resourcesConflict, type ExecutionResource } from '../execution-resources.js';
import type { SessionStore } from './store.js';
import type { SessionMember } from './types.js';
import { memberFile } from './write-evidence.js';

export interface RevertEligibility {
  allowed: boolean;
  reason: string | null;
  session_id: string;
  member_id: string;
  revision: number;
  paths: string[];
}

/** The mutation path and the bounded projection worker share this read model.
 * Callers supply capture evidence and occupancy reads; this never creates a
 * coordinator, releases a claim, captures files or writes to SQLite. */
export async function readRevertEligibility(store: SessionStore, sessionId: string, member: SessionMember,
  source: {captureBlock(memberId: string, taskId?: string): string | null;
    inspect(root: string): Array<{id: string; scopes: ExecutionResource[]}>},
  ignored: ReadonlySet<string> = new Set(), fileIds?: readonly string[], taskId?: string): Promise<RevertEligibility> {
  const unavailable = (reason: string): RevertEligibility => ({allowed:false,reason,session_id:sessionId,
    member_id:member.id,revision:member.revision,paths:[]});
  let blocked = source.captureBlock(member.id,taskId);
  if (blocked) return unavailable(blocked);
  const workspace = await stat(member.root).then(info => info.isDirectory(), (error:NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!workspace) return unavailable('workspace_missing');
  member = store.getMember(sessionId,member.id);
  blocked = source.captureBlock(member.id,taskId);
  if (blocked) return unavailable(blocked);
  const owned = store.fileSummaries(sessionId,member.id,taskId).filter(file => file.revertible && file.coverage === 'session_owned');
  const selected = fileIds ? owned.filter(file => fileIds.includes(file.id)) : owned;
  if (fileIds && (fileIds.length === 0 || new Set(fileIds).size !== selected.length)) throw new Error('REVERT_FILE_SELECTION_INVALID');
  const paths = [...new Set(selected.flatMap(file => file.from ? [file.from,file.path] : [file.path]))];
  let reason: string | null = paths.length ? null : 'no_owned_changes';
  const requested:ExecutionResource[] = paths.map(path => ({kind:'file',
    path:canonicalResourcePath(memberFile(member.root,path).absolute),access:'write'}));
  if (source.inspect(member.root).some(claim => !ignored.has(claim.id)
    && claim.scopes.some(scope => requested.some(target => resourcesConflict(scope,target))))) reason = 'active_writer';
  return {allowed:reason === null,reason,session_id:sessionId,member_id:member.id,revision:member.revision,paths};
}
