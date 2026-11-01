import { runTimeline, type runOperations } from "../console-run-data.js";
import type { ExecutionRow, WorkRunRow } from "../work-ledger.js";
import type { Snapshot } from "../session/types.js";
import type { ChangeCapture } from "./detail.js";
import type { Run, SourceState } from "./types.js";

export interface FileRow {
  id: string; path: string; kind: string; add: number | null; del: number | null;
  generated: boolean; revision: number | string; binary: boolean; revertible: boolean;
  operationId?: string; fileIndex?: number;
  source?:{runId:string;nodeId:string;projectName:string;root:string};
}

const commandState = (value: string) => value === "ok" || value === "completed" ? "done"
  : value === "fail" || value === "failed" ? "failed" : value === "run" || value === "running" ? "running"
    : value === "queued" ? "queued" : value === "cancelled" ? "cancelled"
      : value === "interrupted" || value === "stopped" ? "interrupted" : "unknown";


/** Pure presentation shared by live mutation-aware readers and the isolated readonly reader. */
export function presentRunDetail(input: {
  row: WorkRunRow; run: Run; operations: ReturnType<typeof runOperations>; executions: ExecutionRow[];
  snapshot: Snapshot | null; files: FileRow[]; warnings: string[]; changeCaptures: ChangeCapture[];
  agentMetadata: (id: string) => { name: string; role: string } | undefined;
}) {
  const { row, run, operations, executions, snapshot, files, warnings, changeCaptures, agentMetadata } = input;
    const operationIds = new Set(operations.map((operation) => operation.id));
    const commands = snapshot ? snapshot.commands.filter((command) => operationIds.has(command.operation_id)).map((command) => ({
      id: command.id, command: command.cmd, agent: command.agent, status: commandState(command.status),
      exit: command.exitCode, startedAt: command.startedAt, ms: command.startedAt !== null && command.endedAt !== null ? command.endedAt - command.startedAt : null,
      outputAvailable: command.output_available, output: "", supersededBy: command.supersededBy,
    })) : operations.filter((operation) => ["command", "exec_command", "bash"].includes(operation.kind)).map((operation) => ({
      id: operation.id, command: operation.label, agent: "host", status: commandState(operation.status),
      exit: null, startedAt: Date.parse(operation.created_at),
      ms: operation.finished_at ? Date.parse(operation.finished_at) - Date.parse(operation.created_at) : null,
      outputAvailable: false, output: "此历史记录没有保存可读取的命令输出", supersededBy: null,
    }));
    const agentIds = new Set(executions.map((execution) => execution.agent_id));
    const agentRows = snapshot ? snapshot.agents.filter((agent) => agentIds.has(agent.id)).map((agent) => ({
      id: agent.id, name: agent.name, role: agent.task, provider: agent.provider,
      status: agent.state === "working" ? "running" : agent.state,
      tokens: agent.tokens, quality: agent.usage_quality,
    })) : [...new Set(executions.map((execution) => execution.agent_id))].map((agentId) => {
      const agent = agentMetadata(agentId);
      const own = executions.filter((execution) => execution.agent_id === agentId);
      const latest = own.at(-1)!;
      return { id: agentId, name: agent?.name ?? agentId, role: agent?.role ?? "",
        provider: latest.provider, status: commandState(latest.status),
        tokens: own.every((execution) => execution.delta !== null) ? own.reduce((sum, execution) => sum + (JSON.parse(execution.delta!).totalTokens ?? 0), 0) : null };
    });
    const summary=row.summary||run.reason||(run.executionStatus==='running'?'任务正在执行':run.executionStatus==='waiting'?'当前没有后台执行，请求尚未结束':'查看下方保存的执行记录');
    return {
      run,summary,phases:[{id:run.id,run,summary}],complete:true,sources:[] as SourceState[],missingPhases:[] as Array<{id:string;nodeId:string;error:string}>,
      evidence: (JSON.parse(row.evidence) as Array<{ label: string; reference: string; outcome: string }>).map((evidence) => ({
        name: evidence.label, detail: evidence.reference, ok: evidence.outcome === "passed" ? true : evidence.outcome === "failed" ? false : null, time: run.finishedAt,
      })), files:files.map(file=>({...file,source:{runId:run.id,nodeId:run.nodeId,projectName:run.projectName,root:run.root}})), commands, agents: agentRows,
      timeline: runTimeline(row, operations, executions).map((event) => ({ time: Date.parse(event.time), text: [event.title, event.detail].filter(Boolean).join(" · "), tone: event.type === "error" ? "red" : "muted" })),
      instructions: snapshot?.instructions ?? [], skills: snapshot?.skills ?? [],
      warnings, changeCaptures, revision: row.revision,
    };
}
