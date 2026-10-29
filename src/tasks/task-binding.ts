import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ServerConfig } from "../config.js";
import { admitTaskWorkInTransaction, finalizationBlocksNewWork, type FinalizationFence } from "../session/task-finalization.js";
import { runSqliteWrite } from "../db/async-write.js";
import { TaskAccessResolver, taskPrincipalFromAuthInfo, type TaskPrincipal, type TaskOwnerSource } from "./task-access.js";

const verifiedEntry = Symbol("verified-task-execution-entry");
const localTaskClient = Symbol("locally-authenticated-task-client");

type TaskAuthInfo = {clientId?: string; extra?: Record<string, unknown>};
export interface TaskCreationClient {
  readonly principal: TaskPrincipal;
  readonly clientId: string;
  readonly [localTaskClient]: true;
}

// 仅在本机 OAuth 中间件成功验证之后调用；Symbol 不经过 Peer JSON 传输。
export function withLocallyAuthenticatedTaskClient<T extends TaskAuthInfo>(authInfo: T): T {
  if (!identifier(authInfo.clientId)) return authInfo;
  const client: TaskCreationClient = Object.freeze({principal: taskPrincipalFromAuthInfo(authInfo),
    clientId: authInfo.clientId, [localTaskClient]: true as const});
  return {...authInfo, [localTaskClient]: client};
}

export function taskCreationClientFromAuthInfo(authInfo: TaskAuthInfo | undefined): TaskCreationClient | undefined {
  const client = (authInfo as TaskAuthInfo & {[localTaskClient]?: TaskCreationClient} | undefined)?.[localTaskClient];
  return client?.[localTaskClient] === true ? client : undefined;
}

// 联邦的本机调用会重建脱敏 authInfo，保留本地验证身份但不带回凭据。
export function retainLocalTaskClient<T extends TaskAuthInfo>(source: TaskAuthInfo | undefined, target: T): T {
  const client = taskCreationClientFromAuthInfo(source);
  return client && target.clientId === client.clientId && target.extra?.owner_id === client.principal.ownerId
    ? {...target, [localTaskClient]: client} : target;
}

export function isTaskBindingAuthority(config: Pick<ServerConfig, "federation">): boolean {
  const federation = config.federation;
  return !federation?.enabled || Boolean(federation.coordinatorId)
    && federation.nodeId === federation.coordinatorId && federation.capabilities.coordinator;
}

/** An entry is an execution binding, never the owner or parent of a Task. */
export interface TaskExecutionEntry {
  readonly principal: TaskPrincipal;
  readonly clientId: string;
  readonly key: string;
  readonly [verifiedEntry]: true;
}

/** authInfo must come from verified OAuth middleware or authenticated federation RPC. */
export function taskExecutionEntryFromAuthInfo(
  authInfo: { clientId?: string; extra?: Record<string, unknown> } | undefined,
  correlationId: string | null | undefined,
): TaskExecutionEntry {
  const principal = taskPrincipalFromAuthInfo(authInfo);
  const clientId = authInfo?.clientId;
  if (!identifier(clientId) || !identifier(correlationId)) throw failure("TASK_ENTRY_REQUIRED",
    "A stable host entry correlation and authenticated OAuth client are required. No binding was changed.");
  return Object.freeze({ principal, clientId,
    key: createHash("sha256").update(correlationId).digest("hex"), [verifiedEntry]: true as const });
}

export interface TaskBindingSelection {
  id: string;
  taskId: string | null;
  revision: number;
}

export interface TaskStartIntent {
  newGoal?: true;
  expectedBindingRevision?: number;
}

export interface TaskBindingView {
  task_id: string;
  entry_available: true;
  binding_revision: number;
  selected_task_id: string | null;
  status: "selected" | "unbound" | "different_task" | "closed" | "finalizing";
  can_resume: boolean;
  can_continue: boolean;
}

/** Private card sideband, separate from persisted/public Snapshot fields. */
export type TaskBindingState = TaskBindingView | {
  task_id: string;
  entry_available: false;
  binding_revision: null;
  selected_task_id: null;
  status: "entry_unavailable";
  can_resume: false;
  can_continue: false;
  reason: string;
};

interface BindingRow { id: string; task_id: string | null; revision: number }
interface SavedRequest { input_json: string; task_id: string; result_revision: number }

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function failure(code: string, message = code): Error & { code: string; effect: "not_started" } {
  return Object.assign(new Error(`${code}: ${message}`), { code, effect: "not_started" as const });
}

