import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    recoveryKind: text("recovery_kind"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const workspaceConversationBindings = sqliteTable(
  "workspace_conversation_bindings",
  {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    taskName: text("task_name"),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    effort: text("effort"),
    providerSessionId: text("provider_session_id"),
    contextKey: text("context_key"),
    contextSignature: text("context_signature"),
    workItemId: text("work_item_id"),
    recoveryType: text("recovery_type"),
    parentProviderSessionId: text("parent_provider_session_id"),
    controlState: text("control_state").notNull().default("terminal"),
    providerTurnId: text("provider_turn_id"),
    controlRevision: integer("control_revision").notNull().default(0),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    errorCode: text("error_code"),
    errorRetryable: text("error_retryable"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
    index("agent_context_affinity").on(table.workspaceRoot, table.workspaceId, table.profileName, table.workItemId, table.contextKey, table.contextSignature),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type WorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferSelect;
export type NewWorkspaceConversationBindingRow = typeof workspaceConversationBindings.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;

export const executionClaims = sqliteTable("execution_claims", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  ownerPid: integer("owner_pid").notNull(),
  kind: text("kind").notNull(),
  checkoutRoot: text("checkout_root").notNull(),
  agentId: text("agent_id"),
  accessMode: text("access_mode").notNull().default("write"),
  threadKey: text("thread_key"),
  resources: text("resources").notNull(),
  acquiredAt: text("acquired_at").notNull(),
});

export const executionClaimReconciliations = sqliteTable("execution_claim_reconciliations", {
  id: text("id").primaryKey(),
  claimId: text("claim_id").notNull(),
  kind: text("kind").notNull(),
  ownerPid: integer("owner_pid").notNull(),
  agentId: text("agent_id"),
  checkoutRoot: text("checkout_root").notNull(),
  runId: text("run_id"),
  reason: text("reason").notNull(),
  evidence: text("evidence").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("execution_claim_reconciliations_claim_idx").on(table.claimId)]);

export const executionWaiters = sqliteTable("execution_waiters", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(), ownerId: text("owner_id").notNull(), ownerPid: integer("owner_pid").notNull(),
  kind: text("kind").notNull(), checkoutRoot: text("checkout_root").notNull(), agentId: text("agent_id"),
  threadKey: text("thread_key"), accessMode: text("access_mode").notNull(), resources: text("resources").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [index("execution_waiters_order").on(table.sequence)]);

export const agentContinueKeys = sqliteTable("agent_continue_keys", {
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(), requestHash: text("request_hash").notNull(),
}, (table) => [primaryKey({ columns: [table.agentId, table.requestKey] })]);

export const agentTaskKeys = sqliteTable("agent_task_keys", {
  workspaceRoot: text("workspace_root").notNull(),
  workspaceScope: text("workspace_scope").notNull(),
  target: text("target").notNull(),
  taskKey: text("task_key").notNull(),
  requestHash: text("request_hash").notNull(),
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id),
}, (table) => [primaryKey({ columns: [table.workspaceRoot, table.workspaceScope, table.target, table.taskKey] })]);

export const agentUsageSnapshots = sqliteTable("agent_usage_snapshots", {
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id),
  threadId: text("thread_id").notNull(),
  turnId: text("turn_id").notNull(),
  totalTokens: integer("total_tokens").notNull(),
  totals: text("totals").notNull(),
  lastRequest: text("last_request"),
  baseline: text("baseline"),
  baselineKind: text("baseline_kind").notNull(),
  observedAt: text("observed_at").notNull(),
  providerVersion: text("provider_version"),
}, (table) => [primaryKey({ columns: [table.agentId, table.threadId, table.turnId] })]);

export const consoleProjects = sqliteTable("console_projects", {
  id: text("id").primaryKey(), root: text("root").notNull().unique(), name: text("name").notNull(), createdAt: text("created_at").notNull(),
});
export const consoleWorkItems = sqliteTable("console_work_items", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id),
  itemKey: text("item_key").notNull(), title: text("title").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("console_item_identity").on(table.projectId, table.itemKey)]);
