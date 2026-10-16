import * as z from "zod/v4";

const id = z.string().min(1).max(256);
const path = z.string().min(1);
const time = z.number().finite().nonnegative();
const iso = z.string().datetime();
const count = z.number().int().nonnegative();
const text = z.string();
const nullableText = text.nullable();
const nextCursor = text.nullable();

export const operationStateEnum = z.enum([
  "accepted",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

export const executionStateEnum = z.enum(["active", "idle", "interrupted", "failed"]);
export const reviewStateEnum = z.enum(["unknown", "needs_review", "passed", "failed", "not_applicable"]);
export const hostStateEnum = z.enum(["connected", "disconnected", "unknown"]);
export const effectEnum = z.enum(["not_started", "started", "partial", "completed", "unknown"]);

export const memberSchema = z
  .object({
    id,
    node_id: id,
    workspace_id: id,
    root: path,
    source_root: path.nullable(),
    mode: z.enum(["checkout", "worktree"]),
    first_seen_at: iso,
    last_observed_at: iso,
    online: z.boolean(),
    revision: count,
    recovery_root: path,
  })
  .strict();

export const workspaceViewSchema = z
  .object({
    id,
    node_id: id,
    workspace_id: id,
    root: path,
    sourceRoot: path.nullable(),
    mode: z.enum(["local", "worktree"]),
    branch: nullableText,
    baseRef: nullableText,
    baseSha: nullableText,
    dirtySource: z.boolean().nullable(),
    online: z.boolean(),
    observedAt: time,
  })
  .strict();

export const fileSchema = z
  .object({
    id,
    member_id: id,
    status: z.enum(["A", "M", "D", "R"]),
    path,
    from: path.nullable(),
    additions: count.nullable(),
    removals: count.nullable(),
    hash: id,
    large: z.boolean(),
    binary: z.boolean(),
    coverage: z.enum(["session_owned", "workspace_observed", "partial"]),
    revertible: z.boolean(),
  })
  .strict();

export const commandSchema = z
  .object({
    id,
    operation_id: id,
    member_id: id,
    cmd: text,
    agent: text,
    status: z.enum(["queued", "run", "ok", "fail", "cancelled", "unknown"]),
    startedAt: time.nullable(),
    endedAt: time.nullable(),
    exitCode: z.number().int().nullable(),
    signal: nullableText,
    attempt: count.nullable(),
    supersededBy: id.nullable(),
    summary: nullableText,
    output_ref: id,
    output_available: z.boolean(),
  })
  .strict();

export const stepSchema = z
  .object({
    label: text,
    state: z.enum(["done", "cur", "todo"]),
  })
  .strict();

export const agentSchema = z
  .object({
    id,
    member_id: id,
    role: z.enum(["main", "subagent"]),
    name: text,
    provider: text,
    model: nullableText,
    effort: nullableText,
    state: z.enum(["queued", "working", "done", "failed", "cancelled", "unknown"]),
    task: text,
    tokens: count.nullable(),
    usage_quality: z.enum(["complete", "partial", "unavailable", "not_used"]),
    startedAt: time.nullable(),
    endedAt: time.nullable(),
    steps: z.array(stepSchema).nullable(),
    result_available: z.boolean(),
    result_ref: id.nullable(),
  })
  .strict();

export const instructionSchema = z
  .object({
    path,
    status: z.enum(["loaded", "available"]),
    actor_id: id,
    source: z.enum(["global", "ancestor", "workspace", "nested"]),
    observed_at: iso.nullable(),
    content_ref: id.nullable(),
  })
  .strict();

export const skillSchema = z
  .object({
    name: text,
    description: nullableText,
    path,
    actor_id: id,
    state: z.enum(["available", "read"]),
    uses: count.nullable(),
  })
  .strict();

export const executionObservationSchema = z.object({
  observedAt: z.number().finite().nonnegative(),
  activeOperationIds: z.array(z.string().min(1).max(256)).max(4096),
  preparingOperationIds: z.array(z.string().min(1).max(256)).max(4096),
  staleOperationIds: z.array(z.string().min(1).max(256)).max(4096),
}).strict();

export const snapshotSchema = z
  .object({
    sourceTaskId: id.nullable().optional(),
    executionObservation: executionObservationSchema.optional(),
    sessionId: id,
    taskId: id.nullable().optional(),
    taskState:z.enum(["active","closed"]).optional(),
    taskResult:z.enum(["completed","failed","cancelled","handed_off"]).nullable().optional(),
    lastActivityAt:time.nullable().optional(),
    lastModelToolAt:time.nullable().optional(),
    lastExecutionActivityAt:time.nullable().optional(),
    lastOutputAt:time.nullable().optional(),
    serverNow:time.optional(),
    lastOperation:z.object({operation_id:id,member_id:id,kind:text,label:text,state:text,startedAt:time,endedAt:time.nullable()}).nullable().optional(),
    currentCommand:commandSchema.nullable().optional(),
    runningCommand:commandSchema.nullable().optional(),
    lastCommand:commandSchema.nullable().optional(),
    closureReason:z.enum(["explicit","superseded","legacy_archive","recovered"]).nullable().optional(),
    archivedAt:time.nullable().optional(),
    deliveryEndedAt:time.nullable().optional(),
    sourceKind:z.enum(["user_request","deployment_check","federation_mirror","legacy_unknown"]).optional(),
    changeSummary:z.object({state:z.enum(["not_started","complete","incomplete"]),error:text.nullable()}).strict().optional(),
    rev: count,
    changeRev: count.nullable().optional(),
    title: text,
    status: z.enum(["running", "done", "failed", "idle"]),
    execution_status: executionStateEnum,
    review_status: reviewStateEnum,
    host_status: hostStateEnum,
    startedAt: time,
    endedAt: time.nullable(),
    observedAt: time,
    consoleUrl: z.string().url().nullable(),
    workspace: workspaceViewSchema.nullable(),
    workspaces: z.array(memberSchema),
    files: z.array(fileSchema),
    commands: z.array(commandSchema),
    agents: z.array(agentSchema),
    instructions: z.array(instructionSchema),
    skills: z.array(skillSchema),
    totals: z
      .object({
        files: count,
        commands: count,
        agents: count,
      })
      .strict(),
    cursors: z
      .object({
        files: nextCursor,
        commands: nextCursor,
        agents: nextCursor,
      })
      .strict(),
    capabilities: z
      .object({
        refresh: z.boolean(),
        revert: z.boolean(),
        continue: z.boolean(),
        open_file: z.boolean(),
      })
      .strict(),
    notices: z.array(text),
  })
  .strict();

export const recoveryRowSchema = z
  .object({
    session_id: id,
    title: text,
    updated_at: iso,
    execution_state: executionStateEnum,
    latest_completed: text,
    files: z.array(path).max(5),
    remaining_files: count,
    commands: z
      .object({
        succeeded: count,
        failed: count,
        running: count,
        last_summary: text,
      })
      .strict(),
    agents: z
      .object({
        completed: count,
        running: count,
        failed: count,
      })
      .strict(),
    verification: text,
    next_step: text,
    detail_ref: id,
    node_id: id,
    root: path,
  })
  .strict();

export const operationStatusSchema = z
  .object({
    operation_id: id,
    kind: text,
    label: text,
    state: operationStateEnum,
    effect: effectEnum,
    created_at: iso,
    finished_at: iso.nullable(),
    process_handle: id.optional(),
    agent_id: id.optional(),
    result_ref: id.optional(),
    error: z
      .object({
        code: text,
        message: text,
        effect: effectEnum,
        next_action: text,
      })
      .strict()
      .optional(),
  })
  .strict();

export const spawnAgentSchema = z
  .object({
    workspace_id: id,
    message: text.min(1),
    name: text.optional(),
    target: id.optional(),
    model: text.optional(),
    effort: text.optional(),
    read_only: z.boolean().optional(),
    resources: z.array(text).optional(),
  })
  .strict();

export const followupAgentSchema = z
  .object({
    workspace_id: id,
    agent_id: id,
    message: text.min(1),
    read_only: z.boolean().optional(),
    model: text.optional(),
    effort: text.optional(),
    resources: z.array(text).optional(),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    workspace_id: id,
    agent_id: id,
    message: text.min(1),
  })
  .strict();

export const waitAgentSchema = z
  .object({
    workspace_id: id,
    agent_ids: z.array(id).min(1).max(50),
    timeout_ms: z.number().int().min(0).max(10000).default(5000),
    result_cursor: text.optional(),
  })
  .strict();

export const interruptAgentSchema = z
  .object({
    workspace_id: id,
    agent_id: id,
  })
  .strict();

export const listAgentsSchema = z
  .object({
    workspace_id: id,
    cursor: text.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export const appSchemas = {
  session: z
    .object({
      session_id: id,
      task_id: id.optional(),
      since_rev: z.number().int(),
      member_id: id.optional(),
      cursor: text.optional(),
      mount_id: z.string().uuid().optional(),
      resource_version: z.string().min(1).max(64).optional(),
    })
    .strict(),
  file_diff: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      file_id: id,
      hash: id,
      cursor: text.optional(),
    })
    .strict(),
  command_output: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      command_id: id,
      cursor: count,
      max_bytes: count,
    })
    .strict(),
  instruction: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      path,
    })
    .strict(),
  patch: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      cursor: text.optional(),
    })
    .strict(),
  revert: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      confirm: z.literal(true),
      expected_rev: count,
    })
    .strict(),
  file_url: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      path,
    })
    .strict(),
  continue: z
    .object({
      session_id: id,
      task_id: id.optional(),
      member_id: id.optional(),
      agent_id: id.optional(),
    })
    .strict(),
};

export function parseToolInput(name: string, value: unknown): unknown {
  switch (name) {
    case "spawn_agent":
      return spawnAgentSchema.parse(value);
    case "followup_agent":
      return followupAgentSchema.parse(value);
    case "send_message":
      return sendMessageSchema.parse(value);
    case "wait_agent":
      return waitAgentSchema.parse(value);
    case "interrupt_agent":
      return interruptAgentSchema.parse(value);
    case "list_agents":
      return listAgentsSchema.parse(value);
    default:
      throw new Error(`UNKNOWN_TOOL: ${name}`);
  }
}

export function validateSnapshot(value: unknown): z.infer<typeof snapshotSchema> {
  return snapshotSchema.parse(value);
}

export function validateRecovery(value: unknown): z.infer<typeof recoveryRowSchema>[] {
  return z.array(recoveryRowSchema).parse(value);
}