/** SQL-only mutations share the existing SQLite writer and never enclose I/O. */
export class TaskBindingStore {
  private readonly access: TaskAccessResolver;
  constructor(private readonly db: Database.Database, options: { ownerSource: TaskOwnerSource }) {
    this.access = new TaskAccessResolver(db, options);
  }

  /** 只验证显式 Task 的访问权；不存在、孤立或其他 owner 的 Task 使用同一拒绝。 */
  authorizeTask(principal: TaskPrincipal, taskId: string) {
    return this.access.resolve(principal, taskId);
  }

  async startUnbound(client: TaskCreationClient, requestKey: string,
    input: TaskStartIntent & {title: string; sourceTaskId?: string}, createTask: () => string): Promise<string> {
    if (client?.[localTaskClient] !== true || !identifier(client.clientId)) throw failure("TASK_CREATION_IDENTITY_REQUIRED");
    this.requireKey(requestKey);
    const inputJson = JSON.stringify({title: input.title, source_task_id: input.sourceTaskId ?? null,
      new_goal: input.newGoal ?? false, expected_binding_revision: input.expectedBindingRevision ?? null});
    return runSqliteWrite(this.db, () => {
      const saved = this.db.prepare(`SELECT input_json,task_id FROM qm_task_creation_receipts
        WHERE owner_id=? AND client_id=? AND request_key=?`)
        .get(client.principal.ownerId, client.clientId, requestKey) as {input_json: string; task_id: string} | undefined;
      if (saved) {
        if (saved.input_json !== inputJson) throw failure("TASK_BINDING_KEY_CONFLICT", "The start request key belongs to different input.");
        this.access.resolveInTransaction(client.principal, saved.task_id);
        return saved.task_id;
      }
      // 丢失宿主入口不能把一次历史重试变成新建任务，也不能猜它属于哪个入口。
      const boundReceipt = this.db.prepare(`SELECT 1 FROM qm_task_bindings b
        JOIN qm_task_binding_requests r ON r.binding_id=b.id
        WHERE b.owner_id=? AND b.client_id=? AND r.action='start' AND r.request_key=? LIMIT 1`)
        .get(client.principal.ownerId, client.clientId, requestKey);
      if (boundReceipt) throw failure("TASK_ENTRY_REQUIRED",
        "This start key has a receipt in a host entry. Retry with the original conversation metadata, or pass the known task_id on workspace calls. No Task was created or selected.");
      if (input.expectedBindingRevision !== undefined)
        throw failure("TASK_ENTRY_REQUIRED", "A binding revision requires a stable host conversation ID. Pass task_id on workspace calls instead.");
      const taskId = createTask();
      this.access.resolveInTransaction(client.principal, taskId);
      this.db.prepare(`INSERT INTO qm_task_creation_receipts(owner_id,client_id,request_key,input_json,task_id,created_at)
        VALUES(?,?,?,?,?,?)`).run(client.principal.ownerId, client.clientId, requestKey, inputJson, taskId, new Date().toISOString());
      return taskId;
    });
  }

  current(entry: TaskExecutionEntry): TaskBindingSelection | null {
    this.requireEntry(entry);
    const row = this.find(entry);
    if (row?.task_id) this.access.resolve(entry.principal, row.task_id);
    return row ? this.selection(row) : null;
  }

  inspect(entry: TaskExecutionEntry, taskId: string): TaskBindingView {
    this.requireEntry(entry);
    const task = this.access.resolve(entry.principal, taskId), binding = this.find(entry);
    const finishing = this.finishing(taskId);
    const eligible = task.state === "active" && !finishing;
    return { task_id: taskId, entry_available: true, binding_revision: binding?.revision ?? 0, selected_task_id: binding?.task_id ?? null,
      status: task.state === "closed" ? "closed" : finishing ? "finalizing"
        : binding?.task_id === taskId ? "selected" : binding?.task_id ? "different_task" : "unbound",
      can_resume: eligible, can_continue: eligible && binding?.task_id === taskId };
  }

  /** One-time compatibility mapping. It never overwrites an entry already selected explicitly. */
  async initializeLegacy(entry: TaskExecutionEntry, taskId: string): Promise<TaskBindingSelection> {
    return this.initialize(entry, () => taskId);
  }

