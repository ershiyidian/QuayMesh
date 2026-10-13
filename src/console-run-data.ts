import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatch } from "diff";
import type { ApplyPatchResult } from "./apply-patch.js";
import type { Evidence, ExecutionRow, WorkLedger, WorkRunRow } from "./work-ledger.js";

interface RecordedFile {
  path: string;
  previousPath?: string;
  type: "new" | "deleted" | "change" | "rename-changed";
  additions: number;
  removals: number;
}
interface RecordedChanges { operationId: string; files: RecordedFile[]; capturedBy: "tool" }
interface Operation {
  id: string; kind: string; label: string; status: string;
  evidence: string; created_at: string; finished_at: string | null;
}
const changeLabel = "console.changes";
const states: Record<string, string> = { running: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消", queued: "排队中", starting: "启动中" };
const kinds: Record<string, string> = { apply_patch: "修改文件", command: "执行命令", read: "读取文件", workspace_context: "查看工作区" };

export async function recordPatchChanges(stateDir: string, operationId: string, result: ApplyPatchResult): Promise<Evidence[]> {
  const patches = parsePatch(result.patch);
  const files: RecordedFile[] = result.files.map((file, index) => {
    const lines = patches[index]?.hunks.flatMap((hunk) => hunk.lines) ?? [];
    return { path: file.path, ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      type: file.operation === "add" ? "new" : file.operation === "delete" ? "deleted" : file.operation === "move" ? "rename-changed" : "change",
      additions: lines.filter((line) => line.startsWith("+")).length,
      removals: lines.filter((line) => line.startsWith("-")).length };
  });
  const directory = join(stateDir, "console-changes");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${operationId}.patch`), result.patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const metadata: RecordedChanges = { operationId, files, capturedBy: "tool" };
  await writeFile(join(directory, `${operationId}.json`), JSON.stringify(metadata), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return [{ label: changeLabel, reference: operationId, outcome: "passed" }];
}

function recorded(operations: Operation[]): Operation[] {
  return operations.filter((operation) => (JSON.parse(operation.evidence) as Evidence[])
    .some((entry) => entry.label === changeLabel && entry.reference === operation.id && entry.outcome === "passed"));
}

function metadata(stateDir: string, operation: Operation): RecordedChanges {
  return JSON.parse(readFileSync(join(stateDir, "console-changes", `${operation.id}.json`), "utf8")) as RecordedChanges;
}

export function runOperations(ledger: WorkLedger, runId: string): Operation[] {
  return ledger.db.prepare("select id,kind,label,status,evidence,created_at,finished_at from console_operations where run_id=? order by created_at,rowid").all(runId) as Operation[];
}

export function runPresentation(ledger: WorkLedger, run: WorkRunRow, operations = runOperations(ledger, run.id)) {
  const files = recorded(operations).flatMap((operation) => metadata(ledger.stateDir, operation).files);
  const latest = operations.at(-1);
  const state = latest ? states[latest.status] ?? latest.status : "";
  const lastEventSummary = latest ? `${kinds[latest.kind] ?? latest.label} · ${state}` : null;
  const failed = [...operations].reverse().find((operation) => operation.status === "failed");
  const attentionReason = run.status === "failed" || run.status === "reconciliation_required"
    ? (run.summary || (failed ? `${kinds[failed.kind] ?? failed.label}失败，请查看时间线。` : "任务结果需要核对。")) : null;
  return { createdAt: run.created_at, startedAt: run.created_at, lastEventSummary, attentionReason,
    diffStat: files.length ? { files: new Set(files.map((file) => file.path)).size,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.removals, 0) } : null };
}

export function runTimeline(run: WorkRunRow, operations: Operation[], executions: ExecutionRow[]) {
  const events: { time: string; type: string; title: string; detail?: string; agentId?: string; durationMs?: number; exitCode?: number }[] = [
    { time: run.created_at, type: "created", title: "任务登记" },
  ];
  for (const operation of operations) {
    events.push({ time: operation.created_at, type: operation.kind === "apply_patch" ? "file_change" : operation.kind,
      title: kinds[operation.kind] ?? operation.label, detail: states[operation.status] ?? operation.status });
    if (operation.finished_at) events.push({ time: operation.finished_at, type: operation.status === "failed" ? "error" : "operation",
      title: `${kinds[operation.kind] ?? operation.label} · ${states[operation.status] ?? operation.status}`,
      durationMs: Math.max(0, Date.parse(operation.finished_at) - Date.parse(operation.created_at)) });
  }
  for (const execution of executions) {
    events.push({ time: execution.created_at, type: "turn_start", title: "代理执行登记", agentId: execution.agent_id,
      detail: [execution.requested_model, execution.requested_effort].filter(Boolean).join(" · ") });
    if (execution.finished_at) events.push({ time: execution.finished_at, type: "turn_end", title: `代理执行 · ${states[execution.status] ?? execution.status}`, agentId: execution.agent_id });
  }
  if (run.finished_at) events.push({ time: run.finished_at, type: "finished", title: `任务${states[run.status] ?? run.status}` });
  return events.sort((left, right) => Date.parse(left.time) - Date.parse(right.time)).map((event, seq) => ({ ...event, seq }));
}

export function runChangeSets(ledger: WorkLedger, operations: Operation[]) {
  return recorded(operations).map((operation) => ({ ...metadata(ledger.stateDir, operation), time: operation.created_at,
    patch: readFileSync(join(ledger.stateDir, "console-changes", `${operation.id}.patch`), "utf8") }));
}
