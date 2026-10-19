import { jsonReply, textPage } from "../bounded-reply.js";
import { createLocalAgentClient, type LocalAgentClient } from "../local-agent-client.js";
import type { LocalAgentRecord } from "../local-agent-store.js";
import { presentAgentReceipt } from "../local-agent-presentation.js";
import { WorkLedger } from "../work-ledger.js";
import { currentInvocation } from "../session/invocations.js";
import type { AgentOperationIdentity } from "../session/agent-operations.js";
import { buildWorkerBrief } from "../session/prompts.js";
import { readAgentResultPage } from "../session/agent-results.js";
import {
  followupAgentSchema,
  interruptAgentSchema,
  listAgentsSchema,
  sendMessageSchema,
  spawnAgentSchema,
  waitAgentSchema,
} from "../session/agent-schemas.js";
import type { ToolRegistrationContext } from "./types.js";

export type AgentClient = Pick<
  LocalAgentClient,
  "start" | "continue" | "get" | "list" | "wait" | "cancelQueued" | "control"
>;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const CONTROL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

export function registerSubagentTools(
  context: ToolRegistrationContext,
  client?: AgentClient,
): void {
  const { server, config, workspaces, sessionRuntime } = context;
  let agentClient = client;
  const getAgents = () => {
    if (!config.subagents.enabled) throw new Error("SUBAGENTS_DISABLED_ON_NODE: select a worker with an enabled provider");
    return agentClient ??= createLocalAgentClient(config);
  };

  const scopeFor = async (workspaceId: string) => {
    if (!config.subagents.enabled) throw new Error("SUBAGENTS_DISABLED_ON_NODE: select a worker with an enabled provider");
    const workspace = await workspaces.getWorkspace(workspaceId);
    return {
      workspace,
      scope: { workspaceId: workspace.id, workspaceRoot: workspace.root },
    };
  };

  const reply = (value: Record<string, unknown>, isError = false) => ({
    ...jsonReply({operation_id:currentInvocation()?.operation_id,...value}),
    isError,
  });

  const invocationKey = (prefix: string): string => {
    const invocation = currentInvocation();
    if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
    return `${prefix}-${invocation.invocation_id}`;
  };

  const targetFor = (workspace: Awaited<ReturnType<typeof workspaces.getWorkspace>>, requested?: string): string => {
    if (requested) return requested;
    const configured = config.subagents.providers.find((provider) => provider.enabled);
    if (configured) return configured.id;
    const profile = workspace.agentProfiles.find((candidate) => !candidate.disabled);
    if (profile) return profile.name;
    throw new Error("NO_SUBAGENT_TARGET");
  };

  const requireSessionRuntime = () => {
    if (!sessionRuntime) throw new Error("SESSION_RUNTIME_REQUIRED");
    return sessionRuntime;
  };

  const trackAgentOperation = (
    invocation: NonNullable<ReturnType<typeof currentInvocation>>,
    agentId: string,
  ): void => {
    if (!invocation.operation_id) throw new Error("MISSING_AGENT_OPERATION_ID");
    const identity: AgentOperationIdentity = {
      operationId: invocation.operation_id,
      agentId,
      sessionId: invocation.session_id,
      memberId: invocation.member_id,
    };
    requireSessionRuntime().agentOperations.track(identity);
  };

  const recordRef = (record: LocalAgentRecord): string =>
    `agent:${record.id}:${record.controlRevision}`;

  const presentSubagentRecord = (record: LocalAgentRecord, workspaceId: string) => {
    const running = ["starting", "queued", "running"].includes(record.status);
    return {
      agent_id: record.id,
      state: record.status,
      target: record.profileName,
      provider: record.provider,
      model: record.model ?? null,
      effort: record.effort ?? null,
      result_ref: recordRef(record),
      result_available: record.status === "idle" && record.latestResponse !== undefined,
      ...(running
        ? { next_action: { tool: "wait_agent", arguments: { workspace_id: workspaceId, agent_ids: [record.id] } } }
        : {}),
    };
  };

  interface AuthorizedAgent {
    record: LocalAgentRecord;
    runId: string;
    task: string;
  }

  const authorizeAgentRecord = async (
    agentId: string,
    scope: { workspaceId: string; workspaceRoot: string },
  ): Promise<AuthorizedAgent> => {
    const runtime = requireSessionRuntime();
    const invocation = currentInvocation();
    if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
    const linkedRuns = new Set(runtime.store.runIdsForMember(invocation.session_id, invocation.member_id));
    const ledger = new WorkLedger(config.stateDir);
    try {
      const execution = ledger.latestExecution(agentId);
      if (execution && !linkedRuns.has(execution.run_id)) {
        throw new Error(`AGENT_SESSION_MISMATCH: ${agentId}`);
      }
      const found = await getAgents().get(agentId, scope);
      if (found.isErr()) throw new Error(`${found.error.code}: ${found.error.message}`);
      const record = found.value;
      if (!execution) throw new Error(`AGENT_HAS_NO_WORK_RUN: ${record.id}`);
      const work = ledger.requireScope(execution.run_id, record.workspaceRoot, record.workspaceId);
      return {
        record,
        runId: execution.run_id,
        task: record.taskName ?? work.title ?? "Task",
      };
    } finally {
      ledger.close();
    }
  };

  const authorizeAgent = async (
    agentId: string,
    scope: { workspaceId: string; workspaceRoot: string },
  ): Promise<LocalAgentRecord> => (await authorizeAgentRecord(agentId, scope)).record;

  const rememberControl = (sessionId: string, record: LocalAgentRecord): void => {
    requireSessionRuntime().store.rememberAgentObservation(
      sessionId,
      record.id,
      record.providerTurnId ?? null,
      record.controlRevision,
    );
  };

  const controlChanged = (sessionId: string, record: LocalAgentRecord): boolean => {
    const observed = requireSessionRuntime().store.lastAgentObservation(sessionId, record.id);
    return observed === null
      || observed.providerTurnId !== (record.providerTurnId ?? null)
      || observed.controlRevision !== record.controlRevision;
  };

  const runForAgent = (agent: LocalAgentRecord): string => {
    const ledger = new WorkLedger(config.stateDir);
    try {
      const execution = ledger.latestExecution(agent.id);
      if (!execution) throw new Error("AGENT_HAS_NO_WORK_RUN");
      return ledger.requireScope(execution.run_id, agent.workspaceRoot, agent.workspaceId).id;
    } finally {
      ledger.close();
    }
  };

  server.registerTool(
    "spawn_agent",
    {
      title: "Spawn agent",
      description: "Start a subagent task; return its accepted operation without waiting.",
      inputSchema: spawnAgentSchema,
      annotations: { ...CONTROL, openWorldHint: true },
    },
    async (input) => {
      const invocation = currentInvocation();
      if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
      const { workspace, scope } = await scopeFor(input.workspace_id);
      const target = targetFor(workspace, input.target);
      const result = await getAgents().start({
        ...scope,
        taskName: input.name,
        target,
        prompt: buildWorkerBrief(input.message, input.context),
        model: input.model,
        effort: input.effort,
        writeMode: input.read_only ? "read_only" : undefined,
        resources: input.resources,
        taskKey: invocationKey("task").slice(0, 128),
        workItemId: `session-${invocation.session_id}`,
        workRunId: invocation.run_id,
        context: input.context,
      });
      if (result.isErr()) {
        return reply({ code: result.error.code, message: result.error.message, requestAccepted: false, providerInvoked: false }, true);
      }
      trackAgentOperation(invocation, result.value.id);
      rememberControl(invocation.session_id, result.value);
      return reply(presentSubagentRecord(result.value, workspace.id));
    },
  );

  server.registerTool(
    "followup_agent",
    {
      title: "Follow up with agent",
      description: "Continue the same agent thread.",
      inputSchema: followupAgentSchema,
      annotations: { ...CONTROL, openWorldHint: true },
    },
    async (input) => {
      const invocation = currentInvocation();
      if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
      const { workspace, scope } = await scopeFor(input.workspace_id);
      const record = await authorizeAgent(input.agent_id, scope);
      if (record.status === "starting" || record.status === "queued" || record.status === "running") {
        return reply({
          code: "AGENT_BUSY",
          agent_id: record.id,
          state: record.status,
          next_action: { tool: "wait_agent", arguments: { workspace_id: workspace.id, agent_ids: [record.id] } },
        }, true);
      }
      const result = await getAgents().continue(
        record.id,
        buildWorkerBrief(input.message, input.context),
        {
          model: input.model,
          effort: input.effort,
          writeMode: input.read_only ? "read_only" : undefined,
          resources: input.resources,
          context: input.context,
          requestKey: invocationKey("followup").slice(0, 128),
          workRunId: invocation.run_id ?? runForAgent(record),
        },
        scope,
      );
      if (result.isErr()) return reply({ code: result.error.code, message: result.error.message, requestAccepted: false, providerInvoked: false }, true);
      trackAgentOperation(invocation, result.value.id);
      rememberControl(invocation.session_id, result.value);
      return reply(presentSubagentRecord(result.value, workspace.id));
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Message active agent",
      description: "Send guidance to the exact active turn of a running subagent.",
      inputSchema: sendMessageSchema,
      annotations: { ...CONTROL, openWorldHint: true },
    },
    async (input) => {
      const { workspace, scope } = await scopeFor(input.workspace_id);
      const invocation = currentInvocation();
      if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
      const record = await authorizeAgent(input.agent_id, scope);
      if (controlChanged(invocation.session_id, record)) {
        return reply({
          code: "AGENT_STATE_CHANGED",
          agent_id: record.id,
          state: record.status,
          control_state: record.controlState,
          provider_turn_id: record.providerTurnId ?? null,
        }, true);
      }
      if (record.status !== "running" || record.controlState !== "qm_active" || !record.providerTurnId) {
        return reply({
          code: "AGENT_NOT_ACTIVE",
          agent_id: record.id,
          state: record.status,
          next_action: { tool: "followup_agent", arguments: { workspace_id: workspace.id, agent_id: record.id } },
        }, true);
      }
      const result = await getAgents().control({
        agentId: record.id,
        action: "steer",
        workRunId: runForAgent(record),
        requestKey: invocationKey("steer").slice(0, 128),
        expectedTurnId: record.providerTurnId,
        prompt: input.message,
        scope,
      });
      if (result.isErr()) return reply({ code: result.error.code, message: result.error.message, requestAccepted: false, providerInvoked: false }, true);
      rememberControl(invocation.session_id, { ...record, controlRevision: result.value.controlRevision,
        controlState: result.value.controlState, providerTurnId: result.value.providerTurnId });
      return reply({ ...result.value, result_ref: recordRef(record), next_action: { tool: "wait_agent", arguments: { workspace_id: workspace.id, agent_ids: [record.id] } } });
    },
  );

  server.registerTool(
    "wait_agent",
    {
      title: "Wait for agents",
      description: "Wait briefly for agent states and retained results.",
      inputSchema: waitAgentSchema,
      annotations: READ_ONLY,
    },
    async (input, extra) => {
      void extra;
      const { workspace, scope } = await scopeFor(input.workspace_id);
      const invocation = currentInvocation();
      if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
      const records = new Map<string, LocalAgentRecord>();
      for (const agentId of input.agent_ids) {
        records.set(agentId, await authorizeAgent(agentId, scope));
      }
      const result = await getAgents().wait(input.agent_ids, scope, input.result_cursor ? 0 : Math.min(input.timeout_ms, 10_000));
      if (result.isErr()) return reply({ code: result.error.code, message: result.error.message }, true);
      const byId = new Map(result.value.map((item) => [item.id, item]));
      const ordered = input.agent_ids.map((agentId) => {
        const item = byId.get(agentId);
        if (!item) throw new Error(`AGENT_WAIT_RESULT_MISSING: ${agentId}`);
        return item;
      });
      for (const agentId of input.agent_ids) {
        records.set(agentId, await authorizeAgent(agentId, scope));
      }
      const ledger = new WorkLedger(config.stateDir);
      let page: ReturnType<typeof readAgentResultPage>;
      try {
        page = readAgentResultPage(ledger,
          new Set(requireSessionRuntime().store.runIdsForMember(invocation.session_id, invocation.member_id)),
          input.agent_ids, ordered.filter((item) => item.status === "completed").map((item) => item.id), input.result_cursor);
      } finally { ledger.close(); }
      for (const item of ordered) {
        const record = records.get(item.id)!;
        rememberControl(invocation.session_id, record);
      }
      return reply({
        workspace_id: workspace.id,
        results: ordered.map((item) => {
          const record = records.get(item.id)!;
          return { agent_id: item.id, state: item.status, result_ref: page.references[item.id] ?? null,
            result_available: Boolean(page.references[item.id]),
            ...(record.error ? { error: record.error, code: record.errorCode } : {}) };
        }),
        response_text: page.text,
        result_cursor: page.cursor,
        unchanged: false,
      });
    },
  );

  server.registerTool(
    "interrupt_agent",
    {
      title: "Interrupt agent",
      description: "Cancel a queued subagent or interrupt its exact active turn.",
      inputSchema: interruptAgentSchema,
      annotations: CONTROL,
    },
    async (input) => {
      const { workspace, scope } = await scopeFor(input.workspace_id);
      const invocation = currentInvocation();
      if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
      const record = await authorizeAgent(input.agent_id, scope);
      if (controlChanged(invocation.session_id, record)) {
        return reply({
          code: "AGENT_STATE_CHANGED",
          agent_id: record.id,
          state: record.status,
          control_state: record.controlState,
          provider_turn_id: record.providerTurnId ?? null,
        }, true);
      }
      if (record.status === "queued" || record.status === "starting") {
        const cancelled = await getAgents().cancelQueued(record.id, scope);
        if (cancelled.isErr()) return reply({ code: cancelled.error.code, message: cancelled.error.message }, true);
        rememberControl(invocation.session_id, cancelled.value);
        return reply({ ...presentSubagentRecord(cancelled.value, workspace.id), action: "cancel_queued" });
      }
      if (record.status !== "running") {
        return reply({ ...presentSubagentRecord(record, workspace.id), action: "none", terminal: true });
      }
      if (record.controlState !== "qm_active" || !record.providerTurnId) {
        return reply({
          code: "AGENT_STATE_CHANGED",
          agent_id: record.id,
          state: record.status,
          control_state: record.controlState,
          provider_turn_id: record.providerTurnId ?? null,
        }, true);
      }
      const result = await getAgents().control({
        agentId: record.id,
        action: "interrupt",
        workRunId: runForAgent(record),
        requestKey: invocationKey("interrupt").slice(0, 128),
        expectedTurnId: record.providerTurnId,
        scope,
      });
      if (result.isErr()) return reply({ code: result.error.code, message: result.error.message, requestAccepted: false, providerInvoked: false }, true);
      rememberControl(invocation.session_id, { ...record, controlRevision: result.value.controlRevision,
        controlState: result.value.controlState, providerTurnId: result.value.providerTurnId });
      return reply({ ...result.value, result_ref: recordRef(record), action: "interrupt" });
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List subagents that belong to the current workspace scope.",
      inputSchema: listAgentsSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      const { workspace, scope } = await scopeFor(input.workspace_id);
      const invocation = currentInvocation();
      if (!invocation) throw new Error("MISSING_OPERATION_CONTEXT");
      const result = await getAgents().list(scope);
      if (result.isErr()) return reply({ code: result.error.code, message: result.error.message }, true);
      const sessionAgents: AuthorizedAgent[] = [];
      for (const candidate of result.value) {
        try {
          sessionAgents.push(await authorizeAgentRecord(candidate.id, scope));
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("AGENT_SESSION_MISMATCH:")) throw error;
        }
      }
      const start = input.cursor ? sessionAgents.findIndex((agent) => agent.record.id === input.cursor) + 1 : 0;
      const rows = sessionAgents.slice(start, start + input.limit);
      for (const agent of rows) rememberControl(invocation.session_id, agent.record);
      return reply({
        workspace_id: workspace.id,
        agents: rows.map(({ record, task }) => ({
          agent_id: record.id,
          name: record.taskName ?? record.profileName,
          task,
          state: record.status,
          provider: record.provider,
          model: record.model ?? null,
          effort: record.effort ?? null,
          result_ref: record.status === "idle" ? recordRef(record) : null,
          result_available: record.status === "idle" && record.latestResponse !== undefined,
        })),
        cursor: start + rows.length < sessionAgents.length ? rows.at(-1)?.record.id ?? null : null,
      });
    },
  );
}
