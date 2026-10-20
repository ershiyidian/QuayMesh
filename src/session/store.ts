import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { runSqliteWrite, type SqliteWriteOptions } from "../db/async-write.js";
import { canonicalWorkspaceRoot, canonicalPathIdentity } from "../roots.js";
import { resolve } from "node:path";
import { TaskDataStore, type ContextReadInput } from "./task-data.js";
import { retryableAdmission } from "./outcome.js";
import {
  ExecutionState,
  HostState,
  ReviewState,
  type NodeId,
  type RecoveryRow,
  type SessionEvent,
  type SessionId,
  type SessionMember,
  type SessionRecord,
  type Snapshot,
  type TaskRecord,
  type FileSummary,
  OperationState,
  type WorkspaceId,
} from "./types.js";

interface InvocationRow {
  id: string;
  owner_id: string;
  transport_instance_id: string;
  request_id: string;
  session_id: string;
  member_id: string;
  tool_name: string;
  arguments_json: string;
  operation_id: string | null;
  task_id: string | null;
  retry_of_invocation_id: string | null;
  state: OperationState;
  effect: "not_started" | "started" | "partial" | "completed" | "unknown";
  result_ref: string | null;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
  response_at: string | null;
}

interface EventAppendResult {
  sequence: number;
  sessionRevision: number;
  memberRevision: number;
  changed: boolean;
  ownerId: string;
}

interface ContextReadRow {
  session_id: string;
  member_id: string;
  actor_id: string;
  path: string;
  kind: "instruction" | "skill";
  state: "loaded" | "available" | "read";
  content_ref: string | null;
  read_count: number;
  observed_at: string | null;
}

interface ChangeBaselineRow {
  session_id: string;
  member_id: string;
  repo_root: string;
  baseline_ref: string;
  latest_ref: string;
  coverage: "session_owned" | "workspace_observed" | "partial";
}

export interface AgentOperationLink {
  operationId: string;
  agentId: string;
  sessionId: SessionId;
  memberId: string;
}

export class SessionStore {
  readonly taskData: TaskDataStore;
  private readonly ownedDatabase: boolean;
  private readonly changeListeners = new Set<(change: { sessionId: SessionId; memberId: string; ownerId: string; revision: number; sequence: number; taskId?: string }) => void>();

  constructor(private readonly db: Database.Database, owned = false) {
    this.ownedDatabase = owned;
    this.taskData = new TaskDataStore(db);
  }

  // 回调只允许同步 SQL；通知、文件和进程操作放在 await 之后。
  writeAsync<T>(write: () => T, options?: SqliteWriteOptions): Promise<T> {
    return runSqliteWrite(this.db, write, options);
  }

