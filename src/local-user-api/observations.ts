import type Database from "better-sqlite3";
import type {TaskPeerActivity} from "../messaging/task-peer-mailbox.js";
import {taskActivityView} from "../task-view.js";
import {resolveTaskTitle} from "../task-title.js";
import {requireVerifiedLocalGrant, type VerifiedLocalGrant} from "./grants.js";
import {localApiError, object} from "./protocol.js";

interface TaskRow {id: string; title: string; state: string; revision: number; created_at: string; finished_at: string | null; result_status: string | null}
interface Cursor {grant: string; revision: number; kind: string; task?: string; after: unknown}
const encode = (grant: VerifiedLocalGrant, kind: string, after: unknown, task?: string) => Buffer.from(JSON.stringify({
  grant: grant.grantId, revision: grant.revision, kind, ...(task ? {task} : {}), after})).toString("base64url");
function decode(value: unknown, grant: VerifiedLocalGrant, kind: string, task?: string): unknown {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw localApiError("LOCAL_API_CURSOR_INVALID");
  let parsed: Cursor;
  try {parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;} catch {throw localApiError("LOCAL_API_CURSOR_INVALID");}
  if (!object(parsed) || parsed.grant !== grant.grantId || parsed.revision !== grant.revision || parsed.kind !== kind || parsed.task !== task)
    throw localApiError("LOCAL_API_CURSOR_INVALID");
  return parsed.after;
}

/** Metadata only. No event payload, stdout, command text, environment or file
 * body can enter this projection. All reads use the authority's Task store. */
export class LocalObservationStore {
  constructor(private readonly db: Database.Database, private readonly authorityNodeId: string,
    private readonly activity: (ids: readonly string[]) => Promise<readonly (TaskPeerActivity & {title?: string})[]>,
    private readonly now: () => number = Date.now) {}
  status(grant: VerifiedLocalGrant) {
    requireVerifiedLocalGrant(grant); grant.assertCurrent("status:read", []);
    return {protocolVersion: 1, ready: true, authorityNodeId: this.authorityNodeId, nodeId: grant.nodeId,
      sourceTaskId: grant.sourceTaskId, taskIds: grant.taskIds, expiresAt: grant.expiresAt};
  }
  async tasks(grant: VerifiedLocalGrant, params: Record<string, unknown>) {
    requireVerifiedLocalGrant(grant); grant.assertCurrent("tasks:read", []);
    const after = decode(params.cursor, grant, "tasks"), limit = Number(params.limit ?? 25);
    if (after !== undefined && (!Array.isArray(after) || after.length !== 2 || after.some(v => typeof v !== "string" || v.length > 256)))
      throw localApiError("LOCAL_API_CURSOR_INVALID");
    const scope = grant.taskIds, bindings: unknown[] = [grant.principal.ownerId];
    const conditions = ["s.owner_id=?"];
    if (scope) {conditions.push(`t.id IN (${scope.map(() => "?").join(",")})`); bindings.push(...scope);}
    if (Array.isArray(after)) {conditions.push("(t.created_at,t.id)>(?,?)"); bindings.push(...after);}
    const rows = this.db.prepare(`SELECT t.id,t.title,t.state,t.revision,t.created_at,t.finished_at,t.result_status
      FROM qm_tasks t JOIN qm_sessions s ON s.id=t.session_id WHERE ${conditions.join(" AND ")}
      ORDER BY t.created_at,t.id LIMIT ?`).all(...bindings, limit + 1) as TaskRow[];
    const page = rows.slice(0, limit), items = await this.details(grant, page);
    const last = page.at(-1);
    return {items, hasMore: rows.length > limit, nextCursor: last ? encode(grant, "tasks", [last.created_at, last.id]) : params.cursor ?? null};
  }
  async task(grant: VerifiedLocalGrant, taskId: string) {
    requireVerifiedLocalGrant(grant); grant.assertCurrent("tasks:read", [taskId]);
    const row = this.db.prepare("SELECT id,title,state,revision,created_at,finished_at,result_status FROM qm_tasks WHERE id=?").get(taskId) as TaskRow;
    return (await this.details(grant, [row]))[0];
  }
  events(grant: VerifiedLocalGrant, params: Record<string, unknown>) {
    requireVerifiedLocalGrant(grant);
    const taskId = String(params.task_id); grant.assertCurrent("events:read", [taskId]);
    const after = decode(params.cursor, grant, "events", taskId) ?? 0, limit = Number(params.limit ?? 50);
    if (!Number.isSafeInteger(after) || Number(after) < 0) throw localApiError("LOCAL_API_CURSOR_INVALID");
    const rows = this.db.prepare(`SELECT sequence,event_type,created_at FROM qm_events
      WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(taskId, after, limit + 1) as {sequence: number; event_type: string; created_at: string}[];
    const page = rows.slice(0, limit);
    return {items: page.map(row => ({sequence: row.sequence, taskId, type: /^[a-zA-Z_]{1,64}$/.test(row.event_type) ? row.event_type : "event",
      createdAt: row.created_at})), hasMore: rows.length > limit,
      nextCursor: encode(grant, "events", page.at(-1)?.sequence ?? after, taskId)};
  }
  private async details(grant: VerifiedLocalGrant, rows: TaskRow[]) {
    const ids = rows.map(row => row.id), observations = ids.length ? await this.activity(ids) : [];
    grant.assertCurrent("tasks:read", ids); // The read may await a remote observation; recheck revocation before returning it.
    const byId = new Map(observations.map(item => [item.taskId, item]));
    return rows.map(row => {
      const value = byId.get(row.id);
      const activity = taskActivityView({requestState: row.state, result: row.result_status, execution: value?.executionStatus ?? "unknown",
        lastProgressAt: value?.lastProgressAt, executionObservedAt: value?.executionObservedAt, stale: value?.stale, now: this.now()});
      return {taskId: row.id, title: value?.title ?? resolveTaskTitle({title: row.title, createdAt: Date.parse(row.created_at)}).title,
        state: row.state, activityState: activity.state, current: activity.current, revision: row.revision, createdAt: row.created_at,
        finishedAt: row.finished_at, resultStatus: row.result_status,
        executionStatus: value?.executionStatus ?? "unknown", lastProgressAt: value?.lastProgressAt ?? null,
        executionObservedAt: value?.executionObservedAt ?? null, stale: value?.stale ?? true};
    });
  }
}