  /** The callback is SQL-only and runs only if this entry is still unbound after locking. */
  async initialize(entry: TaskExecutionEntry, initialTask: () => string): Promise<TaskBindingSelection> {
    this.requireEntry(entry);
    const existing = this.current(entry);
    if (existing?.taskId) return existing;
    return runSqliteWrite(this.db, () => {
      const row = this.ensureEntry(entry);
      if (row.task_id) {
        this.access.resolveInTransaction(entry.principal, row.task_id);
        return this.selection(row);
      }
      const taskId = initialTask();
      this.access.resolveInTransaction(entry.principal, taskId);
      return this.select(row, taskId);
    });
  }

  async start(
    entry: TaskExecutionEntry,
    requestKey: string,
    input: TaskStartIntent & { title: string; sourceTaskId?: string },
    createTask: () => string,
    readLegacy?: () => { replayTaskId: string | null; currentTaskId: string | null } | null,
  ): Promise<{ taskId: string; replayed: boolean; binding: TaskBindingSelection | null }> {
    this.requireEntry(entry);
    this.requireKey(requestKey);
    const originalInputJson = JSON.stringify({ title: input.title, source_task_id: input.sourceTaskId ?? null });
    const inputJson = JSON.stringify({
      version: 2,
      title: input.title,
      source_task_id: input.sourceTaskId ?? null,
      new_goal: input.newGoal ?? false,
      expected_binding_revision: input.expectedBindingRevision ?? null,
    });
    return runSqliteWrite(this.db, () => {
      const row = this.find(entry);
      const saved = row ? this.request(row.id, "start", requestKey) : undefined;
      if (row && saved) {
        // Earlier receipts did not record creation intent or a binding version.
        // Compare their original fields, without retroactively requiring new ones.
        if (saved.input_json !== inputJson && saved.input_json !== originalInputJson)
          throw failure("TASK_BINDING_KEY_CONFLICT", "The start request key belongs to different input.");
        this.access.resolveInTransaction(entry.principal, saved.task_id);
        // Retrying a historical start returns its Task, without switching newer work back.
        return { taskId: saved.task_id, replayed: true, binding: this.selection(row) };
      }

      // Both callbacks are SQL-only. An older Session supplies a receipt or a
      // selection candidate; observing it must not initialize or change a binding.
      const legacy = readLegacy?.();
      if (legacy?.replayTaskId) {
        this.access.resolveInTransaction(entry.principal, legacy.replayTaskId);
        return { taskId: legacy.replayTaskId, replayed: true, binding: row ? this.selection(row) : null };
      }
      const revision = row?.revision ?? 0;
      const existingTaskId = row?.task_id ?? legacy?.currentTaskId;
      const existing = existingTaskId ? this.access.resolveInTransaction(entry.principal, existingTaskId) : null;
      const refuse = (code: string, message: string): never => {
        const summary = existing
          ? this.db.prepare("SELECT title FROM qm_tasks WHERE id=?").get(existing.taskId) as { title: string }
          : null;
        throw Object.assign(failure(code, message), {
          details: {
            binding_revision: revision,
            ...(existing && summary ? {
              existing_task: { task_id: existing.taskId, title: summary.title.slice(0, 200), state: existing.state },
              selection_source: row?.task_id ? "entry" : "legacy",
              next_action: { tool: "task_resume", arguments: { action: "inspect", task_id: existing.taskId } },
            } : {}),
          },
        });
      };
      if (existing && input.newGoal !== true)
        refuse("TASK_START_SELECTION_REQUIRED", "This entry already has a Task or a legacy selection candidate. Inspect it and continue the same goal. Only an explicitly new goal may replace this selection.");
      const expectedRevision = input.expectedBindingRevision;
      if ((existing || expectedRevision !== undefined)
        && (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
        refuse("TASK_BINDING_REVISION_REQUIRED", "A new goal needs the observed binding revision. Inspect the existing Task before retrying.");
      if (expectedRevision !== undefined && expectedRevision !== revision)
        refuse("TASK_BINDING_CHANGED", "The entry changed. Inspect and review its current selection before retrying.");

      const taskId = createTask();
      this.requireOpen(entry, taskId);
      const binding = this.select(row ?? this.ensureEntry(entry), taskId);
      this.saveRequest(binding.id, "start", requestKey, inputJson, taskId, binding.revision);
      return { taskId, replayed: false, binding };
    });
  }

  async resume(entry: TaskExecutionEntry, taskId: string, expectedRevision: number, requestKey: string): Promise<{
    taskId: string; replayed: boolean; binding: TaskBindingSelection;
  }> {
    this.requireEntry(entry); this.requireKey(requestKey);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw failure("TASK_BINDING_REVISION_REQUIRED");
    const inputJson = JSON.stringify({ task_id: taskId, expected_revision: expectedRevision });
    return runSqliteWrite(this.db, () => {
      // Recheck both ownership and lifecycle after obtaining the write lock.
      this.access.resolveInTransaction(entry.principal, taskId);
      const row = this.ensureEntry(entry), saved = this.request(row.id, "resume", requestKey);
      if (saved) {
        if (saved.input_json !== inputJson || saved.task_id !== taskId) throw failure("TASK_BINDING_KEY_CONFLICT");
        if (row.task_id !== taskId || row.revision !== saved.result_revision) throw failure("TASK_BINDING_REPLAY_SUPERSEDED",
          "This resume completed earlier, but the entry changed afterwards. Inspect again and use a new request key to select it explicitly.");
        this.requireOpen(entry, taskId);
        return { taskId, replayed: true, binding: this.selection(row) };
      }
      if (row.revision !== expectedRevision) throw failure("TASK_BINDING_CHANGED", "The entry changed. Inspect and review its current selection before retrying.");
      this.requireOpen(entry, taskId);
      // Only a new explicit resume may retire a failed, proven-unsent finish.
      // Historical request-key replay above must not cancel a later intent.
      admitTaskWorkInTransaction(this.db,taskId);
      const binding = row.task_id === taskId ? this.selection(row) : this.select(row, taskId);
      this.saveRequest(row.id, "resume", requestKey, inputJson, taskId, binding.revision);
      return { taskId, replayed: false, binding };
    });
  }

  private requireEntry(entry: TaskExecutionEntry): void {
    if (!entry || entry[verifiedEntry] !== true || !identifier(entry.clientId) || !/^[0-9a-f]{64}$/.test(entry.key)) {
      throw failure("TASK_ENTRY_REQUIRED");
    }
  }
  private requireKey(key: string): void {
    if (!identifier(key) || key.length > 128) throw failure("TASK_BINDING_REQUEST_KEY_REQUIRED");
  }
  private find(entry: TaskExecutionEntry): BindingRow | undefined {
    return this.db.prepare("SELECT id,task_id,revision FROM qm_task_bindings WHERE owner_id=? AND client_id=? AND entry_key=?")
      .get(entry.principal.ownerId, entry.clientId, entry.key) as BindingRow | undefined;
  }
  private ensureEntry(entry: TaskExecutionEntry): BindingRow {
    const existing = this.find(entry);
    if (existing) return existing;
    const now = new Date().toISOString(), id = `binding_${randomUUID().replaceAll("-", "")}`;
    this.db.prepare("INSERT INTO qm_task_bindings(id,owner_id,client_id,entry_key,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, entry.principal.ownerId, entry.clientId, entry.key, now, now);
    return { id, task_id: null, revision: 0 };
  }
  private select(row: BindingRow, taskId: string): TaskBindingSelection {
    const now = new Date().toISOString(), revision = row.revision + 1;
    this.db.prepare("UPDATE qm_task_bindings SET task_id=?,revision=?,updated_at=? WHERE id=?")
      .run(taskId, revision, now, row.id);
    return { id: row.id, taskId, revision };
  }
  private selection(row: BindingRow): TaskBindingSelection { return { id: row.id, taskId: row.task_id, revision: row.revision }; }
  private request(bindingId: string, action: "start" | "resume", key: string): SavedRequest | undefined {
    return this.db.prepare("SELECT input_json,task_id,result_revision FROM qm_task_binding_requests WHERE binding_id=? AND action=? AND request_key=?")
      .get(bindingId, action, key) as SavedRequest | undefined;
  }
  private saveRequest(bindingId: string, action: "start" | "resume", key: string, inputJson: string, taskId: string, revision: number): void {
    this.db.prepare(`INSERT INTO qm_task_binding_requests(binding_id,action,request_key,input_json,task_id,result_revision,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(bindingId, action, key, inputJson, taskId, revision, new Date().toISOString());
  }
  private finishing(taskId: string): boolean {
    const intent=this.db.prepare("SELECT error,completed_at,recovery_state FROM qm_task_finalizations WHERE task_id=?")
      .get(taskId) as FinalizationFence | undefined;
    return finalizationBlocksNewWork(intent);
  }
  private requireOpen(entry: TaskExecutionEntry, taskId: string): void {
    if (this.access.resolveInTransaction(entry.principal, taskId).state !== "active") throw failure("TASK_NOT_ACTIVE", "Resume does not reopen a completed Task.");
    if (this.finishing(taskId)) throw failure("TASK_FINISHING");
  }
}
