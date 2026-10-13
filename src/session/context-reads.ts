import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { InvocationContext, InstructionSummary, SkillSummary } from "./types.js";
import type { ContextReadInput } from './task-data.js';
import type { SessionStore } from "./store.js";
import type { Workspace } from "../workspaces.js";

export interface DiscoveredContextInput {
  sessionId: string;
  taskId?: string;
  memberId: string;
  workspace: Workspace;
  loadedAgentsFiles: Array<{ path: string; content: string }>;
  availableAgentsFiles: Array<{ path: string }>;
}

export class ContextReadRecorder {
  constructor(private readonly store: SessionStore) {}

  private registerHost(input: ContextReadInput): void {
    this.store.upsertContextRead({...input,taskId:undefined});
    if(input.taskId)this.store.upsertContextRead(input);
  }

  registerDiscovered(input: DiscoveredContextInput): void {
    const taskId = input.taskId ?? this.store.currentTask(input.sessionId)?.id;
    for (const file of input.loadedAgentsFiles) {
      this.registerHost({
        sessionId: input.sessionId,
        taskId,
        memberId: input.memberId,
        actorId: "host",
        path: file.path,
        kind: "instruction",
        state: "loaded",
        contentRef: `agents:${file.path}`,
      });
      if (taskId) this.store.putTaskContext(taskId, input.memberId, file.path, file.content);
    }
    for (const file of input.availableAgentsFiles) {
      this.registerHost({
        sessionId: input.sessionId,
        taskId,
        memberId: input.memberId,
        actorId: "host",
        path: file.path,
        kind: "instruction",
        state: "available",
        contentRef: null,
      });
    }
    for (const skill of input.workspace.skills) {
      this.registerHost({
        sessionId: input.sessionId,
        taskId,
        memberId: input.memberId,
        actorId: "host",
        path: skill.filePath,
        kind: "skill",
        state: "available",
        contentRef: null,
      });
    }
  }

  recordHostRead(
    context: InvocationContext,
    path: string,
    returnedContent: string,
    range: { start: number; end: number } | null = null,
  ): void {
    if (context.actor !== "model") return;
    const known = this.store
      .contextReads(context.session_id, context.member_id, context.task_id)
      .find((row) => resolveKnownPath(row.path) === resolveKnownPath(path));
    if (!known && !["agents.md","claude.md"].includes(basename(path).toLowerCase())) return;
    if (!returnedContent) return;
    const complete = range === null;
    const countsAsRead = complete;
    this.store.upsertContextRead({
      sessionId: context.session_id,
      taskId: context.task_id,
      memberId: context.member_id,
      actorId: context.actor,
      path: known?.path ?? path,
      kind: known?.kind ?? "instruction",
      state: countsAsRead ? "read" : known?.state === "loaded" ? "loaded" : "available",
      contentRef: `read:${context.invocation_id}`,
      incrementRead: countsAsRead,
    });
    if (context.task_id) this.store.putTaskContext(context.task_id, context.member_id, known?.path ?? path, returnedContent);
    this.store.appendEvent({
      session_id: context.session_id,
      task_id: context.task_id ?? null,
      member_id: context.member_id,
      type: "context_read",
      source_id: context.invocation_id,
      timestamp: new Date().toISOString(),
      payload: { actor_id: context.actor, path: known?.path ?? path, kind: known?.kind ?? "instruction", range },
    });
  }

  recordAgentRead(input: {
    sessionId: string;
    taskId?: string;
    memberId: string;
    agentId: string;
    eventId: string;
    path: string;
  }): void {
    const known = this.store
      .contextReads(input.sessionId, input.memberId, input.taskId)
      .find((row) => resolveKnownPath(row.path) === resolveKnownPath(input.path));
    if (!known) return;
    this.store.upsertContextRead({
      sessionId: input.sessionId,
      taskId: input.taskId,
      memberId: input.memberId,
      actorId: input.agentId,
      path: known.path,
      kind: known.kind,
      state: "read",
      contentRef: `agent:${input.eventId}`,
      incrementRead: true,
    });
  }

  async readForCard(sessionId: string, memberId: string, path: string, taskId?: string): Promise<{ path: string; content: string } | null> {
    if (taskId) {
      const frozen = this.store.taskContext(taskId, memberId, path);
      if (frozen) return frozen;
      if (this.store.getTask(taskId).state === "closed") return null;
    }
    const known = this.store
      .contextReads(sessionId, memberId, taskId)
      .find((row) => resolveKnownPath(row.path) === resolveKnownPath(path));
    if (!known) return null;
    const content = await readFile(known.path, "utf8");
    return { path: known.path, content };
  }

  instructions(sessionId: string, memberId?: string, taskId?: string): InstructionSummary[] {
    return this.store
      .contextReads(sessionId, memberId, taskId)
      .filter((row) => row.kind === "instruction")
      .map((row) => ({
        path: row.path,
        status: row.state === "loaded" || row.state === "read" ? "loaded" : "available",
        actor_id: row.actor_id,
        source: row.actor_id === "host" ? "workspace" : "nested",
        observed_at: row.observed_at ?? null,
        content_ref: row.content_ref,
      }));
  }

  skills(sessionId: string, memberId?: string, taskId?: string): SkillSummary[] {
    return this.store
      .contextReads(sessionId, memberId, taskId)
      .filter((row) => row.kind === "skill")
      .map((row) => ({
        name: row.path.split(/[\\/]/).filter(Boolean).at(-2) ?? row.path,
        description: null,
        path: row.path,
        actor_id: row.actor_id,
        state: row.state === "read" ? "read" : "available",
        uses: row.read_count > 0 ? row.read_count : null,
      }));
  }
}

export function skillPath(skill: Skill): string {
  return skill.filePath;
}

function resolveKnownPath(path: string): string {
  return resolve(path);
}
