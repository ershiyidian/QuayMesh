import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { git, getGitEligibility } from "../git.js";
import { canonicalPathIdentity } from "../roots.js";
import { validateRecovery } from "./schema.js";
import type { RecoveryRow, SessionEvent, SessionId } from "./types.js";
import type { SessionStore } from "./store.js";

const DEFAULT_RECOVERY_ROWS = 5;
const MAX_DETAIL_ROWS = 20;
const MAX_EXPORT_ROWS = 100;
const DISPLAY_PATHS = 5;

export interface RecoveryDetail {
  row: RecoveryRow;
  operations: Array<{
    operation_id: string;
    kind: string;
    label: string;
    state: string;
    effect: string;
    created_at: string;
    finished_at: string | null;
    result_ref: string | null;
    error_code: string | null;
    error_message: string | null;
  }>;
}

export class RecoveryService {
  private readonly writes = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly store: SessionStore,
    private readonly stateDir: string,
  ) {}

  buildRow(sessionId: SessionId, memberId?: string): RecoveryRow {
    const session = this.store.getSession(sessionId);
    const member = memberId ? this.store.getMember(sessionId, memberId) : session.members[0];
    if (!member) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${sessionId}`);
    const rows = this.store.recentRecoveryRows(session.owner_id, member.root, 100);
    const row = rows.rows.find((candidate) => candidate.session_id === sessionId);
    if (!row) throw new Error(`RECOVERY_ROW_NOT_FOUND: ${sessionId}`);
    return row;
  }

  summaryForOpen(ownerId: string, root: string): RecoveryRow[] {
    return this.store.recentRecoveryRows(ownerId, root, DEFAULT_RECOVERY_ROWS).rows.map((row) => this.withDisplayLimit(row));
  }

  detail(ownerId: string, root: string, sessionId: SessionId): RecoveryDetail {
    const row = this.store
      .recentRecoveryRows(ownerId, root, 1, undefined, sessionId)
      .rows.find((candidate) => candidate.session_id === sessionId);
    if (!row) throw new Error(`RECOVERY_ROW_NOT_FOUND: ${sessionId}`);
    const session = this.store.requireSession(ownerId, sessionId);
    const byOperation = new Map<string, ReturnType<typeof operationFromEvent>>();
    for (const event of this.store.eventsForSession(sessionId)) {
      if (event.type !== "operation_started" && event.type !== "operation_finished") continue;
      const operationId = String(event.payload.operation_id ?? event.source_id);
      byOperation.set(operationId, operationFromEvent(event, operationId, byOperation.get(operationId)));
    }
    const operations = [...byOperation.values()].slice(-MAX_DETAIL_ROWS);
    return { row: this.withDisplayLimit(row), operations };
  }

  taskDetail(ownerId: string, root: string, taskId: string, nodeId: string, limit = 20) {
    const task=this.store.getTask(taskId);
    this.store.requireSession(ownerId,task.session_id);
    const members=this.store.taskMemberIds(taskId).map(id=>this.store.getMember(task.session_id,id))
      .filter(member=>member.node_id===nodeId && canonicalPathIdentity(resolve(member.root))===canonicalPathIdentity(resolve(root)));
    if(!members.length) throw new Error("RECOVERY_TASK_WORKSPACE_MISMATCH");
    const ids=new Set(members.map(member=>member.id));
    const events=this.store.eventsForTask(taskId).filter(event=>ids.has(event.member_id));
    const operations=new Map<string,ReturnType<typeof operationFromEvent>>();
    for(const event of events) {
      if(event.type!=="operation_started" && event.type!=="operation_finished")continue;
      const id=String(event.payload.operation_id ?? event.source_id);
      operations.set(id,operationFromEvent(event,id,operations.get(id)));
    }
    const all=[...operations.values()];
    const files=this.store.taskData.files(task.id,task.session_id).filter(file=>ids.has(file.member_id));
    return {task_id:task.id,source_task_id:task.source_task_id ?? null,title:task.title,state:task.state,
      result_status:task.result_status ?? null,summary:task.summary ?? null,
      facts:{source:"execution_records",node_id:nodeId,root,last_activity_at:events.at(-1)?.timestamp ?? task.created_at,
        files:files.slice(0,limit),remaining_files:Math.max(0,files.length-limit),
        operations:all.slice(-limit),remaining_operations:Math.max(0,all.length-limit),
        active_operations:all.filter(op=>["running","queued","accepted"].includes(op.state)),
        unresolved:all.filter(op=>["unknown","reconciliation_required"].includes(op.state))},
      checkpoints:this.store.checkpoints(taskId,[...ids])};
  }

  async exportRoot(root: string): Promise<void> {
    if (this.closed) throw new Error("RECOVERY_SERVICE_CLOSED");
    const canonicalRoot = resolve(root);
    const previous = this.writes.get(canonicalRoot) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.exportRootNow(canonicalRoot));
    this.writes.set(canonicalRoot, next);
    try {
      await next;
    } finally {
      if (this.writes.get(canonicalRoot) === next) this.writes.delete(canonicalRoot);
    }
  }

  async ensureGitIgnore(root: string): Promise<void> {
    const eligibility = await getGitEligibility(root);
    if (!eligibility.ok || !eligibility.gitRoot) return;
    const gitRoot = eligibility.gitRoot;
    const excludeRelative = (await git(gitRoot, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim();
    if (!excludeRelative) throw new Error("GIT_EXCLUDE_PATH_MISSING");
    const excludePath = resolve(gitRoot, excludeRelative);
    const quaymeshRelative = relative(gitRoot, join(root, ".quaymesh")).replaceAll("\\", "/");
    const pattern = quaymeshRelative ? `${quaymeshRelative}/` : ".quaymesh/";
    const existing = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = existing.split(/\r?\n/u);
    if (lines.includes(pattern)) return;
    await mkdir(dirname(excludePath), { recursive: true });
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}${pattern}\n`, "utf8");
  }

  async readLocalHistoricalTable(root: string): Promise<RecoveryRow[]> {
    const path = join(root, ".quaymesh", "sessions.json");
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { sessions?: unknown }).sessions)) {
      throw new Error("INVALID_RECOVERY_JOURNAL");
    }
    return validateRecovery((parsed as { sessions: unknown }).sessions);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.writes.values()]);
    this.writes.clear();
  }

  private async exportRootNow(root: string): Promise<void> {
    // 工作区已移除时，历史记录仍保存在数据库，停止向原目录导出。
    const present = await stat(root).then(info => info.isDirectory(), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!present) return;
    const owners = this.store.ownerIdsForRoot(root);
    const rows = owners.flatMap((ownerId) => this.store.recentRecoveryRows(ownerId, root, MAX_EXPORT_ROWS).rows);
    const unique = new Map(rows.map((row) => [row.session_id, this.withDisplayLimit(row)]));
    const sessions = [...unique.values()].sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    const directory = join(root, ".quaymesh");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const updatedAt = new Date().toISOString();
    const json = JSON.stringify({ version: 1, root, updated_at: updatedAt, sessions }, null, 2) + "\n";
    const markdown = renderMarkdown(sessions, updatedAt);
    await atomicWrite(join(directory, "sessions.json"), json);
    await atomicWrite(join(directory, "Sessions.md"), markdown);
    for (const session of sessions) {
      const memberRows = this.store.getSession(session.session_id).members;
      for (const member of memberRows) {
        this.store.markProjectionExported(session.session_id, member.id, member.revision);
      }
    }
  }

  private withDisplayLimit(row: RecoveryRow): RecoveryRow {
    return {
      ...row,
      files: row.files.slice(0, DISPLAY_PATHS),
      remaining_files: Math.max(row.remaining_files, row.files.length - DISPLAY_PATHS),
    };
  }
}

