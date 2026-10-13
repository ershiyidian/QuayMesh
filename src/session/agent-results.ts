import * as z from "zod/v4";
import { textPage } from "../bounded-reply.js";
import type { WorkLedger } from "../work-ledger.js";

const cursorSchema = z.object({
  agents: z.array(z.string()).max(50),
  executions: z.array(z.object({ agent: z.string(), execution: z.string() }).strict()).max(50),
  offset: z.number().int().nonnegative(),
}).strict();

export function readAgentResultPage(
  ledger: WorkLedger,
  runIds: ReadonlySet<string>,
  agentIds: string[],
  completedIds: string[],
  cursor?: string,
): { text: string; cursor: string | null; references: Record<string, string> } {
  const saved = cursor ? cursorSchema.parse(JSON.parse(cursor)) : null;
  if (saved && JSON.stringify(saved.agents) !== JSON.stringify(agentIds)) throw new Error("RESULT_CURSOR_AGENT_MISMATCH");
  const executions = saved?.executions ?? completedIds.flatMap((agent) => {
    const execution = [...runIds].flatMap((runId) => ledger.executions(runId))
      .filter((item) => item.agent_id === agent && item.status === "completed")
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
    return execution ? [{ agent, execution: execution.id }] : [];
  });
  const references: Record<string, string> = {};
  const sections = executions.map((ref) => {
    const execution = ledger.execution(ref.execution);
    if (execution.agent_id !== ref.agent || !runIds.has(execution.run_id) || !agentIds.includes(ref.agent)) {
      throw new Error("RESULT_CURSOR_SCOPE_MISMATCH");
    }
    const row = ledger.db.prepare("SELECT response FROM execution_responses WHERE execution_id = ?").get(ref.execution) as { response: string } | undefined;
    if (!row) throw new Error(`EXECUTION_RESPONSE_NOT_FOUND: ${ref.execution}`);
    references[ref.agent] = `execution:${ref.execution}`;
    return `[${ref.agent}]\n${row.response}`;
  });
  const page = textPage(sections.join("\n\n"), saved?.offset ?? 0, 12 * 1024);
  return {
    text: page.text,
    cursor: page.nextOffset === null ? null : JSON.stringify({ agents: agentIds, executions, offset: page.nextOffset }),
    references,
  };
}