export const consoleWorkRuns = sqliteTable("console_work_runs", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id),
  itemId: text("item_id").notNull().references(() => consoleWorkItems.id), workspaceId: text("workspace_id"),
  runKey: text("run_key").notNull(), requestHash: text("request_hash").notNull(), origin: text("origin").notNull(),
  status: text("status").notNull().default("running"), acceptance: text("acceptance").notNull().default("pending"),
  summary: text("summary").notNull().default(""), evidence: text("evidence").notNull().default("[]"),
  revision: integer("revision").notNull().default(1), createdAt: text("created_at").notNull(), finishedAt: text("finished_at"),
  lastActivityAt: text("last_activity_at"), leaseExpiresAt: text("lease_expires_at"), interruptedAt: text("interrupted_at"),
  resumeCount: integer("resume_count").notNull().default(0),
}, (table) => [uniqueIndex("console_run_identity").on(table.itemId, table.runKey), index("console_runs_project").on(table.projectId, table.createdAt, table.id)]);

export const consoleSessions = sqliteTable("console_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  csrf: text("csrf").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at").notNull(),
}, (table) => [index("console_sessions_expires_at_idx").on(table.expiresAt)]);

export type ConsoleSessionRow = typeof consoleSessions.$inferSelect;
export type NewConsoleSessionRow = typeof consoleSessions.$inferInsert;
export const consoleOperations = sqliteTable("console_operations", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => consoleWorkRuns.id), requestKey: text("request_key").notNull(),
  kind: text("kind").notNull(), label: text("label").notNull(), status: text("status").notNull(), evidence: text("evidence").notNull().default("[]"),
  createdAt: text("created_at").notNull(), finishedAt: text("finished_at"),
}, (table) => [uniqueIndex("console_operation_identity").on(table.runId, table.requestKey)]);
export const consoleThreads = sqliteTable("console_threads", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id),
  agentId: text("agent_id").notNull().references(() => localAgentSessions.id), instanceId: text("instance_id").notNull(), threadId: text("thread_id").notNull(),
  createdHere: integer("created_here").notNull(), identityVerified: integer("identity_verified").notNull(), origin: text("origin").notNull(),
  title: text("title").notNull(), nameStatus: text("name_status").notNull().default("pending"), externalActivity: integer("external_activity").notNull().default(0),
  protected: integer("protected").notNull().default(0), archiveState: text("archive_state").notNull().default("active"), revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("console_thread_identity").on(table.instanceId, table.threadId), index("console_threads_project").on(table.projectId, table.updatedAt)]);
export const consoleExecutions = sqliteTable("console_executions", {
  id: text("id").primaryKey(), runId: text("run_id").notNull().references(() => consoleWorkRuns.id), agentId: text("agent_id").notNull().references(() => localAgentSessions.id),
  provider: text("provider").notNull(), managedThreadId: text("managed_thread_id").references(() => consoleThreads.id), providerTurnId: text("provider_turn_id"),
  status: text("status").notNull(), requested: integer("requested").notNull().default(0), providerFinished: integer("provider_finished").notNull().default(0),
  baseline: text("baseline"), cumulative: text("cumulative"), delta: text("delta"), usageQuality: text("usage_quality").notNull().default("not_used"),
  boundaryReason: text("boundary_reason").notNull().default("no_provider_request"), requestedModel: text("requested_model"), requestedEffort: text("requested_effort"),
  createdAt: text("created_at").notNull(), finishedAt: text("finished_at"),
}, (table) => [index("console_exec_run").on(table.runId, table.createdAt), index("console_exec_agent").on(table.agentId, table.createdAt),
  uniqueIndex("console_exec_provider_turn").on(table.managedThreadId, table.providerTurnId).where(sql`${table.providerTurnId} is not null`)]);
