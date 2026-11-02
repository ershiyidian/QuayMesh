import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/client.js";
import { runSqliteWrite } from "../db/async-write.js";
import type { SqliteWriteReporter } from "../db/write-diagnostics.js";
import { logEvent } from "../logger.js";
import { diagnosticError, type ServerDiagnostics } from "../server-diagnostics.js";
import type { ServerConfig } from "../config.js";
import { ExecutionCoordinator } from "../execution-coordinator.js";
import { isTaskBindingAuthority } from "../tasks/task-binding.js";
import type { ProcessSessionManager } from "../process-sessions.js";
import type { LocalAgentStore } from "../local-agent-store.js";
import type { WorkLedger } from "../work-ledger.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { SessionChangeCollector } from "./changes.js";
import { ContextReadRecorder } from "./context-reads.js";
import { SessionOutputStore } from "./output.js";
import { SessionProjector } from "./projection.js";
import { RecoveryService } from "./recovery.js";
import { SessionReverter } from "./revert.js";
import { SessionService } from "./service.js";
import { SessionToolRecorder } from "./tool-recording.js";
import { AgentOperationTracker } from "./agent-operations.js";
import { SessionStore } from "./store.js";
import { SessionStatusReader } from "./status-reader.js";
import { registerSessionAppTools } from "./application-tools.js";
import {
  ExecutionState,
  HostState,
  OperationState,
  ReviewState,
  type InvocationContext,
  type RecoveryRow,
  type SessionMember,
  type SessionRecord,
} from "./types.js";

type SessionDatabase = Database.Database;

export interface SessionRuntimePaths {
  stateDir: string;
  defaultRecoveryRoot?: string;
}

export interface SessionRuntimeOptions {
  config: ServerConfig;
  workspaces: WorkspaceRegistry;
  ledger: WorkLedger;
  agents?: LocalAgentStore;
  execution?: ExecutionCoordinator;
  processSessions?: ProcessSessionManager;
  consoleUrl?: string | null;
  diagnostics?: ServerDiagnostics["record"];
  allowBackgroundMaintenance?: () => boolean;
}