function operationFromEvent(event: SessionEvent, operationId: string, previous?: {
  operation_id:string;kind:string;label:string;state:string;effect:string;created_at:string;finished_at:string|null;
  result_ref:string|null;error_code:string|null;error_message:string|null;
}) {
  if(previous?.finished_at && event.type==="operation_started") return previous;
  return {
    operation_id: operationId,
    kind: String(event.payload.kind ?? previous?.kind ?? "unknown"),
    label: String(event.payload.label ?? previous?.label ?? ""),
    state: String(event.payload.status ?? (event.type === "operation_started" ? "running" : "unknown")),
    effect: String(event.payload.effect ?? "unknown"),
    created_at: previous?.created_at ?? event.timestamp,
    finished_at: event.type === "operation_finished" ? event.timestamp : null,
    result_ref: event.payload.result_ref === null || event.payload.result_ref === undefined ? null : String(event.payload.result_ref),
    error_code: event.payload.error_code === null || event.payload.error_code === undefined ? null : String(event.payload.error_code),
    error_message: event.payload.error_message === null || event.payload.error_message === undefined ? null : String(event.payload.error_message),
  };
}

function renderMarkdown(rows: RecoveryRow[], updatedAt: string): string {
  const visible = rows.slice(0, 20);
  const lines = [
    "# QuayMesh Sessions",
    "",
    `Updated: ${updatedAt}`,
    `Total: ${rows.length}`,
    "",
    "| session_id | title | state | latest | files | commands | agents | verification | next_step | updated_at |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of visible) {
    lines.push(`| ${cell(row.session_id)} | ${cell(row.title)} | ${cell(row.execution_state)} | ${cell(row.latest_completed)} | ${cell(row.files.join(", "))} | ${cell(`${row.commands.succeeded}/${row.commands.failed}/${row.commands.running}`)} | ${cell(`${row.agents.completed}/${row.agents.failed}/${row.agents.running}`)} | ${cell(row.verification)} | ${cell(row.next_step)} | ${cell(row.updated_at)} |`);
  }
  return `${lines.join("\n")}\n`;
}

function cell(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replaceAll("|", "\\|");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.pending-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