  findSession(sessionId: SessionId): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, conversation_id, title, revision, execution_state, review_state, host_state, current_task_id, selected_member_id, created_at, last_activity_at
         FROM qm_sessions WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapSessionRecord(row);
  }

  findByConversation(ownerId: string, conversationId: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, conversation_id, title, revision, execution_state, review_state, host_state, current_task_id, selected_member_id, created_at, last_activity_at
         FROM qm_sessions
         WHERE owner_id = ? AND conversation_id = ?`,
      )
      .get(ownerId, conversationId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapSessionRecord(row);
  }

  createSession(ownerId: string, conversationId: string | null, title: string): SessionRecord {
    const createTx = this.db.transaction(() => {
      if (conversationId) {
        const existing = this.findByConversation(ownerId, conversationId);
        if (existing) return existing;
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO qm_sessions (
             id, owner_id, conversation_id, title, revision, execution_state, review_state, host_state, current_task_id, selected_member_id, created_at, last_activity_at
           ) VALUES (?, ?, ?, ?, 0, 'idle', 'unknown', 'unknown', NULL, NULL, ?, ?)`,
        )
        .run(id, ownerId, conversationId, title, now, now);

      return {
        id,
        owner_id: ownerId,
        conversation_id: conversationId,
        title,
        revision: 0,
        execution_state: ExecutionState.idle,
        review_state: ReviewState.unknown,
        host_state: HostState.unknown,
        current_task_id: null,
        selected_member_id: "",
        created_at: now,
        last_activity_at: now,
        members: [],
      };
    });

    return createTx();
  }

  createTask(sessionId: SessionId, title: string, requestKey?: string, sourceTaskId?: string): TaskRecord {
    const value = title.trim().slice(0, 200);
    if (!value) throw new Error("TASK_TITLE_REQUIRED");
    return this.db.transaction(() => {
      const session = this.getSession(sessionId);
      if (requestKey) {
        const saved = this.db.prepare("SELECT id FROM qm_tasks WHERE session_id=? AND request_key=?").get(sessionId,requestKey) as {id:string}|undefined;
        if (saved) return this.getTask(saved.id);
      }
      const id = `task_${randomUUID().replaceAll("-", "")}`;
      const now = new Date().toISOString();
      const sequence = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM qm_events WHERE session_id = ?")
        .get(sessionId) as { sequence: number };
      this.db.prepare(`INSERT INTO qm_tasks
        (id,session_id,title,revision,state,start_sequence,created_at,last_activity_at,finished_at,request_key,source_task_id,source_kind)
        VALUES (?,?,?,0,'active',?,?,?,NULL,?,?,?)`)
        .run(id, session.id, value, Number(sequence.sequence ?? 0), now, now, requestKey ?? null, sourceTaskId ?? null, "user_request");
      this.db.prepare(`UPDATE qm_sessions
        SET current_task_id=?,revision=revision+1,last_activity_at=? WHERE id=?`)
        .run(id, now, session.id);
      return this.getTask(id);
    }).immediate();
  }

  findTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT id,session_id,title,revision,state,start_sequence,created_at,last_activity_at,finished_at,request_key,result_status,summary,source_task_id,
      closure_reason,archived_at,delivery_ended_at,source_kind,change_summary_state,change_summary_error
      FROM qm_tasks WHERE id=?`).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), session_id: String(row.session_id), title: String(row.title), revision: Number(row.revision ?? 0),
      state: row.state === "closed" ? "closed" : "active", start_sequence: Number(row.start_sequence ?? 0),
      created_at: String(row.created_at), last_activity_at: String(row.last_activity_at),
      finished_at: row.finished_at ? String(row.finished_at) : null,
      request_key: row.request_key ? String(row.request_key) : null,
      result_status: row.result_status as TaskRecord["result_status"],
      summary: row.summary ? String(row.summary) : null,
      source_task_id: row.source_task_id ? String(row.source_task_id) : null,
      closure_reason: row.closure_reason ? String(row.closure_reason) as TaskRecord["closure_reason"] : null,
      archived_at: row.archived_at ? String(row.archived_at) : null,
      delivery_ended_at: row.delivery_ended_at ? String(row.delivery_ended_at) : null,
      source_kind: (row.source_kind ? String(row.source_kind) : "legacy_unknown") as NonNullable<TaskRecord["source_kind"]>,
      change_summary_state: (row.change_summary_state ? String(row.change_summary_state) : "not_started") as NonNullable<TaskRecord["change_summary_state"]>,
      change_summary_error: row.change_summary_error ? String(row.change_summary_error) : null,
    };
  }

  getTask(taskId: string): TaskRecord {
    const task = this.findTask(taskId);
    if (!task) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
    return task;
  }

  currentTask(sessionId: SessionId): TaskRecord | null {
    const row = this.db.prepare("SELECT current_task_id FROM qm_sessions WHERE id=?").get(sessionId) as { current_task_id: string | null } | undefined;
    return row?.current_task_id ? this.findTask(row.current_task_id) : null;
  }

  closeTask(taskId: string, status: NonNullable<TaskRecord["result_status"]>, summary: string): TaskRecord {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE qm_tasks SET state='closed',revision=revision+1,finished_at=COALESCE(finished_at,?),
      archived_at=COALESCE(archived_at,?),delivery_ended_at=COALESCE(delivery_ended_at,?),closure_reason='explicit',
      last_activity_at=?,result_status=?,summary=? WHERE id=?`)
      .run(now,now,now,now,status,summary,taskId);
    return this.getTask(taskId);
  }

  archiveTask(taskId:string,reason:"superseded"|"legacy_archive"|"recovered"="superseded"):TaskRecord {
    const now=new Date().toISOString();
    this.db.prepare(`UPDATE qm_tasks SET state='closed',revision=revision+1,finished_at=COALESCE(finished_at,?),
      archived_at=COALESCE(archived_at,?),closure_reason=?,last_activity_at=? WHERE id=?`)
      .run(now,now,reason,now,taskId);
    return this.getTask(taskId);
  }

  setTaskChangeSummary(taskId:string,state:"not_started"|"complete"|"incomplete",error?:string|null):void {
    this.db.prepare("UPDATE qm_tasks SET change_summary_state=?,change_summary_error=?,revision=revision+1 WHERE id=?")
      .run(state,error??null,taskId);
  }

  recordWidgetStage(input:{taskId:string;sessionId:string;stage:"mount"|"initialized"|"first_snapshot"|"visible"|"hidden"|"teardown"|"error";
    resourceVersion:string;mountId?:string|null;displayMode?:string|null;visible?:boolean|null}):void {
    const task=this.getTask(input.taskId);
    if(task.session_id!==input.sessionId)throw new Error("TASK_SESSION_MISMATCH");
    this.db.transaction(()=>{
      if(input.mountId){
        const previous=this.db.prepare(`SELECT stage FROM qm_widget_stages WHERE task_id=? AND mount_id=? ORDER BY id DESC LIMIT 1`)
          .get(input.taskId,input.mountId) as {stage:string}|undefined;
        if(previous?.stage===input.stage)return;
        if(["mount","initialized","first_snapshot","teardown"].includes(input.stage)){
          const recorded=this.db.prepare(`SELECT 1 FROM qm_widget_stages WHERE task_id=? AND mount_id=? AND stage=? LIMIT 1`)
            .get(input.taskId,input.mountId,input.stage);
          if(recorded)return;
        }
      }
      this.db.prepare(`INSERT INTO qm_widget_stages(task_id,session_id,stage,resource_version,mount_id,display_mode,visible,observed_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(input.taskId,input.sessionId,input.stage,input.resourceVersion,input.mountId??null,input.displayMode??null,
        input.visible===undefined||input.visible===null?null:input.visible?1:0,new Date().toISOString());
      this.db.prepare(`DELETE FROM qm_widget_stages WHERE task_id=? AND id NOT IN
        (SELECT id FROM qm_widget_stages WHERE task_id=? ORDER BY id DESC LIMIT 64)`).run(input.taskId,input.taskId);
    }).immediate();
  }

  widgetStages(taskId:string):Array<{stage:string;resource_version:string;mount_id:string|null;display_mode:string|null;visible:number|null;observed_at:string}> {
    this.getTask(taskId);
    return this.db.prepare(`SELECT stage,resource_version,mount_id,display_mode,visible,observed_at FROM qm_widget_stages
      WHERE task_id=? ORDER BY id`).all(taskId) as Array<{stage:string;resource_version:string;mount_id:string|null;display_mode:string|null;visible:number|null;observed_at:string}>;
  }

  taskForRequest(sessionId: string, requestKey: string): TaskRecord|null {
    const row=this.db.prepare("SELECT id FROM qm_tasks WHERE session_id=? AND request_key=?").get(sessionId,requestKey) as {id:string}|undefined;
    return row?this.getTask(row.id):null;
  }

  adoptRemoteTask(sessionId: SessionId, taskId: string, title: string, createdAt?: string, sourceTaskId?: string): TaskRecord {
    const existing = this.findTask(taskId);
    if (!existing) {
      const now = createdAt ?? new Date().toISOString();
      const sequence = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM qm_events WHERE session_id=?")
        .get(sessionId) as { sequence: number };
      this.db.prepare(`INSERT INTO qm_tasks
        (id,session_id,title,revision,state,start_sequence,created_at,last_activity_at,finished_at,source_task_id,source_kind)
        VALUES (?,?,?,0,'active',?,?,?,NULL,?,?)`)
        .run(taskId, sessionId, title.trim().slice(0, 200) || "QuayMesh task", Number(sequence.sequence ?? 0), now, now,sourceTaskId ?? null,"federation_mirror");
    }
    const current=this.currentTask(sessionId);
    if (!existing && (!current || Date.parse(this.getTask(taskId).created_at) >= Date.parse(current.created_at)))
      this.db.prepare("UPDATE qm_sessions SET current_task_id=? WHERE id=?").run(taskId, sessionId);
    return this.getTask(taskId);
  }

  tasksForSession(sessionId: SessionId): TaskRecord[] {
    const rows = this.db.prepare(`SELECT id FROM qm_tasks WHERE session_id=? ORDER BY created_at,id`).all(sessionId) as Array<{ id: string }>;
    return rows.map((row) => this.getTask(row.id));
  }

  touchTaskMember(taskId: string, memberId: string): void {
    const row = this.db.prepare(`SELECT t.session_id task_session,m.session_id member_session
      FROM qm_tasks t JOIN qm_session_members m ON m.id=? WHERE t.id=?`)
      .get(memberId, taskId) as { task_session: string; member_session: string } | undefined;
    if (!row) throw new Error(`TASK_MEMBER_NOT_FOUND: ${taskId}:${memberId}`);
    if (row.task_session !== row.member_session) throw new Error(`TASK_MEMBER_SESSION_MISMATCH: ${taskId}:${memberId}`);
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO qm_task_members(task_id,member_id,first_seen_at) VALUES (?,?,?)`)
      .run(taskId, memberId, new Date().toISOString());
    if (inserted.changes) {
      this.taskData.inheritDiscoveredContext(taskId, row.task_session, memberId);
      this.taskData.bumpDisplay(taskId);
    }
  }

  getSession(sessionId: SessionId): SessionRecord {
    const session = this.findSession(sessionId);
    if (!session) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    return session;
  }

  findMember(sessionId: SessionId, memberId: string): SessionMember | null {
    const row = this.db
      .prepare(
        `SELECT id, node_id, workspace_id, root, source_root, mode, recovery_root, revision, online, first_seen_at, last_observed_at
         FROM qm_session_members WHERE id = ? AND session_id = ?`,
      )
      .get(memberId, sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      node_id: String(row.node_id),
      workspace_id: String(row.workspace_id),
      root: String(row.root),
      source_root: row.source_root ? String(row.source_root) : null,
      mode: row.mode === "worktree" ? "worktree" : "checkout",
      first_seen_at: String(row.first_seen_at),
      last_observed_at: String(row.last_observed_at),
      online: Number(row.online) === 1,
      revision: Number(row.revision ?? 0),
      recovery_root: String(row.recovery_root ?? row.root),
    };
  }

  getMember(sessionId: SessionId, memberId: string): SessionMember {
    const member = this.findMember(sessionId, memberId);
    if (!member) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${memberId}`);
    return member;
  }

  requireSession(ownerId: string, sessionId: SessionId): SessionRecord {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, conversation_id, title, revision, execution_state, review_state, host_state, current_task_id, selected_member_id, created_at, last_activity_at
         FROM qm_sessions
         WHERE id = ? AND owner_id = ?`,
      )
      .get(sessionId, ownerId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    }

    return this.mapSessionRecord(row);
  }

  addMember(
    sessionId: SessionId,
    nodeId: NodeId,
    workspaceId: WorkspaceId,
    root: string,
    mode: "checkout" | "worktree",
    sourceRoot: string | null,
    recoveryRoot?: string,
  ): SessionMember {
    const canonicalRoot = canonicalWorkspaceRoot(root);
    const resolvedRecoveryRoot = recoveryRoot ? canonicalWorkspaceRoot(recoveryRoot) : canonicalRoot;

    const memberTx = this.db.transaction((): SessionMember => {
      const existing = this.db
        .prepare(
          `SELECT id, session_id, node_id, workspace_id, root, source_root, mode, recovery_root, revision, snapshot_revision, snapshot_json, snapshot_updated_at, dirty_revision, exported_revision, projection_error, online, first_seen_at, last_observed_at
           FROM qm_session_members
           WHERE session_id = ? AND node_id = ? AND root = ?`,
        )
        .get(sessionId, nodeId, canonicalRoot) as Record<string, unknown> | undefined;

      const now = new Date().toISOString();
      if (existing) {
        this.db
          .prepare(
            `UPDATE qm_session_members
             SET workspace_id = ?, last_observed_at = ?, online = 1
             WHERE id = ?`,
          )
          .run(workspaceId, now, existing.id);

        return {
          id: String(existing.id),
          node_id: String(existing.node_id),
          workspace_id: workspaceId,
          root: canonicalRoot,
          source_root: existing.source_root ? String(existing.source_root) : null,
          mode: existing.mode === "worktree" ? "worktree" : "checkout",
          first_seen_at: String(existing.first_seen_at),
          last_observed_at: now,
          online: true,
          revision: Number(existing.revision ?? 0),
          recovery_root: String(existing.recovery_root ?? canonicalRoot),
        };
      }

      const memberId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO qm_session_members (
             id, session_id, node_id, workspace_id, root, source_root, mode, recovery_root, revision, snapshot_revision, snapshot_json, snapshot_updated_at, dirty_revision, exported_revision, projection_error, online, first_seen_at, last_observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, -1, NULL, NULL, 0, 0, NULL, 1, ?, ?)`,
        )
        .run(memberId, sessionId, nodeId, workspaceId, canonicalRoot, sourceRoot, mode, resolvedRecoveryRoot, now, now);

      const session = this.db
        .prepare(`SELECT selected_member_id FROM qm_sessions WHERE id = ?`)
        .get(sessionId) as { selected_member_id: string | null } | undefined;

      if (!session?.selected_member_id) {
        this.db
          .prepare(`UPDATE qm_sessions SET selected_member_id = ? WHERE id = ?`)
          .run(memberId, sessionId);
      }

      return {
        id: memberId,
        node_id: nodeId,
        workspace_id: workspaceId,
        root: canonicalRoot,
        source_root: sourceRoot,
        mode: mode === "worktree" ? "worktree" : "checkout",
        first_seen_at: now,
        last_observed_at: now,
        online: true,
        revision: 0,
        recovery_root: resolvedRecoveryRoot,
      };
    });

    return memberTx();
  }

  adoptRemoteSession(input: {
    id: SessionId;
    ownerId: string;
    conversationId: string | null;
    title: string;
  }): SessionRecord {
    const existing = this.db
      .prepare(`SELECT id,title FROM qm_sessions WHERE id = ?`)
      .get(input.id) as { id: string; title: string } | undefined;
    if (!existing) {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO qm_sessions (
             id, owner_id, conversation_id, title, revision, execution_state, review_state, host_state, current_task_id, selected_member_id, created_at, last_activity_at
           ) VALUES (?, ?, ?, ?, 0, 'idle', 'unknown', 'unknown', NULL, NULL, ?, ?)`,
        )
        .run(input.id, input.ownerId, input.conversationId, input.title, now, now);
    } else if (input.title && input.title !== "Federated session" && input.title !== existing.title) {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE qm_sessions SET title = ?, revision = revision + 1, last_activity_at = ? WHERE id = ? AND owner_id = ?`)
        .run(input.title.slice(0, 200), now, input.id, input.ownerId);
    }
    return this.getSession(input.id);
  }

  upsertRemoteMember(input: {
    id: string;
    sessionId: SessionId;
    nodeId: NodeId;
    workspaceId: WorkspaceId;
    root: string;
    sourceRoot: string | null;
    mode: "checkout" | "worktree";
    online: boolean;
    revision: number;
    lastObservedAt?: string;
  }): SessionMember {
    const now = input.lastObservedAt ?? new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM qm_session_members WHERE id = ? AND session_id = ?`)
      .get(input.id, input.sessionId) as { id: string } | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO qm_session_members (
             id, session_id, node_id, workspace_id, root, source_root, mode, recovery_root, revision, snapshot_revision, snapshot_json, snapshot_updated_at, dirty_revision, exported_revision, projection_error, online, first_seen_at, last_observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, -1, NULL, NULL, 0, 0, NULL, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.sessionId,
          input.nodeId,
          input.workspaceId,
          input.root,
          input.sourceRoot,
          input.mode,
          input.root,
          input.revision,
          input.online ? 1 : 0,
          now,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE qm_session_members
           SET node_id = ?, workspace_id = ?, root = ?, source_root = ?, mode = ?, recovery_root = ?, revision = MAX(revision, ?), online = ?, last_observed_at = ?
           WHERE id = ? AND session_id = ?`,
        )
        .run(
          input.nodeId,
          input.workspaceId,
          input.root,
          input.sourceRoot,
          input.mode,
          input.root,
          input.revision,
          input.online ? 1 : 0,
          now,
          input.id,
          input.sessionId,
        );
    }
    const selected = this.db
      .prepare(`SELECT selected_member_id FROM qm_sessions WHERE id = ?`)
      .get(input.sessionId) as { selected_member_id: string | null } | undefined;
    if (!selected?.selected_member_id) {
      this.db
        .prepare(`UPDATE qm_sessions SET selected_member_id = ? WHERE id = ?`)
        .run(input.id, input.sessionId);
    }
    return this.getMember(input.sessionId, input.id);
  }

  setMemberPresence(memberId: string, online: boolean, observedAt = new Date().toISOString()): void {
    this.db.transaction(() => {
      const previous = this.db.prepare("SELECT online FROM qm_session_members WHERE id=?").get(memberId) as { online: number } | undefined;
      if (!previous) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${memberId}`);
      this.db.prepare("UPDATE qm_session_members SET online=?,last_observed_at=? WHERE id=?")
        .run(online ? 1 : 0, observedAt, memberId);
      if (Boolean(previous.online) !== online) {
        this.db.prepare(`UPDATE qm_tasks SET revision=revision+1,last_activity_at=? WHERE state='active'
          AND id IN (SELECT task_id FROM qm_task_members WHERE member_id=?)`).run(observedAt, memberId);
      }
    }).immediate();
  }

  setMemberRevision(memberId: string, revision: number): void {
    this.db
      .prepare(`UPDATE qm_session_members SET revision = MAX(revision, ?) WHERE id = ?`)
      .run(revision, memberId);
  }

  getMembers(sessionId: SessionId): SessionMember[] {
    const rows = this.db
      .prepare(
        `SELECT id, node_id, workspace_id, root, source_root, mode, recovery_root, revision, online, first_seen_at, last_observed_at
         FROM qm_session_members
         WHERE session_id = ?
         ORDER BY first_seen_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: String(r.id),
      node_id: String(r.node_id),
      workspace_id: String(r.workspace_id),
      root: String(r.root),
      source_root: r.source_root ? String(r.source_root) : null,
      mode: r.mode === "worktree" ? "worktree" : "checkout",
      first_seen_at: String(r.first_seen_at),
      last_observed_at: String(r.last_observed_at),
      online: Number(r.online) === 1,
      revision: Number(r.revision ?? 0),
      recovery_root: String(r.recovery_root ?? r.root),
    }));
  }

  runIdsForMember(sessionId: SessionId, memberId: string, taskId?: string): string[] {
    const rows = taskId
      ? this.db.prepare(`SELECT run_id FROM qm_run_links WHERE session_id = ? AND member_id = ? AND task_id = ? ORDER BY rowid DESC`)
          .all(sessionId, memberId, taskId) as { run_id: string }[]
      : this.db.prepare(`SELECT run_id FROM qm_run_links WHERE session_id = ? AND member_id = ? ORDER BY rowid DESC`)
          .all(sessionId, memberId) as { run_id: string }[];
    return rows.map((row) => String(row.run_id));
  }

  runIdsForTask(taskId: string): string[] {
    return (this.db.prepare(`SELECT run_id FROM qm_run_links WHERE task_id = ? ORDER BY rowid`).all(taskId) as { run_id: string }[])
      .map((row) => String(row.run_id));
  }

  linkRun(sessionId: SessionId, memberId: string, runId: string, taskId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO qm_run_links (session_id, member_id, run_id, task_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, memberId, runId, taskId);
  }

  appendEvent(event: Omit<SessionEvent, "sequence">): EventAppendResult {
    const saved = this.persistEvent(event);
    this.notifyEvent(event, saved.result, saved.taskId);
    return saved.result;
  }

  async appendEventAsync(event: Omit<SessionEvent, "sequence">): Promise<EventAppendResult> {
    const saved = await this.writeAsync(() => this.persistEvent(event));
    // 提交后的监听器失败不能重放事务，持久事件仍可按 source_id 找回。
    this.notifyEvent(event, saved.result, saved.taskId);
    return saved.result;
  }

  async appendOperationEventAsync(event: Omit<SessionEvent, "sequence">): Promise<boolean> {
    const operationId = event.payload.operation_id, invocationId = event.payload.invocation_id;
    if ((event.type !== "operation_started" && event.type !== "operation_finished") || typeof operationId !== "string"
      || (invocationId !== undefined && typeof invocationId !== "string")) throw new Error("INVALID_OPERATION_EVENT");
    const saved = await this.writeAsync(() => {
      // 等锁期间尝试可能已切换；身份检查与事件及活动时间更新必须共用事务。
      const current = this.findInvocationByOperationId(operationId);
      if ((invocationId && current && current.id !== invocationId)
        || this.hasOperationFinished(operationId, invocationId)) return null;
      return this.persistEvent(event);
    });
    if (!saved) return false;
    this.notifyEvent(event, saved.result, saved.taskId);
    return saved.result.changed;
  }

  private persistEvent(event: Omit<SessionEvent, "sequence">): { result: EventAppendResult; taskId?: string } {
    const appendTx = this.db.transaction(() => {
      const currentTask = event.task_id ?? this.currentTask(event.session_id)?.id ?? null;
      const existing = this.db
        .prepare(
          `SELECT sequence FROM qm_events
           WHERE session_id = ? AND source_id = ? AND event_type = ?`,
        )
        .get(event.session_id, event.source_id, event.type) as { sequence: number } | undefined;

      const currentRevs = this.db
        .prepare(
          `SELECT s.revision AS session_rev, s.owner_id AS owner_id, m.revision AS member_rev
           FROM qm_sessions s
           JOIN qm_session_members m ON m.id = ?
           WHERE s.id = ?`,
        )
        .get(event.member_id, event.session_id) as { session_rev: number; owner_id: string; member_rev: number } | undefined;

      const currentSessionRev = Number(currentRevs?.session_rev ?? 0);
      const currentMemberRev = Number(currentRevs?.member_rev ?? 0);

      if (existing) {
        return {
          taskId: currentTask ?? undefined,
          result: {
            sequence: existing.sequence,
            sessionRevision: currentSessionRev,
            memberRevision: currentMemberRev,
            changed: false,
            ownerId: currentRevs?.owner_id ?? "",
          },
        };
      }

      const res = this.db
        .prepare(
          `INSERT INTO qm_events (session_id, task_id, member_id, source_id, event_type, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.session_id,
          currentTask,
          event.member_id,
          event.source_id,
          event.type,
          JSON.stringify(event.payload ?? {}),
          event.timestamp,
        );

      const assignedSequence = Number(res.lastInsertRowid);
      const newSessionRev = currentSessionRev + 1;
      const newMemberRev = currentMemberRev + 1;

      const isBusinessOp =
        event.type === "operation_started" ||
        event.type === "operation_finished" ||
        event.type === "file_changed" ||
        event.type === "agent_changed";

      if (isBusinessOp) {
        this.db
          .prepare(
            `UPDATE qm_sessions
             SET revision = ?, last_activity_at = ?
             WHERE id = ?`,
          )
          .run(newSessionRev, event.timestamp, event.session_id);
      } else {
        this.db
          .prepare(`UPDATE qm_sessions SET revision = ? WHERE id = ?`)
          .run(newSessionRev, event.session_id);
      }

      if (currentTask) {
        this.db.prepare(`UPDATE qm_tasks SET revision=revision+1,last_activity_at=? WHERE id=?`)
          .run(event.timestamp, currentTask);
      }

      this.db
        .prepare(
          `UPDATE qm_session_members
           SET revision = ?, dirty_revision = ?
           WHERE id = ?`,
        )
        .run(newMemberRev, newMemberRev, event.member_id);

      return {
        taskId: currentTask ?? undefined,
        result: {
          sequence: assignedSequence,
          sessionRevision: newSessionRev,
          memberRevision: newMemberRev,
          changed: true,
          ownerId: currentRevs?.owner_id ?? "",
        },
      };
    });

    // 先取得写锁再读取版本和去重键，避免其他写入提交后无法升级旧 WAL 快照。
    return appendTx.immediate();
  }

  private notifyEvent(event: Omit<SessionEvent, "sequence">, result: EventAppendResult, taskId?: string): void {
    if (result.changed) {
      for (const listener of this.changeListeners) listener({
        sessionId: event.session_id,
        memberId: event.member_id,
        ownerId: result.ownerId,
        revision: result.memberRevision,
        sequence: result.sequence,
        taskId,
      });
    }
  }

  onChange(listener: (change: { sessionId: SessionId; memberId: string; ownerId: string; revision: number; sequence: number; taskId?: string }) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  membersForNode(nodeId: NodeId): SessionMember[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, node_id, workspace_id, root, source_root, mode, recovery_root, revision, online, first_seen_at, last_observed_at
         FROM qm_session_members WHERE node_id = ? ORDER BY id`,
      )
      .all(nodeId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      node_id: String(row.node_id),
      workspace_id: String(row.workspace_id),
      root: String(row.root),
      source_root: row.source_root ? String(row.source_root) : null,
      mode: row.mode === "worktree" ? "worktree" : "checkout",
      first_seen_at: String(row.first_seen_at),
      last_observed_at: String(row.last_observed_at),
      online: Number(row.online) === 1,
      revision: Number(row.revision ?? 0),
      recovery_root: String(row.recovery_root ?? row.root),
    }));
  }

  eventsAfter(sessionId: SessionId, sequence: number, limit = 50): { events: SessionEvent[]; nextCursor: string | null } {
    const rows = this.db
      .prepare(
        `SELECT sequence, session_id, task_id, member_id, event_type, source_id, data_json, created_at
         FROM qm_events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(sessionId, sequence, limit + 1) as Record<string, unknown>[];

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    const events: SessionEvent[] = slice.map((r) => ({
      sequence: Number(r.sequence),
      session_id: String(r.session_id),
      task_id: r.task_id ? String(r.task_id) : null,
      member_id: String(r.member_id),
      type: r.event_type as SessionEvent["type"],
      source_id: String(r.source_id),
      timestamp: String(r.created_at),
      payload: JSON.parse(String(r.data_json || "{}")),
    }));

    const nextCursor = hasMore ? String(slice[slice.length - 1].sequence) : null;
    return { events, nextCursor };
  }

  putSnapshot(sessionId: SessionId, memberId: string, revision: number, snapshot: Snapshot): boolean {
    const putTx = this.db.transaction(() => {
      if (snapshot.taskId) this.taskData.putProjection(snapshot.taskId, memberId, snapshot.rev, snapshot);
      const existing = this.db
        .prepare(`SELECT snapshot_revision FROM qm_session_members WHERE id = ? AND session_id = ?`)
        .get(memberId, sessionId) as { snapshot_revision: number } | undefined;

      if (existing && existing.snapshot_revision > revision) {
        return false;
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE qm_session_members
           SET snapshot_revision = ?, snapshot_json = ?, snapshot_updated_at = ?
           WHERE id = ? AND session_id = ?`,
        )
        .run(revision, JSON.stringify(snapshot), now, memberId, sessionId);

      return true;
    });

    return putTx();
  }

  putRemoteSnapshot(sessionId: SessionId, memberId: string, sourceRevision: number, snapshot: Snapshot): void {
    this.db.transaction(()=>{
      if (snapshot.taskId && !this.taskData.putProjection(snapshot.taskId, memberId, sourceRevision, snapshot, true)) return;
      const now=new Date().toISOString();
      const result=this.db.prepare(`UPDATE qm_session_members SET snapshot_revision=?,snapshot_json=?,snapshot_updated_at=?
        WHERE id=? AND session_id=? AND (snapshot_revision<? OR (snapshot_revision=? AND snapshot_json IS NULL))`)
        .run(sourceRevision,JSON.stringify(snapshot),now,memberId,sessionId,sourceRevision,sourceRevision);
    }).immediate();
  }

  getSnapshot(sessionId: SessionId, memberId: string): { revision: number; snapshot: Snapshot | null } {
    const row = this.db
      .prepare(`SELECT snapshot_revision, snapshot_json FROM qm_session_members WHERE id = ? AND session_id = ?`)
      .get(memberId, sessionId) as { snapshot_revision: number; snapshot_json: string | null } | undefined;

    if (!row || !row.snapshot_json) {
      return { revision: Number(row?.snapshot_revision ?? -1), snapshot: null };
    }

    return {
      revision: Number(row.snapshot_revision),
      snapshot: JSON.parse(row.snapshot_json) as Snapshot,
    };
  }

  putTaskSnapshot(
    taskId: string,
    memberId: string,
    revision: number,
    snapshot: Snapshot,
    files: Array<FileSummary & { patchRef: string; versionRef: string }>,
  ): void {
    this.db.prepare(`INSERT INTO qm_task_snapshots
      (task_id,member_id,revision,snapshot_json,files_json,captured_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(task_id,member_id) DO UPDATE SET
        revision=excluded.revision,snapshot_json=excluded.snapshot_json,files_json=excluded.files_json,captured_at=excluded.captured_at`)
      .run(taskId, memberId, revision, JSON.stringify(snapshot), JSON.stringify(files), new Date().toISOString());
  }

  getTaskSnapshot(taskId: string, memberId: string): {
    revision: number;
    snapshot: Snapshot;
    files: Array<FileSummary & { patchRef: string; versionRef: string }>;
  } | null {
    const row = this.db.prepare(`SELECT revision,snapshot_json,files_json FROM qm_task_snapshots
      WHERE task_id=? AND member_id=?`).get(taskId, memberId) as { revision: number; snapshot_json: string; files_json: string } | undefined;
    return row ? {
      revision: Number(row.revision),
      snapshot: JSON.parse(row.snapshot_json) as Snapshot,
      files: JSON.parse(row.files_json) as Array<FileSummary & { patchRef: string; versionRef: string }>,
    } : null;
  }

  taskSnapshots(taskId: string): Array<{
    memberId: string;
    revision: number;
    snapshot: Snapshot;
    files: Array<FileSummary & { patchRef: string; versionRef: string }>;
  }> {
    const rows = this.db.prepare(`SELECT member_id,revision,snapshot_json,files_json FROM qm_task_snapshots
      WHERE task_id=? ORDER BY member_id`).all(taskId) as Array<{ member_id: string; revision: number; snapshot_json: string; files_json: string }>;
    return rows.map((row) => ({ memberId: row.member_id, revision: Number(row.revision),
      snapshot: JSON.parse(row.snapshot_json) as Snapshot,
      files: JSON.parse(row.files_json) as Array<FileSummary & { patchRef: string; versionRef: string }> }));
  }

  putTaskContext(taskId: string, memberId: string, path: string, content: string): void {
    this.db.prepare(`INSERT INTO qm_task_context(task_id,member_id,path,content,observed_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(task_id,member_id,path) DO UPDATE SET content=excluded.content,observed_at=excluded.observed_at`)
      .run(taskId, memberId, path, content, new Date().toISOString());
  }

  taskContext(taskId: string, memberId: string, path: string): { path: string; content: string } | null {
    const row = this.db.prepare(`SELECT path,content FROM qm_task_context
      WHERE task_id=? AND member_id=? AND path=?`).get(taskId, memberId, path) as { path: string; content: string } | undefined;
    return row ?? null;
  }

  resetTaskMemberState(sessionId: SessionId, memberId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM qm_change_baselines WHERE session_id=? AND member_id=?").run(sessionId, memberId);
      this.db.prepare("DELETE FROM qm_file_changes WHERE session_id=? AND member_id=?").run(sessionId, memberId);
      this.db.prepare("DELETE FROM qm_context_reads WHERE session_id=? AND member_id=? AND actor_id<>'host'").run(sessionId, memberId);
      this.db.prepare(`UPDATE qm_context_reads SET read_count=0
        WHERE session_id=? AND member_id=? AND actor_id='host'`).run(sessionId, memberId);
      this.db.prepare(`UPDATE qm_session_members SET snapshot_revision=-1,snapshot_json=NULL,snapshot_updated_at=NULL,
        dirty_revision=revision,exported_revision=revision WHERE session_id=? AND id=?`).run(sessionId, memberId);
    }).immediate();
  }

  updateObservedHostState(sessionId: SessionId, state: HostState): void {
    const row = this.db
      .prepare(`SELECT host_state, selected_member_id FROM qm_sessions WHERE id = ?`)
      .get(sessionId) as { host_state: string; selected_member_id: string | null } | undefined;

    if (!row || row.host_state === state) return;

    this.db
      .prepare(`UPDATE qm_sessions SET host_state = ? WHERE id = ?`)
      .run(state, sessionId);

    if (row.selected_member_id) {
      this.appendEvent({
        session_id: sessionId,
        member_id: row.selected_member_id,
        type: "host_changed",
        source_id: `host-state-${Date.now()}`,
        timestamp: new Date().toISOString(),
        payload: { state },
      });
    }
  }

  rememberAgentObservation(
    sessionId: SessionId,
    agentId: string,
    providerTurnId: string | null,
    controlRevision: number,
  ): void {
    const previous = this.lastAgentObservation(sessionId, agentId);
    // 同版本不刷新时间；仅真实终态允许修复旧 interrupt 留下的目标 turn。
    if (previous && (previous.controlRevision > controlRevision || previous.controlRevision === controlRevision
      && (previous.providerTurnId === providerTurnId || providerTurnId !== null || previous.providerTurnId === null))) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO qm_agent_observations (session_id, agent_id, provider_turn_id, control_revision, observed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, agent_id) DO UPDATE SET
           provider_turn_id = excluded.provider_turn_id,
           control_revision = excluded.control_revision,
           observed_at = excluded.observed_at
         WHERE qm_agent_observations.control_revision < excluded.control_revision
            OR (qm_agent_observations.control_revision = excluded.control_revision
              AND qm_agent_observations.provider_turn_id IS NOT NULL AND excluded.provider_turn_id IS NULL
              AND EXISTS (SELECT 1 FROM local_agent_sessions a WHERE a.id = excluded.agent_id
                AND a.control_revision = excluded.control_revision AND a.control_state = 'terminal'
                AND a.status IN ('idle', 'error', 'stopped') AND a.provider_turn_id IS NULL))`,
      )
      .run(sessionId, agentId, providerTurnId, controlRevision, now);
  }

  async rememberAgentObservationsAsync(
    sessionId: SessionId,
    observations: ReadonlyArray<{agentId: string; providerTurnId: string | null; controlRevision: number}>,
  ): Promise<boolean[]> {
    const matches = (observation: typeof observations[number]) => {
      const saved = this.lastAgentObservation(sessionId, observation.agentId);
      return saved?.providerTurnId === observation.providerTurnId && saved.controlRevision === observation.controlRevision;
    };
    const unchanged = observations.map(matches);
    if (unchanged.every(Boolean)) return unchanged;
    // 整批共享短预算；等待结束前不返回，也不安排后台授权刷新。
    return this.writeAsync(() => {
      for (const item of observations) this.rememberAgentObservation(sessionId, item.agentId, item.providerTurnId, item.controlRevision);
      return observations.map(matches);
    }, {timeoutMs: 150});
  }

  rememberAgentOperation(input: {
    operationId: string;
    agentId: string;
    sessionId: SessionId;
    memberId: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO qm_agent_operations
           (operation_id, agent_id, session_id, member_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           session_id = excluded.session_id,
           member_id = excluded.member_id,
           updated_at = excluded.updated_at`,
      )
      .run(input.operationId, input.agentId, input.sessionId, input.memberId, now, now);
  }

  completeAgentOperation(operationId: string): void {
    this.db.prepare("UPDATE qm_agent_operations SET updated_at = ? WHERE operation_id = ?")
      .run(new Date().toISOString(), operationId);
  }

  agentForOperation(operationId: string, sessionId: SessionId, memberId: string): AgentOperationLink | null {
    const row = this.db
      .prepare(
        `SELECT operation_id, agent_id, session_id, member_id
         FROM qm_agent_operations
         WHERE operation_id = ? AND session_id = ? AND member_id = ?`,
      )
      .get(operationId, sessionId, memberId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      operationId: String(row.operation_id),
      agentId: String(row.agent_id),
      sessionId: String(row.session_id),
      memberId: String(row.member_id),
    };
  }

  pendingAgentOperations(): Array<{
    operationId: string;
    agentId: string;
    sessionId: SessionId;
    memberId: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT operations.operation_id, operations.agent_id, operations.session_id, operations.member_id
         FROM qm_agent_operations AS operations
         LEFT JOIN qm_invocations AS current ON current.operation_id=operations.operation_id
           AND NOT EXISTS(SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=current.id)
         WHERE NOT EXISTS (
           SELECT 1
           FROM qm_events AS events
           WHERE events.event_type = 'operation_finished'
             AND (
               events.source_id = operations.operation_id || '-finish'
               OR json_extract(events.data_json, '$.operation_id') = operations.operation_id
             )
             AND (current.id IS NULL OR json_extract(events.data_json,'$.invocation_id')=current.id
               OR current.retry_of_invocation_id IS NULL AND json_extract(events.data_json,'$.invocation_id') IS NULL)
         )
         ORDER BY operations.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      operationId: String(row.operation_id),
      agentId: String(row.agent_id),
      sessionId: String(row.session_id),
      memberId: String(row.member_id),
    }));
  }

  lastAgentObservation(
    sessionId: SessionId,
    agentId: string,
  ): { providerTurnId: string | null; controlRevision: number; observedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT provider_turn_id, control_revision, observed_at
         FROM qm_agent_observations
         WHERE session_id = ? AND agent_id = ?`,
      )
      .get(sessionId, agentId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      providerTurnId: row.provider_turn_id ? String(row.provider_turn_id) : null,
      controlRevision: Number(row.control_revision),
      observedAt: String(row.observed_at),
    };
  }

  recentRecoveryRows(
    ownerId: string,
    root: string,
    limit = 30,
    cursor?: string,
    sessionId?: SessionId,
  ): { rows: RecoveryRow[]; nextCursor: string | null } {
    const canonicalRoot = canonicalPathIdentity(resolve(root));
    const parsedCursor = cursor ? parseRecoveryCursor(cursor) : null;
    const cursorTime = parsedCursor?.updatedAt ?? "9999-12-31T23:59:59.999Z";
    const boundedLimit = Math.max(1, Math.min(100, limit));

    const members = this.db
      .prepare(
        `SELECT m.id AS member_id, m.session_id, m.node_id, m.root, s.title, s.execution_state, s.last_activity_at, s.review_state
         FROM qm_session_members m
         JOIN qm_sessions s ON s.id = m.session_id
         WHERE s.owner_id = ? AND m.root = ?
           AND (
             s.last_activity_at < ?
             OR (? IS NOT NULL AND s.last_activity_at = ? AND s.id < ?)
           )
           AND (? IS NULL OR s.id = ?)
         ORDER BY s.last_activity_at DESC, s.id DESC
         LIMIT ?`,
      )
      .all(
        ownerId,
        canonicalRoot,
        cursorTime,
        parsedCursor?.sessionId ?? null,
        cursorTime,
        parsedCursor?.sessionId ?? null,
        sessionId ?? null,
        sessionId ?? null,
        boundedLimit + 1,
      ) as Record<string, unknown>[];

    const hasMore = members.length > boundedLimit;
    const slice = hasMore ? members.slice(0, boundedLimit) : members;

    const rows: RecoveryRow[] = slice.map((m) => {
      const sessionId = String(m.session_id);
      const memberId = String(m.member_id);
      const latestCompleted = this.db
        .prepare(
          `SELECT data_json
           FROM qm_events AS e
           WHERE session_id = ? AND member_id = ? AND event_type = 'operation_finished'
             AND NOT EXISTS(SELECT 1 FROM qm_invocations i
               WHERE i.operation_id=json_extract(e.data_json,'$.operation_id') AND i.retry_of_invocation_id IS NOT NULL
                 AND NOT EXISTS(SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=i.id)
                 AND COALESCE(json_extract(e.data_json,'$.invocation_id'),'')<>i.id)
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get(sessionId, memberId) as { data_json: string } | undefined;
      const eventPayload = latestCompleted
        ? JSON.parse(latestCompleted.data_json) as Record<string, unknown>
        : {};
      const commandCounts = this.db
        .prepare(
          `WITH operation_events AS (
             SELECT
               json_extract(data_json, '$.operation_id') AS operation_id,
               CASE
                 WHEN event_type = 'operation_finished' THEN json_extract(data_json, '$.status')
                 WHEN json_extract(data_json, '$.status') IS NOT NULL THEN json_extract(data_json, '$.status')
                 ELSE 'running'
               END AS status,
               ROW_NUMBER() OVER (
                 PARTITION BY json_extract(data_json, '$.operation_id')
                 ORDER BY sequence DESC
               ) AS event_rank
             FROM qm_events AS e
             WHERE session_id = ? AND member_id = ?
               AND event_type IN ('operation_started', 'operation_finished')
               AND json_extract(data_json, '$.operation_id') IS NOT NULL
               AND NOT EXISTS(SELECT 1 FROM qm_invocations i
                 WHERE i.operation_id=json_extract(e.data_json,'$.operation_id') AND i.retry_of_invocation_id IS NOT NULL
                   AND NOT EXISTS(SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=i.id)
                   AND COALESCE(json_extract(e.data_json,'$.invocation_id'),'')<>i.id)
           )
           SELECT
             SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status IN ('accepted','queued','running') THEN 1 ELSE 0 END) AS running
           FROM operation_events
           WHERE event_rank = 1`,
        )
        .get(sessionId, memberId) as Record<string, unknown>;
      const agentCounts = this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN json_extract(data_json, '$.state') = 'done' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN json_extract(data_json, '$.state') = 'working' THEN 1 ELSE 0 END) AS running,
             SUM(CASE WHEN json_extract(data_json, '$.state') = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM qm_events
           WHERE session_id = ? AND member_id = ? AND event_type = 'agent_changed'`,
        )
        .get(sessionId, memberId) as Record<string, unknown>;
      const fileRows = this.db
        .prepare(
          `SELECT json_extract(data_json, '$.path') AS path
           FROM qm_events
           WHERE session_id = ? AND member_id = ? AND event_type = 'file_changed'
           ORDER BY sequence DESC`,
        )
        .all(sessionId, memberId) as Array<{ path: string | null }>;
      const files = [...new Set(fileRows.map((row) => row.path).filter((path): path is string => Boolean(path)))];
      const verification = this.db
        .prepare(
          `SELECT data_json FROM qm_events
           WHERE session_id = ? AND member_id = ? AND event_type = 'verification_recorded'
           ORDER BY sequence DESC LIMIT 1`,
        )
        .get(sessionId, memberId) as { data_json: string } | undefined;
      const verificationPayload = verification ? JSON.parse(verification.data_json) as Record<string, unknown> : {};
      const runningAgents = Number(agentCounts?.running ?? 0);
      const unresolved = String(m.execution_state) === "interrupted";
      return {
        session_id: sessionId,
        title: String(m.title),
        updated_at: String(m.last_activity_at),
        execution_state: String(m.execution_state),
        latest_completed: latestCompleted ? String(eventPayload.label || eventPayload.kind || "") : "",
        files: files.slice(0, 5),
        remaining_files: Math.max(0, files.length - 5),
        commands: {
          succeeded: Number(commandCounts?.succeeded ?? 0),
          failed: Number(commandCounts?.failed ?? 0),
          running: Number(commandCounts?.running ?? 0),
          last_summary: latestCompleted ? String(eventPayload.label || eventPayload.kind || "") : "",
        },
        agents: {
          completed: Number(agentCounts?.completed ?? 0),
          running: runningAgents,
          failed: Number(agentCounts?.failed ?? 0),
        },
        verification: verification ? String(verificationPayload.decision || "unknown") : "unknown",
        next_step: runningAgents > 0 ? "等待已启动代理完成" : unresolved ? "核对结果未知的操作" : "根据当前用户任务决定后续操作",
        detail_ref: sessionId,
        node_id: String(m.node_id),
        root: String(m.root),
      };
    });

    const last = slice.at(-1);
    const nextCursor = hasMore && last
      ? encodeRecoveryCursor(String(last.last_activity_at), String(last.session_id))
      : null;
    return { rows, nextCursor };
  }

  memberRevision(memberId: string): number {
    const row = this.db
      .prepare(`SELECT revision FROM qm_session_members WHERE id = ?`)
      .get(memberId) as { revision: number } | undefined;
    if (!row) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${memberId}`);
    return Number(row.revision);
  }

  setExecutionState(sessionId: SessionId, state: ExecutionState): void {
    this.db.prepare(`UPDATE qm_sessions SET execution_state = ? WHERE id = ?`).run(state, sessionId);
  }

  setReviewState(sessionId: SessionId, state: ReviewState): void {
    if (this.db.inTransaction) throw Object.assign(new Error("SQLITE_WRITE_OUTER_TRANSACTION: Review notifications require a committed transaction."),
      { code: "SQLITE_WRITE_OUTER_TRANSACTION" });
    const saved = this.db.transaction(() => this.persistReviewState(sessionId, state)).immediate();
    for (const { event, result, taskId } of saved) this.notifyEvent(event, result, taskId);
  }

  async setReviewStateAsync(sessionId: SessionId, state: ReviewState, taskId?: string): Promise<void> {
    const expectedTaskId = taskId ?? this.getSession(sessionId).current_task_id;
    const saved = await this.writeAsync(() => this.persistReviewState(sessionId, state, expectedTaskId));
    // 状态与事件一起提交；监听器失败不能撤销提交或触发 SQL 重放。
    for (const { event, result, taskId } of saved) this.notifyEvent(event, result, taskId);
  }

  private persistReviewState(sessionId: SessionId, state: ReviewState, expectedTaskId?: string | null): Array<{
    event: Omit<SessionEvent, "sequence">; result: EventAppendResult; taskId?: string;
  }> {
    const session = this.getSession(sessionId);
    if (expectedTaskId !== undefined && session.current_task_id !== expectedTaskId)
      throw new Error("STALE_CONTEXT: The session task changed while the review update waited for its write lock.");
    if (session.review_state === state) return [];
    this.db.prepare(`UPDATE qm_sessions SET review_state = ? WHERE id = ?`).run(state, sessionId);
    return session.members.map(member => {
      const event: Omit<SessionEvent, "sequence"> = {
        session_id: sessionId, task_id: expectedTaskId ?? session.current_task_id, member_id: member.id, type: "verification_recorded",
        source_id: `review-${randomUUID()}`, timestamp: new Date().toISOString(),
        payload: { decision: state },
      };
      return { event, ...this.persistEvent(event) };
    });
  }

  setHostState(sessionId: SessionId, state: HostState): void {
    this.db.prepare(`UPDATE qm_sessions SET host_state = ? WHERE id = ?`).run(state, sessionId);
  }

  findInvocation(ownerId: string, transportInstanceId: string, requestId: string): InvocationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, transport_instance_id, request_id, session_id, member_id, tool_name,
                arguments_json, operation_id, task_id, retry_of_invocation_id, state, effect, result_ref, result_json, created_at, finished_at, response_at
         FROM qm_invocations
         WHERE owner_id = ? AND transport_instance_id = ? AND request_id = ?`,
      )
      .get(ownerId, transportInstanceId, requestId) as InvocationRow | undefined;
    return row ?? null;
  }

  findInvocationByOperation(ownerId: string, operationId: string): InvocationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, transport_instance_id, request_id, session_id, member_id, tool_name,
                arguments_json, operation_id, task_id, retry_of_invocation_id, state, effect, result_ref, result_json, created_at, finished_at, response_at
         FROM qm_invocations AS i
         WHERE owner_id = ? AND operation_id = ?
           AND NOT EXISTS (SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=i.id)
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ownerId, operationId) as InvocationRow | undefined;
    return row ?? null;
  }

  findInvocationByOperationId(operationId: string): InvocationRow | null {
    const row = this.db
      .prepare(
        `SELECT id, owner_id, transport_instance_id, request_id, session_id, member_id, tool_name,
                arguments_json, operation_id, task_id, retry_of_invocation_id, state, effect, result_ref, result_json, created_at, finished_at, response_at
         FROM qm_invocations AS i
         WHERE operation_id = ?
           AND NOT EXISTS (SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=i.id)
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(operationId) as InvocationRow | undefined;
    return row ?? null;
  }

  reserveInvocation(input: {
    id: string;
    ownerId: string;
    transportInstanceId: string;
    requestId: string;
    sessionId: SessionId;
    memberId: string;
    toolName: string;
    argumentsJson: string;
    operationId?: string | null;
    operationKey?: string;
    taskId?: string;
    retryOfInvocationId?: string;
  }): InvocationRow {
    return this.db.transaction(() => {
      const sameRequest = this.findInvocation(input.ownerId, input.transportInstanceId, input.requestId);
      if (sameRequest) return sameRequest;
      let previous: InvocationRow | null = null;
      if (input.operationKey) {
        const saved = this.findKeyedInvocation(input.ownerId, input.sessionId, input.memberId, input.operationKey);
        if (saved) {
          if (saved.id !== input.retryOfInvocationId || !retryableAdmission(saved)) return saved;
          const task = saved.task_id ? this.getTask(saved.task_id) : null;
          if (!task || task.state !== "active" || task.id !== input.taskId || this.taskData.finalization(task.id)
            || saved.session_id !== input.sessionId || saved.member_id !== input.memberId
            || saved.tool_name !== input.toolName || saved.arguments_json !== input.argumentsJson
            || saved.operation_id !== input.operationId) throw new Error("OPERATION_RETRY_SCOPE_MISMATCH");
          previous = saved;
        }
      }
      this.db.prepare(`INSERT INTO qm_invocations
        (id,owner_id,transport_instance_id,request_id,session_id,member_id,tool_name,
         arguments_json,operation_id,task_id,retry_of_invocation_id,state,effect,result_ref,result_json,created_at,finished_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted','not_started',NULL,NULL,?,NULL)`)
        .run(input.id,input.ownerId,input.transportInstanceId,input.requestId,input.sessionId,input.memberId,
          input.toolName,input.argumentsJson,input.operationId ?? null,input.taskId ?? null,previous?.id ?? null,new Date().toISOString());
      if (input.operationKey) {
        const member = this.getMember(input.sessionId, input.memberId);
        if (previous) {
          const switched = this.db.prepare(`UPDATE qm_operation_keys SET invocation_id=?
            WHERE owner_id=? AND node_id=? AND root=? AND operation_key=? AND invocation_id=?`)
            .run(input.id,input.ownerId,member.node_id,member.root,input.operationKey,previous.id);
          if (switched.changes !== 1) throw new Error("OPERATION_RETRY_SUPERSEDED");
        } else this.db.prepare("INSERT INTO qm_operation_keys(owner_id,node_id,root,operation_key,invocation_id) VALUES(?,?,?,?,?)")
            .run(input.ownerId,member.node_id,member.root,input.operationKey,input.id);
      }
      return this.findInvocation(input.ownerId,input.transportInstanceId,input.requestId)!;
    }).immediate();
  }

  findKeyedInvocation(ownerId: string, sessionId: string, memberId: string, key: string): InvocationRow | null {
    const member = this.getMember(sessionId, memberId);
    const row = this.db.prepare(`SELECT i.* FROM qm_operation_keys k JOIN qm_invocations i ON i.id=k.invocation_id
      WHERE k.owner_id=? AND k.node_id=? AND k.root=? AND k.operation_key=?`)
      .get(ownerId,member.node_id,member.root,key) as InvocationRow | undefined;
    return row ?? null;
  }

  reconcileFinishedInvocations(): number {
    return this.db.prepare(`UPDATE qm_invocations AS i SET
      state=COALESCE(
        (SELECT json_extract(e.data_json,'$.status') FROM qm_events e
          WHERE json_extract(e.data_json,'$.operation_id')=i.operation_id AND e.event_type='operation_finished'
            AND (json_extract(e.data_json,'$.invocation_id')=i.id
              OR json_extract(e.data_json,'$.invocation_id') IS NULL AND i.retry_of_invocation_id IS NULL)
            AND json_extract(e.data_json,'$.status') IN ('succeeded','failed','cancelled')
          ORDER BY e.sequence DESC LIMIT 1),
        (SELECT CASE o.status WHEN 'completed' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' ELSE 'unknown' END
          FROM console_operations o WHERE o.id=i.operation_id)),
      effect=CASE WHEN (SELECT status FROM console_operations WHERE id=i.operation_id)='reconciliation_required'
        THEN 'unknown' ELSE 'completed' END,
      finished_at=COALESCE((SELECT finished_at FROM console_operations WHERE id=i.operation_id),i.finished_at)
      WHERE i.state IN ('accepted','queued','running')
      AND NOT EXISTS(SELECT 1 FROM qm_invocations n WHERE n.retry_of_invocation_id=i.id) AND EXISTS(
        SELECT 1 FROM console_operations o WHERE o.id=i.operation_id AND (i.retry_of_invocation_id IS NULL OR o.request_key=i.id)
          AND o.status IN ('completed','failed','cancelled','reconciliation_required')
      )`).run().changes;
  }

  allocateProcessHandle(operationId: string): number {
    this.db.prepare("INSERT OR IGNORE INTO qm_process_handles(operation_id) VALUES(?)").run(operationId);
    return (this.db.prepare("SELECT handle FROM qm_process_handles WHERE operation_id=?").get(operationId) as {handle:number}).handle;
  }

  operationForHandle(handle: number): string | null {
    return (this.db.prepare("SELECT operation_id FROM qm_process_handles WHERE handle=?").get(handle) as {operation_id:string}|undefined)?.operation_id ?? null;
  }

  updateInvocation(input: {
    ownerId: string;
    transportInstanceId: string;
    requestId: string;
    state?: OperationState;
    effect?: InvocationRow["effect"];
    operationId?: string | null;
    resultRef?: string | null;
    result?: unknown;
    finished?: boolean;
    responded?: boolean;
  }): InvocationRow {
    return this.db.transaction(() => {
      const current = this.findInvocation(input.ownerId, input.transportInstanceId, input.requestId);
      if (!current) throw new Error("INVOCATION_NOT_FOUND");
      // 已被后续尝试取代的记录及其原始错误回执不可改写。
      if (this.db.prepare("SELECT 1 FROM qm_invocations WHERE retry_of_invocation_id=?").get(current.id)) return current;
      const terminal = ![OperationState.accepted, OperationState.queued, OperationState.running].includes(current.state);
      const final = [OperationState.succeeded,OperationState.failed,OperationState.cancelled].includes(current.state);
      const regresses = input.state !== undefined && input.state !== current.state && (final
        || terminal && [OperationState.accepted, OperationState.queued, OperationState.running].includes(input.state));
      this.db.prepare(`UPDATE qm_invocations SET state=?,effect=?,operation_id=?,result_ref=?,result_json=?,
        finished_at=?,response_at=? WHERE owner_id=? AND transport_instance_id=? AND request_id=?`)
        .run(
          regresses ? current.state : input.state ?? current.state,
          regresses ? current.effect : input.effect ?? current.effect,
          input.operationId === undefined ? current.operation_id : input.operationId,
          input.resultRef === undefined ? current.result_ref : input.resultRef,
          input.result === undefined ? current.result_json : JSON.stringify(input.result),
          current.finished_at ?? (input.finished ? new Date().toISOString() : null),
          current.response_at ?? (input.responded ? new Date().toISOString() : null),
          input.ownerId,input.transportInstanceId,input.requestId,
        );
      return this.findInvocation(input.ownerId,input.transportInstanceId,input.requestId)!;
    }).immediate();
  }

  saveCheckpoint(taskId: string, memberId: string, value: import("./checkpoints.js").TaskCheckpoint): void {
    const task=this.getTask(taskId);
    this.taskData.requireScope(taskId,task.session_id,memberId);
    this.db.prepare(`INSERT INTO qm_task_checkpoints(task_id,member_id,goal,decisions_json,next_action,evidence_refs_json,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,member_id) DO UPDATE SET goal=excluded.goal,
        decisions_json=excluded.decisions_json,next_action=excluded.next_action,evidence_refs_json=excluded.evidence_refs_json,
        updated_at=excluded.updated_at`).run(taskId,memberId,value.goal,JSON.stringify(value.decisions),
          value.next_action,JSON.stringify(value.evidence_refs),new Date().toISOString());
    this.taskData.bumpDisplay(taskId);
  }

  checkpoints(taskId: string, memberIds: string[]) {
    if(!memberIds.length) return [];
    const rows=this.db.prepare(`SELECT member_id,goal,decisions_json,next_action,evidence_refs_json,updated_at
      FROM qm_task_checkpoints WHERE task_id=? AND member_id IN (${memberIds.map(()=>"?").join(",")}) ORDER BY updated_at`)
      .all(taskId,...memberIds) as Array<{member_id:string;goal:string;decisions_json:string;next_action:string;evidence_refs_json:string;updated_at:string}>;
    return rows.map(row=>({source:"model" as const,member_id:row.member_id,goal:row.goal,
      decisions:JSON.parse(row.decisions_json) as string[],next_action:row.next_action,
      evidence_refs:JSON.parse(row.evidence_refs_json) as string[],updated_at:row.updated_at}));
  }

  saveContextResult(ownerId: string, sessionId: string, memberId: string, taskId: string | undefined, input: unknown, result: unknown): string {
    const member = this.getMember(sessionId,memberId);
    const id = `ctx_${randomUUID().replaceAll("-","")}`;
    this.db.prepare(`INSERT INTO qm_context_results(id,owner_id,node_id,root,task_id,input_json,result_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id,ownerId,member.node_id,canonicalWorkspaceRoot(member.root),
        taskId ?? null,JSON.stringify(input),JSON.stringify(result),new Date().toISOString());
    return id;
  }

  contextResult(ownerId: string, nodeId: string, root: string, id: string): {input:unknown;result:unknown} {
    const row = this.db.prepare(`SELECT r.input_json,r.result_json,t.finished_at FROM qm_context_results r
      LEFT JOIN qm_tasks t ON t.id=r.task_id WHERE r.id=? AND r.owner_id=? AND r.node_id=? AND r.root=?`)
      .get(id,ownerId,nodeId,canonicalWorkspaceRoot(root)) as {input_json:string;result_json:string;finished_at:string|null}|undefined;
    if (!row) throw new Error("CONTEXT_RESULT_NOT_FOUND");
    if (row.finished_at && Date.parse(row.finished_at)+7*86400_000<Date.now()) throw new Error("CONTEXT_RESULT_EXPIRED");
    return {input:JSON.parse(row.input_json),result:JSON.parse(row.result_json)};
  }

  pruneContextResults(): void {
    this.db.prepare(`DELETE FROM qm_context_results WHERE task_id IN
      (SELECT id FROM qm_tasks WHERE datetime(finished_at,'+7 days')<datetime('now'))
      OR (task_id IS NULL AND datetime(created_at,'+7 days')<datetime('now'))`).run();
  }

  requireCommand(ownerId: string, nodeId: string, root: string, operationId: string) {
    const invocation = this.findInvocationByOperation(ownerId, operationId);
    if (!invocation || !["exec_command", "bash"].includes(invocation.tool_name)) throw new Error("COMMAND_NOT_FOUND");
    const member = this.getMember(invocation.session_id, invocation.member_id);
    // 历史命令校验已保存的根身份，目录清理后也无需再次访问文件系统。
    if (member.node_id !== nodeId || canonicalPathIdentity(resolve(member.root)) !== canonicalPathIdentity(resolve(root))) {
      throw new Error("COMMAND_WORKSPACE_MISMATCH");
    }
    const row = this.db.prepare(`SELECT o.status,o.finished_at,o.created_at,l.task_id,t.finished_at AS task_finished_at
      FROM console_operations o LEFT JOIN qm_run_links l ON l.run_id=o.run_id
      LEFT JOIN qm_tasks t ON t.id=l.task_id WHERE o.id=?`).get(operationId) as {
        status:string; finished_at:string|null; created_at:string; task_id:string|null; task_finished_at:string|null;
      } | undefined;
    if (!row) throw new Error("OPERATION_NOT_FOUND");
    const retainedUntil = row.finished_at && row.task_finished_at
      ? new Date(Math.max(Date.parse(row.finished_at),Date.parse(row.task_finished_at)) + 7 * 86400_000).toISOString()
      : null;
    const envelope = invocation.result_json ? JSON.parse(invocation.result_json) : null;
    const response = envelope?.kind === "result" ? envelope.value : envelope;
    return {...row,session_id:invocation.session_id,operation_id:operationId,retained_until:retainedUntil,
      execution:response?.structuredContent?.execution as {
        platform:string;shell:string;transport:"pipe"|"pty";pty_capability:"pipe_fallback"|"optional_node_pty";
      } | undefined};
  }

  expiredCommandOutputs(): Array<{operation_id:string; retained_until:string}> {
    return this.db.prepare(`SELECT o.id AS operation_id,
      strftime('%Y-%m-%dT%H:%M:%fZ',max(o.finished_at,t.finished_at),'+7 days') AS retained_until
      FROM console_operations o JOIN qm_run_links l ON l.run_id=o.run_id JOIN qm_tasks t ON t.id=l.task_id
      WHERE o.kind='command' AND o.finished_at IS NOT NULL AND t.finished_at IS NOT NULL
        AND datetime(max(o.finished_at,t.finished_at),'+7 days') < datetime('now')`).all() as Array<{operation_id:string; retained_until:string}>;
  }

  resolveMemberForWorkspace(input: {
    ownerId: string;
    conversationId: string | null;
    workspaceIds: string[];
    nodeId?: string;
  }): { sessionId: SessionId; member: SessionMember } | null {
    const matches = this.membersByWorkspaceIds(input.workspaceIds).filter((candidate) => {
      if (input.nodeId && candidate.member.node_id !== input.nodeId) return false;
      const session = this.getSession(candidate.sessionId);
      if (session.owner_id !== input.ownerId) return false;
      if (input.conversationId && session.conversation_id !== input.conversationId) return false;
      return true;
    });
    if (matches.length === 0) return null;
    if (!input.conversationId && matches.length > 1) {
      throw new Error(`SESSION_BINDING_AMBIGUOUS: ${input.workspaceIds[0] ?? "unknown"}`);
    }
    return matches[0] ?? null;
  }

  membersByWorkspaceIds(workspaceIds: string[]): Array<{ sessionId: SessionId; member: SessionMember }> {
    const ids = [...new Set(workspaceIds.filter((id) => id.length > 0))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT session_id, id FROM qm_session_members WHERE workspace_id IN (${placeholders}) ORDER BY first_seen_at ASC, id ASC`,
      )
      .all(...ids) as Array<{ session_id: string; id: string }>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      member: this.getMember(String(row.session_id), String(row.id)),
    }));
  }

  memberOwner(memberId: string): { sessionId: SessionId; member: SessionMember } {
    const row = this.db
      .prepare(`SELECT session_id FROM qm_session_members WHERE id = ?`)
      .get(memberId) as { session_id: string } | undefined;
    if (!row) throw new Error(`SESSION_MEMBER_NOT_FOUND: ${memberId}`);
    return { sessionId: String(row.session_id), member: this.getMember(String(row.session_id), memberId) };
  }

  runIdsForSession(sessionId: SessionId): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT run_id FROM qm_run_links WHERE session_id = ? ORDER BY rowid DESC`)
      .all(sessionId) as Array<{ run_id: string }>;
    return rows.map((row) => String(row.run_id));
  }

  upsertContextRead(input: ContextReadInput): void {
    if (input.taskId) { this.taskData.upsertContext(input.taskId, input); return; }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO qm_context_reads (
           session_id, member_id, actor_id, path, kind, state, content_ref, read_count, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, member_id, actor_id, path, kind) DO UPDATE SET
           state = CASE
             WHEN excluded.state = 'read' THEN 'read'
             WHEN qm_context_reads.state = 'read' THEN 'read'
             WHEN excluded.state = 'loaded' THEN 'loaded'
             ELSE qm_context_reads.state
           END,
           content_ref = COALESCE(excluded.content_ref, qm_context_reads.content_ref),
           read_count = qm_context_reads.read_count + ?,
           observed_at = excluded.observed_at`,
      )
      .run(
        input.sessionId,
        input.memberId,
        input.actorId,
        input.path,
        input.kind,
        input.state,
        input.contentRef ?? null,
        input.incrementRead ? 1 : 0,
        now,
        input.incrementRead ? 1 : 0,
      );
  }

  contextReads(sessionId: SessionId, memberId?: string, taskId?: string): ContextReadRow[] {
    if (taskId) return this.taskData.context(taskId, sessionId, memberId);
    const rows = memberId
      ? this.db
          .prepare(
            `SELECT session_id, member_id, actor_id, path, kind, state, content_ref, read_count, observed_at
             FROM qm_context_reads WHERE session_id = ? AND member_id = ?
             ORDER BY path, actor_id`,
          )
          .all(sessionId, memberId)
      : this.db
          .prepare(
            `SELECT session_id, member_id, actor_id, path, kind, state, content_ref, read_count, observed_at
             FROM qm_context_reads WHERE session_id = ?
             ORDER BY member_id, path, actor_id`,
          )
          .all(sessionId);
    return (rows as ContextReadRow[]).map((row) => ({ ...row, read_count: Number(row.read_count) }));
  }

  getChangeBaseline(sessionId: SessionId, memberId: string, repoRoot: string, taskId?: string): ChangeBaselineRow | null {
    if (taskId) return this.taskData.baseline(taskId, sessionId, memberId, repoRoot);
    const canonicalRoot = canonicalWorkspaceRoot(repoRoot);
    const row = this.db
      .prepare(
        `SELECT session_id, member_id, repo_root, baseline_ref, latest_ref, coverage
         FROM qm_change_baselines WHERE session_id = ? AND member_id = ? AND repo_root = ?`,
      )
      .get(sessionId, memberId, canonicalRoot) as ChangeBaselineRow | undefined;
    return row ?? null;
  }

  changeBaselines(sessionId: SessionId, memberId: string, taskId?: string): ChangeBaselineRow[] {
    if (taskId) return this.taskData.baselines(taskId, sessionId, memberId);
    return this.db
      .prepare(
        `SELECT session_id, member_id, repo_root, baseline_ref, latest_ref, coverage
         FROM qm_change_baselines
         WHERE session_id = ? AND member_id = ?
         ORDER BY repo_root`,
      )
      .all(sessionId, memberId) as ChangeBaselineRow[];
  }

  putChangeBaseline(input: ChangeBaselineRow, taskId?: string): void {
    if (taskId) { this.taskData.putBaseline(taskId, input); return; }
    const canonicalRoot = canonicalWorkspaceRoot(input.repo_root);
    this.db
      .prepare(
        `INSERT INTO qm_change_baselines (
           session_id, member_id, repo_root, baseline_ref, latest_ref, coverage
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, member_id, repo_root) DO UPDATE SET
           baseline_ref = qm_change_baselines.baseline_ref,
           latest_ref = excluded.latest_ref,
           coverage = excluded.coverage`,
      )
      .run(
        input.session_id,
        input.member_id,
        canonicalRoot,
        input.baseline_ref,
        input.latest_ref,
        input.coverage,
      );
  }

  sessionStartedAt(sessionId: SessionId): number {
    const row = this.db
      .prepare(`SELECT created_at FROM qm_sessions WHERE id = ?`)
      .get(sessionId) as { created_at: string } | undefined;
    if (!row) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    return Date.parse(row.created_at);
  }

  eventsByType(sessionId: SessionId, type: SessionEvent["type"]): SessionEvent[] {
    return this.eventsForSession(sessionId).filter((event) => event.type === type);
  }

  openingMetadata(sessionId: SessionId, memberId: string): Record<string, unknown> | undefined {
    const row=this.db.prepare(`SELECT data_json FROM qm_events WHERE session_id=? AND member_id=?
      AND event_type='session_opened' AND json_type(data_json,'$.metadata')='object' ORDER BY sequence LIMIT 1`)
      .get(sessionId,memberId) as {data_json:string}|undefined;
    return row?(JSON.parse(row.data_json) as {metadata:Record<string,unknown>}).metadata:undefined;
  }

  findOperationEvent(operationId: string): SessionEvent | null {
    const row = this.db
      .prepare(
        `SELECT sequence, session_id, task_id, member_id, event_type, source_id, data_json, created_at
         FROM qm_events
         WHERE event_type = 'operation_started'
           AND (source_id = ? OR json_extract(data_json, '$.operation_id') = ?)
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(operationId, operationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sequence: Number(row.sequence),
      session_id: String(row.session_id),
      task_id: row.task_id ? String(row.task_id) : null,
      member_id: String(row.member_id),
      type: row.event_type as SessionEvent["type"],
      source_id: String(row.source_id),
      timestamp: String(row.created_at),
      payload: JSON.parse(String(row.data_json || "{}")),
    };
  }

  hasOperationFinished(operationId: string, invocationId?: string): boolean {
    const current = this.findInvocationByOperationId(operationId);
    const attemptId = invocationId ?? current?.id ?? null;
    return Boolean(this.db
      .prepare(
        `SELECT 1 FROM qm_events
         WHERE event_type = 'operation_finished'
           AND (source_id = ? OR json_extract(data_json, '$.operation_id') = ?)
           AND (? IS NULL OR json_extract(data_json,'$.invocation_id')=?
             OR (? AND json_extract(data_json,'$.invocation_id') IS NULL))
         LIMIT 1`,
      )
      .get(`${operationId}-finish`, operationId, attemptId, attemptId, current?.retry_of_invocation_id ? 0 : 1));
  }

  replaceFileSummaries(
    sessionId: SessionId,
    memberId: string,
    versionRef: string,
    files: Array<FileSummary & { patchRef: string }>,
    taskId?: string,
  ): void {
    if (taskId) { this.taskData.replaceFiles(taskId, sessionId, memberId, versionRef, files); return; }
    const replace = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM qm_file_changes WHERE session_id = ? AND member_id = ? AND version_ref = ?`)
        .run(sessionId, memberId, versionRef);
      const statement = this.db.prepare(
        `INSERT INTO qm_file_changes (
           session_id, member_id, version_ref, file_id, status, path, from_path, additions, removals,
           hash, large, binary, coverage, revertible, patch_ref, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const file of files) {
        statement.run(
          sessionId,
          memberId,
          versionRef,
          file.id,
          file.status,
          file.path,
          file.from,
          file.additions,
          file.removals,
          file.hash,
          file.large ? 1 : 0,
          file.binary ? 1 : 0,
          file.coverage,
          file.revertible ? 1 : 0,
          file.patchRef,
          now,
        );
      }
    });
    replace();
  }

  fileSummaries(sessionId: SessionId, memberId: string, taskId?: string): Array<FileSummary & { patchRef: string; versionRef: string }> {
    if (taskId) return this.taskData.files(taskId, sessionId, memberId);
    const rows = this.db
      .prepare(
        `SELECT version_ref, file_id, status, path, from_path, additions, removals, hash, large, binary,
                coverage, revertible, patch_ref
         FROM qm_file_changes
         WHERE session_id = ? AND member_id = ?
           AND version_ref IN (
             SELECT latest_ref FROM qm_change_baselines
             WHERE session_id = ? AND member_id = ?
           )
         ORDER BY path`,
      )
      .all(sessionId, memberId, sessionId, memberId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.file_id),
      member_id: memberId,
      status: row.status as FileSummary["status"],
      path: String(row.path),
      from: row.from_path === null ? null : String(row.from_path),
      additions: row.additions === null ? null : Number(row.additions),
      removals: row.removals === null ? null : Number(row.removals),
      hash: String(row.hash),
      large: Number(row.large) === 1,
      binary: Number(row.binary) === 1,
      coverage: row.coverage as FileSummary["coverage"],
      revertible: Number(row.revertible) === 1,
      patchRef: String(row.patch_ref),
      versionRef: String(row.version_ref),
    }));
  }

  fileSummariesForSession(sessionId: SessionId, taskId?: string): Array<FileSummary & { patchRef: string; versionRef: string }> {
    if (taskId) return this.taskData.files(taskId, sessionId);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT f.version_ref, f.file_id, f.member_id, f.status, f.path, f.from_path, f.additions, f.removals,
                f.hash, f.large, f.binary, f.coverage, f.revertible, f.patch_ref
         FROM qm_file_changes f
         JOIN qm_change_baselines b
           ON b.session_id = f.session_id AND b.member_id = f.member_id AND b.latest_ref = f.version_ref
         WHERE f.session_id = ?
         ORDER BY f.member_id, f.path`,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.file_id),
      member_id: String(row.member_id),
      status: row.status as FileSummary["status"],
      path: String(row.path),
      from: row.from_path === null ? null : String(row.from_path),
      additions: row.additions === null ? null : Number(row.additions),
      removals: row.removals === null ? null : Number(row.removals),
      hash: String(row.hash),
      large: Number(row.large) === 1,
      binary: Number(row.binary) === 1,
      coverage: row.coverage as FileSummary["coverage"],
      revertible: Number(row.revertible) === 1,
      patchRef: String(row.patch_ref),
      versionRef: String(row.version_ref),
    }));
  }

  ownerIdsForRoot(root: string): string[] {
    const canonicalRoot = canonicalWorkspaceRoot(root);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.owner_id
         FROM qm_sessions s JOIN qm_session_members m ON m.session_id = s.id
         WHERE m.root = ?
         ORDER BY s.owner_id`,
      )
      .all(canonicalRoot) as Array<{ owner_id: string }>;
    return rows.map((row) => String(row.owner_id));
  }

  eventsForSession(sessionId: SessionId, limit?: number): SessionEvent[] {
    const rows = limit === undefined
      ? this.db.prepare(`SELECT sequence, session_id, task_id, member_id, event_type, source_id, data_json, created_at
          FROM qm_events WHERE session_id = ? ORDER BY sequence ASC`).all(sessionId) as Record<string, unknown>[]
      : this.db.prepare(`SELECT sequence, session_id, task_id, member_id, event_type, source_id, data_json, created_at
          FROM qm_events WHERE session_id = ? ORDER BY sequence DESC LIMIT ?`)
          .all(sessionId, Math.max(1, Math.min(10_000, limit))) as Record<string, unknown>[];
    if (limit !== undefined) rows.reverse();
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      session_id: String(row.session_id),
      task_id: row.task_id ? String(row.task_id) : null,
      member_id: String(row.member_id),
      type: row.event_type as SessionEvent["type"],
      source_id: String(row.source_id),
      timestamp: String(row.created_at),
      payload: JSON.parse(String(row.data_json || "{}")),
    }));
  }

  eventsForTask(taskId: string): SessionEvent[] {
    const rows = this.db.prepare(`SELECT sequence, session_id, task_id, member_id, event_type, source_id, data_json, created_at
      FROM qm_events WHERE task_id=? ORDER BY sequence ASC`).all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      sequence: Number(row.sequence), session_id: String(row.session_id), task_id: String(row.task_id), member_id: String(row.member_id),
      type: row.event_type as SessionEvent["type"], source_id: String(row.source_id), timestamp: String(row.created_at),
      payload: JSON.parse(String(row.data_json || "{}")),
    }));
  }

  taskMemberIds(taskId: string): string[] {
    return (this.db.prepare(`SELECT member_id FROM qm_task_members WHERE task_id=?
      UNION SELECT DISTINCT member_id FROM qm_events WHERE task_id=? ORDER BY member_id`).all(taskId, taskId) as Array<{ member_id: string }>)
      .map((row) => String(row.member_id));
  }

  pendingProjectionJobs(): { sessionId: SessionId; memberId: string; dirtyRevision: number }[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, id AS member_id, dirty_revision
         FROM qm_session_members
         WHERE dirty_revision > exported_revision`,
      )
      .all() as Record<string, unknown>[];

    return rows.map((r) => ({
      sessionId: String(r.session_id),
      memberId: String(r.member_id),
      dirtyRevision: Number(r.dirty_revision),
    }));
  }

  markProjectionExported(sessionId: SessionId, memberId: string, revision: number): void {
    this.db
      .prepare(
        `UPDATE qm_session_members
         SET exported_revision = MAX(exported_revision, ?), projection_error = NULL
         WHERE id = ? AND session_id = ?`,
      )
      .run(revision, memberId, sessionId);
  }

  markProjectionError(sessionId: SessionId, memberId: string, message: string): void {
    this.db
      .prepare(
        `UPDATE qm_session_members
         SET projection_error = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(message, memberId, sessionId);
  }

  close(): void {
    if (this.ownedDatabase) {
      this.db.close();
    }
  }

  private mapSessionRecord(row: Record<string, unknown>): SessionRecord {
    const id = String(row.id);
    return {
      id,
      owner_id: String(row.owner_id),
      conversation_id: row.conversation_id ? String(row.conversation_id) : null,
      title: String(row.title),
      revision: Number(row.revision ?? 0),
      created_at: String(row.created_at),
      last_activity_at: String(row.last_activity_at),
      execution_state: (row.execution_state as ExecutionState) || ExecutionState.idle,
      review_state: (row.review_state as ReviewState) || ReviewState.unknown,
      host_state: (row.host_state as HostState) || HostState.unknown,
      current_task_id: row.current_task_id ? String(row.current_task_id) : null,
      selected_member_id: String(row.selected_member_id ?? ""),
      members: this.getMembers(id),
    };
  }
}

function encodeRecoveryCursor(updatedAt: string, sessionId: string): string {
  return Buffer.from(JSON.stringify({ updated_at: updatedAt, session_id: sessionId }), "utf8").toString("base64url");
}

function parseRecoveryCursor(cursor: string): { updatedAt: string; sessionId: string } {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof parsed.updated_at !== "string" || typeof parsed.session_id !== "string" || !parsed.updated_at || !parsed.session_id) {
    throw new Error("INVALID_RECOVERY_CURSOR");
  }
  return { updatedAt: new Date(parsed.updated_at).toISOString(), sessionId: parsed.session_id };
}