export const consoleArchiveBatches = sqliteTable("console_archive_batches", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull().references(() => consoleProjects.id), mode: text("mode").notNull(),
  status: text("status").notNull(), requestHash: text("request_hash").notNull(), acceptPartial: integer("accept_partial").notNull(), externalIdle: integer("external_idle").notNull(),
  createdAt: text("created_at").notNull(), expiresAt: text("expires_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const consoleArchiveEntries = sqliteTable("console_archive_entries", {
  batchId: text("batch_id").notNull().references(() => consoleArchiveBatches.id), managedThreadId: text("managed_thread_id").notNull().references(() => consoleThreads.id),
  expectedRevision: integer("expected_revision").notNull(), expectedSnapshot: text("expected_snapshot"), status: text("status").notNull(), reason: text("reason"), updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.batchId, table.managedThreadId] })]);


export const quaymeshSessions = sqliteTable(
  "qm_sessions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    conversationId: text("conversation_id"),
    title: text("title").notNull(),
    revision: integer("revision").notNull().default(0),
    executionState: text("execution_state").notNull().default("idle"),
    reviewState: text("review_state").notNull().default("unknown"),
    hostState: text("host_state").notNull().default("unknown"),
    selectedMemberId: text("selected_member_id"),
    createdAt: text("created_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
  },
  (table) => [
    uniqueIndex("qm_session_conversation")
      .on(table.ownerId, table.conversationId)
      .where(sql`${table.conversationId} is not null`),
  ],
);

export const quaymeshSessionMembers = sqliteTable(
  "qm_session_members",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => quaymeshSessions.id),
    nodeId: text("node_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    root: text("root").notNull(),
    sourceRoot: text("source_root"),
    mode: text("mode").notNull(),
    recoveryRoot: text("recovery_root").notNull(),
    revision: integer("revision").notNull().default(0),
    snapshotRevision: integer("snapshot_revision").notNull().default(-1),
    snapshotJson: text("snapshot_json"),
    snapshotUpdatedAt: text("snapshot_updated_at"),
    dirtyRevision: integer("dirty_revision").notNull().default(0),
    exportedRevision: integer("exported_revision").notNull().default(0),
    projectionError: text("projection_error"),
    online: integer("online").notNull().default(1),
    firstSeenAt: text("first_seen_at").notNull(),
    lastObservedAt: text("last_observed_at").notNull(),
  },
  (table) => [
    uniqueIndex("qm_member_unique_root").on(table.sessionId, table.nodeId, table.root),
  ],
);

export const quaymeshInvocations = sqliteTable(
  "qm_invocations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    transportInstanceId: text("transport_instance_id").notNull(),
    requestId: text("request_id").notNull(),
    sessionId: text("session_id")
      .notNull()
      .references(() => quaymeshSessions.id),
    memberId: text("member_id")
      .notNull()
      .references(() => quaymeshSessionMembers.id),
    toolName: text("tool_name").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    operationId: text("operation_id"),
    state: text("state").notNull(),
    effect: text("effect").notNull(),
    resultRef: text("result_ref"),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("qm_invocation_unique_request").on(table.ownerId, table.transportInstanceId, table.requestId),
  ],
);

export const quaymeshRunLinks = sqliteTable(
  "qm_run_links",
  {
    sessionId: text("session_id").notNull(),
    memberId: text("member_id").notNull(),
    runId: text("run_id").notNull().unique(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.memberId, table.runId] }),
  ],
);

export const quaymeshEvents = sqliteTable(
  "qm_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    memberId: text("member_id").notNull(),
    sourceId: text("source_id").notNull(),
    eventType: text("event_type").notNull(),
    dataJson: text("data_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("qm_event_unique_source").on(table.sessionId, table.sourceId, table.eventType),
    index("qm_event_session_sequence").on(table.sessionId, table.sequence),
  ],
);