export interface SessionRuntime {
  store: SessionStore;
  statusReader: SessionStatusReader;
  output: SessionOutputStore;
  changes: SessionChangeCollector;
  context: ContextReadRecorder;
  projector: SessionProjector;
  recovery: RecoveryService;
  service: SessionService;
  recorder: SessionToolRecorder;
  agentOperations: AgentOperationTracker;
  reverter: SessionReverter;
  execution: ExecutionCoordinator;
  registerAppTools(server: Parameters<typeof registerSessionAppTools>[0]): void;
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

export function sessionDatabasePath(stateDir: string): string {
  return join(stateDir, "quaymesh.sqlite");
}

export function openSessionDatabase(stateDir: string, writeDiagnostics?: SqliteWriteReporter): SessionStore {
  return new SessionStore(openDatabase(stateDir).sqlite, true, writeDiagnostics);
}

export function openSessionStore(stateDir: string): { store: SessionStore; database: SessionDatabase } {
  const database = openDatabase(stateDir).sqlite;
  return { store: new SessionStore(database, false), database };
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  const { config, workspaces, ledger, agents, diagnostics } = options;
  const store = openSessionDatabase(config.stateDir, diagnostics
    ? event => diagnostics("sqlite_write", { ...event }, "info") : undefined);
  const allowMaintenance = options.allowBackgroundMaintenance ?? (() => true);
  let startupMaintenancePending = true;
  const startupMaintenance = () => {
    if (!startupMaintenancePending || !allowMaintenance()) return;
    store.reconcileFinishedInvocations();
    // Old handoff intents must not close a goal or block its inbox after upgrade.
    store.taskData.rejectLegacyHandoffFinalizations();
    startupMaintenancePending = false;
  };
  startupMaintenance();
  const output = new SessionOutputStore(config.stateDir);
  const statusReader = new SessionStatusReader(config.stateDir, config.federation?.nodeId ?? "local",
    event => options.diagnostics ? options.diagnostics("mcp_status_read", {...event}) : console.info(JSON.stringify(event)));
  options.processSessions?.setHandleStore({
    allocate: id => store.writeAsync(() => store.allocateProcessHandle(id)), resolve: handle => store.operationForHandle(handle),
  });
  const execution = options.execution ?? new ExecutionCoordinator(config.stateDir);
  const ownsExecution = options.execution === undefined;
  const changes = new SessionChangeCollector(store, config.stateDir, execution);
  const context = new ContextReadRecorder(store);
  let reverter: SessionReverter;
  const projector = new SessionProjector(
    store,
    config.stateDir,
    options.consoleUrl ?? null,
    undefined,
    config.federation?.nodeId ?? "local",
    {capture:changes,report:event=>options.diagnostics
      ? options.diagnostics("session_projection_read",{...event}) : console.info(JSON.stringify(event))},
  );
  const recovery = new RecoveryService(store, config.stateDir);
  reverter = new SessionReverter(store, config.stateDir, execution, changes, agents);
  const service = new SessionService(store, workspaces, ledger, agents, changes, projector, recovery,
    config.federation?.nodeId ?? "local", execution, isTaskBindingAuthority(config));
  const disposeProjectionUpdates = store.onChange((change) => {
    const member = store.getMember(change.sessionId, change.memberId);
    if (member.node_id === (config.federation?.nodeId ?? "local")) projector.schedule(change.sessionId, change.memberId, change.taskId);
  });
  changes.setCaptureListener((sessionId, memberId, taskId) => service.refreshMember(sessionId, memberId, taskId));
  const recorder = new SessionToolRecorder(store, workspaces, service, changes, projector, execution, config.federation?.nodeId ?? "local");
  const lastOutputActivity=new Map<string,number>();
  options.processSessions?.setOutputSink({
    async open(operationId, command) {
      const event = store.findOperationEvent(operationId);
      if (!event) throw new Error(`OPERATION_NOT_FOUND: ${operationId}`);
      await output.open(event.session_id, operationId, operationId);
      await store.appendEventAsync({
        session_id: event.session_id, task_id: event.task_id ?? null, member_id: event.member_id,
        type: "operation_started", source_id: `${operationId}-output`, timestamp: new Date().toISOString(),
        payload: { ...event.payload, operation_id: operationId, command_id: operationId, kind: "command", label: command,
          output_ref: operationId, output_available: true },
      });
    },
    async append(operationId, chunk) {
      await output.append(operationId,chunk);
      const now=Date.now(),previous=lastOutputActivity.get(operationId)??0;
      if(now-previous<1000)return;
      const event=store.findOperationEvent(operationId);
      if(!event)return;
      await store.appendEventAsync({session_id:event.session_id,task_id:event.task_id??null,member_id:event.member_id,
        type:"operation_output",source_id:`${operationId}-output-${now}`,timestamp:new Date(now).toISOString(),
        payload:{operation_id:operationId,bytes:Buffer.byteLength(chunk),actor:"execution"}});
      lastOutputActivity.set(operationId,now);
    },
    finish: (operationId, exitCode, signal) => output.finish(operationId, exitCode, signal),
    fail: (operationId, errorCode, exitCode, signal) => output.fail(operationId, errorCode, exitCode, signal),
  });
  if (!agents) throw new Error("SESSION_LOCAL_AGENT_STORE_REQUIRED");
  const agentOperations = new AgentOperationTracker(agents, service, store, {
    ledger,
    onError: (error, identity, retry) => {
      const fields = {
        operationId: identity.operationId, agentId: identity.agentId,
        sessionId: identity.sessionId, memberId: identity.memberId,
        retryAttempt: retry.attempt, retryDelayMs: retry.delayMs, ...diagnosticError(error),
      };
      if (options.diagnostics) options.diagnostics("agent_operation_poll_failed", fields, "error");
      else logEvent(config.logging, "error", "agent_operation_poll_failed", fields);
    },
  });
  agentOperations.restore();
  const pendingProcessOperations = new Set<Promise<void>>();
  const unfinishedProcesses = new Map<string,import("../process-sessions.js").ProcessFinish>();
  const finalizingProcesses = new Set<string>();
  const closeProcessOperation = (finish: import("../process-sessions.js").ProcessFinish): Promise<void> | undefined => {
    const operationId=finish.sessionOperationId;
    if (!operationId) return;
    unfinishedProcesses.set(operationId,finish);
    if(finalizingProcesses.has(operationId))return;
    finalizingProcesses.add(operationId);
    const pending = service.finishOperationById(operationId, {
      status: finish.disposition === "reconciliation_required"
        ? OperationState.unknown
        : finish.cancelled
          ? OperationState.cancelled
        : finish.success
          ? OperationState.succeeded
          : OperationState.failed,
      effect: finish.disposition === "reconciliation_required" ? "unknown"
        : finish.disposition === "incomplete_output" ? "partial" : "completed",
      exit_code: finish.exitCode ?? null,
      error_code: finish.disposition === "reconciliation_required" ? "PROCESS_RECONCILIATION_REQUIRED"
        : finish.disposition === "incomplete_output" ? "OUTPUT_INCOMPLETE" : null,
      error_message: finish.success ? null : finish.signal ? `Process terminated by signal ${finish.signal}.` : `Process exited with code ${finish.exitCode ?? "unknown"}.`,
    }).then(()=>{unfinishedProcesses.delete(operationId);}).finally(() => {
      pendingProcessOperations.delete(pending);finalizingProcesses.delete(operationId);
    });
    pendingProcessOperations.add(pending);
    return pending;
  };
  options.processSessions?.addFinishListener(closeProcessOperation);
  let closed = false;
  const maintenance = new AbortController();
  const reportMaintenance = (message: string, error: unknown) => {
    if (closed) return;
    try { console.error(message, error); } catch { /* 下一周期继续恢复。 */ }
  };
  let retentionWork: Promise<void> | undefined;
  const expireResults = () => {
    if (closed || retentionWork || !allowMaintenance()) return;
    retentionWork = (async () => {
      await store.writeAsync(() => { if (allowMaintenance()) store.pruneContextResults(); }, { signal: maintenance.signal });
      for (const row of store.expiredCommandOutputs()) {
        if (!allowMaintenance()) break;
        await output.expire(row.operation_id,row.retained_until);
      }
    })().catch(error => reportMaintenance("QuayMesh 输出清理失败", error))
      .finally(() => { retentionWork = undefined; });
  };
  let observationWork: Promise<void> | undefined;
  const observationTimer=setInterval(()=>{
    if(closed || observationWork || !allowMaintenance())return;
    observationWork = (async () => {
      await store.writeAsync(() => {
        if (!allowMaintenance()) return;
        startupMaintenance();
        store.reconcileFinishedInvocations();
      }, { signal: maintenance.signal, diagnosticSource: "session_reconcile" });
      await runSqliteWrite(ledger.db, () => {
        if (!allowMaintenance()) return;
        ledger.observeOperations([...recorder.activeOperationIds(),...options.processSessions?.activeOperationIds()??[]]);
        ledger.reconcileTerminalOperations();
        ledger.reconcileArchivedTaskRuns();
      }, { signal: maintenance.signal });
      for(const finish of unfinishedProcesses.values()){
        if (!allowMaintenance()) break;
        const pending=closeProcessOperation(finish);
        if(pending)void pending.catch(error=>reportMaintenance("QuayMesh 进程收尾重试失败",error));
      }
    })().catch(error => reportMaintenance("QuayMesh 会话状态核对失败，将在下一周期重试", error))
      .finally(() => { observationWork = undefined; });
  },5000);
  observationTimer.unref();
  const finalizationTimer=setInterval(()=>{
    if(!closed && allowMaintenance())void service.retryFinalizations().catch(error=>reportMaintenance("QuayMesh 收尾协调失败",error));
  },30_000);
  finalizationTimer.unref();
  const retentionTimer = setInterval(expireResults, 3600_000);
  retentionTimer.unref();
  expireResults();
  const remoteChangeListeners = new Set<() => void>();
  const stopStoreChangeListener = store.onChange((change) => {
    for (const listener of remoteChangeListeners) listener();
  });

  return {
    store,
    output,
    changes,
    context,
    projector,
    statusReader,
    recovery,
    service,
    recorder,
    agentOperations,
    reverter,
    execution,
    onChange(listener) {
      remoteChangeListeners.add(listener);
      return () => remoteChangeListeners.delete(listener);
    },
    registerAppTools(server) {
      registerSessionAppTools(server, {
        config,
        store,
        projector,
        changes,
        output,
        context,
        reverter,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      statusReader.close();
      clearInterval(observationTimer);
      clearInterval(finalizationTimer);
      clearInterval(retentionTimer);
      maintenance.abort();
      await Promise.allSettled([retentionWork, observationWork]);
      await recorder.close();
      options.processSessions?.setHandleStore(undefined);
      options.processSessions?.removeFinishListener(closeProcessOperation);
      options.processSessions?.setOutputSink(undefined);
      stopStoreChangeListener();
      remoteChangeListeners.clear();
      await Promise.allSettled([...pendingProcessOperations]);
      await agentOperations.close();
      await service.close();
      await changes.close();
      disposeProjectionUpdates();
      await projector.close();
      await recovery.close();
      await output.close();
      try { if (ownsExecution) await execution.closeAsync(); }
      finally { store.close(); }
    },
  };
}

export function requireInvocationContext(context: InvocationContext | undefined): InvocationContext {
  if (!context) throw new Error("MISSING_OPERATION_CONTEXT");
  if (!context.owner_id) throw new Error("MISSING_AUTHENTICATED_OWNER");
  if (!context.transport_instance_id) throw new Error("MISSING_TRANSPORT_INSTANCE");
  if (context.request_id === undefined || context.request_id === null || context.request_id === "") {
    throw new Error("MISSING_REQUEST_ID");
  }
  return context;
}

export function sessionRows(store: SessionStore, ownerId: string, root: string, limit = 30): { rows: RecoveryRow[]; nextCursor: string | null } {
  return store.recentRecoveryRows(ownerId, root, limit);
}

export function sessionRecordForContext(store: SessionStore, context: InvocationContext): SessionRecord {
  return store.requireSession(context.owner_id, context.session_id);
}

export function memberForContext(store: SessionStore, context: InvocationContext): SessionMember | null {
  return store.getMembers(context.session_id).find((member) => member.id === context.member_id) ?? null;
}

export function defaultSessionState(now = new Date()): { execution: ExecutionState; review: ReviewState; host: HostState } {
  void now;
  return { execution: ExecutionState.idle, review: ReviewState.unknown, host: HostState.unknown };
}

export function sessionRootForMember(member: SessionMember): string {
  return member.recovery_root || member.root;
}