export const quaymeshContextReads = sqliteTable(
  "qm_context_reads",
  {
    sessionId: text("session_id").notNull(),
    memberId: text("member_id").notNull(),
    actorId: text("actor_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    contentRef: text("content_ref"),
    readCount: integer("read_count").notNull().default(0),
    observedAt: text("observed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.memberId, table.actorId, table.path, table.kind] }),
  ],
);

export const quaymeshChangeBaselines = sqliteTable(
  "qm_change_baselines",
  {
    sessionId: text("session_id").notNull(),
    memberId: text("member_id").notNull(),
    repoRoot: text("repo_root").notNull(),
    baselineRef: text("baseline_ref").notNull(),
    latestRef: text("latest_ref").notNull(),
    coverage: text("coverage").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.memberId, table.repoRoot] }),
  ],
);

export const quaymeshFileChanges = sqliteTable(
  "qm_file_changes",
  {
    sessionId: text("session_id").notNull(),
    memberId: text("member_id").notNull(),
    versionRef: text("version_ref").notNull(),
    fileId: text("file_id").notNull(),
    status: text("status").notNull(),
    path: text("path").notNull(),
    fromPath: text("from_path"),
    additions: integer("additions"),
    removals: integer("removals"),
    hash: text("hash").notNull(),
    large: integer("large").notNull().default(0),
    binary: integer("binary").notNull().default(0),
    coverage: text("coverage").notNull(),
    revertible: integer("revertible").notNull().default(0),
    patchRef: text("patch_ref").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.memberId, table.versionRef, table.fileId] }),
    index("qm_file_changes_member").on(table.sessionId, table.memberId, table.path),
  ],
);

export const quaymeshAgentObservations = sqliteTable(
  "qm_agent_observations",
  {
    sessionId: text("session_id").notNull(),
    agentId: text("agent_id").notNull(),
    providerTurnId: text("provider_turn_id"),
    controlRevision: integer("control_revision").notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.agentId] }),
  ],
);

export const quaymeshAgentOperations = sqliteTable(
  "qm_agent_operations",
  {
    operationId: text("operation_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    sessionId: text("session_id").notNull(),
    memberId: text("member_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("qm_agent_operations_session").on(table.sessionId, table.memberId, table.updatedAt),
  ],
);

export type QuayMeshSessionRow = typeof quaymeshSessions.$inferSelect;
export type NewQuayMeshSessionRow = typeof quaymeshSessions.$inferInsert;
export type QuayMeshSessionMemberRow = typeof quaymeshSessionMembers.$inferSelect;
export type NewQuayMeshSessionMemberRow = typeof quaymeshSessionMembers.$inferInsert;
export type QuayMeshInvocationRow = typeof quaymeshInvocations.$inferSelect;
export type NewQuayMeshInvocationRow = typeof quaymeshInvocations.$inferInsert;
export type QuayMeshRunLinkRow = typeof quaymeshRunLinks.$inferSelect;
export type NewQuayMeshRunLinkRow = typeof quaymeshRunLinks.$inferInsert;
export type QuayMeshEventRow = typeof quaymeshEvents.$inferSelect;
export type NewQuayMeshEventRow = typeof quaymeshEvents.$inferInsert;
export type QuayMeshContextReadRow = typeof quaymeshContextReads.$inferSelect;
export type NewQuayMeshContextReadRow = typeof quaymeshContextReads.$inferInsert;
export type QuayMeshChangeBaselineRow = typeof quaymeshChangeBaselines.$inferSelect;
export type NewQuayMeshChangeBaselineRow = typeof quaymeshChangeBaselines.$inferInsert;
export type QuayMeshAgentObservationRow = typeof quaymeshAgentObservations.$inferSelect;
export type NewQuayMeshAgentObservationRow = typeof quaymeshAgentObservations.$inferInsert;
export type QuayMeshAgentOperationRow = typeof quaymeshAgentOperations.$inferSelect;
export type NewQuayMeshAgentOperationRow = typeof quaymeshAgentOperations.$inferInsert;
export type QuayMeshFileChangeRow = typeof quaymeshFileChanges.$inferSelect;
export type NewQuayMeshFileChangeRow = typeof quaymeshFileChanges.$inferInsert;
