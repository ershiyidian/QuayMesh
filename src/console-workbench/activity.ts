import type { ServerConfig } from "../config.js";
import { WorkLedger } from "../work-ledger.js";
import { workspaceHandle } from "../federation/routing.js";
import { permitted } from "./local.js";
import type { WorkbenchEvent } from "./types.js";

export interface ActivityQuery { limit: number; q?: string; level?: string; hour?: string; after?: string; afterId?: string }
interface ActivityRow {
  id: string; at: string; level: string; message: string; state: string; tool: string | null;
  operation_id: string | null; run_id: string | null; task_id: string | null; session_id: string | null;
  task_title: string; event_type: string; details_json: string; request_id: string | null;
  response_at: string | null; created_at: string; finished_at: string | null; source: string;
}
const millis = (column: string) => `CAST(round((julianday(${column})-2440587.5)*86400000) AS INTEGER)`;

export function readLocalActivity(config: ServerConfig, kind: string, query: ActivityQuery) {
  const ledger = new WorkLedger(config.stateDir);
  try {
    const nodeId = config.federation?.nodeId ?? "local";
    const projects = ledger.projects().filter(project => permitted(config, project.root)).map(project => project.id);
    const members = (ledger.db.prepare("SELECT id,root FROM qm_session_members WHERE node_id=?").all(nodeId) as Array<{ id: string; root: string }>)
      .filter(member => permitted(config, member.root)).map(member => member.id);
    const parameters: Array<string | number> = [];
    const inScope = (column: string, ids: string[]) => {
      parameters.push(...ids);
      return ids.length ? `${column} IN (${ids.map(() => "?").join(",")})` : "0";
    };
    let source: string;
    if (kind === "calls") {
      const response = "(CASE WHEN v.response_uses_result=1 THEN v.result_json ELSE v.response_json END)";
      const failed = `(json_extract(${response},'$.kind')='error'
        OR json_extract(${response},'$.value.isError')=1 OR json_extract(${response},'$.isError')=1)`;
      source = `SELECT v.id,v.created_at at,
        CASE WHEN json_extract(${response},'$.effect')='unknown'
          OR json_extract(${response},'$.value.structuredContent.effect')='unknown'
          OR v.response_at IS NULL AND v.state IN ('unknown','reconciliation_required') THEN 'warn'
          WHEN ${failed} THEN 'error' ELSE 'info' END level,
        COALESCE(o.label,v.tool_name) message,v.state,v.tool_name tool,v.operation_id,o.run_id,v.task_id,v.session_id,
        COALESCE(t.title,s.title,'') task_title,'invocation' event_type,
        json_object('responseRecorded',${response} IS NOT NULL,'requestError',COALESCE(${failed},0),
          'errorMessage',COALESCE(json_extract(${response},'$.message'),json_extract(${response},'$.value.content[0].text'),
            json_extract(${response},'$.content[0].text'))) details_json,v.request_id,
        v.response_at,v.created_at,v.finished_at,'invocation' source
        FROM qm_invocations v JOIN qm_session_members m ON m.id=v.member_id
        JOIN qm_sessions s ON s.id=v.session_id LEFT JOIN qm_tasks t ON t.id=v.task_id
        LEFT JOIN console_operations o ON o.id=v.operation_id WHERE ${inScope("v.member_id", members)}`;
    } else {
      source = `SELECT 'event_'||e.sequence id,e.created_at at,
        CASE WHEN json_extract(e.data_json,'$.status') IN ('failed','rejected') THEN 'error'
          WHEN json_extract(e.data_json,'$.status') IN ('unknown','reconciliation_required') THEN 'warn' ELSE 'info' END level,
        COALESCE(json_extract(e.data_json,'$.label'),json_extract(e.data_json,'$.error_message'),o.label,e.event_type) message,
        COALESCE(json_extract(e.data_json,'$.status'),e.event_type) state,
        COALESCE(v.tool_name,o.kind) tool,json_extract(e.data_json,'$.operation_id') operation_id,o.run_id,e.task_id,e.session_id,
        COALESCE(t.title,s.title,'') task_title,e.event_type,e.data_json details_json,v.request_id,
        NULL response_at,e.created_at,NULL finished_at,'event' source
        FROM qm_events e JOIN qm_sessions s ON s.id=e.session_id
        LEFT JOIN qm_tasks t ON t.id=e.task_id LEFT JOIN console_operations o ON o.id=json_extract(e.data_json,'$.operation_id')
        LEFT JOIN qm_invocations v ON v.id=COALESCE(json_extract(e.data_json,'$.invocation_id'),
          (SELECT i.id FROM qm_invocations i WHERE i.operation_id=o.id ORDER BY i.rowid DESC LIMIT 1))
        WHERE ${inScope("e.member_id", members)}
        UNION ALL SELECT 'operation_'||o.id||'_'||CASE WHEN o.finished_at IS NULL THEN 'observed' ELSE 'finished' END,
        COALESCE(o.finished_at,o.observed_at,o.created_at),
        CASE WHEN o.status='failed' THEN 'error' WHEN o.status IN ('unknown','reconciliation_required') THEN 'warn' ELSE 'info' END,
        o.label,o.status,o.kind,o.id,o.run_id,l.task_id,l.session_id,i.title,
        CASE WHEN o.finished_at IS NULL THEN 'operation_observed' ELSE 'operation_finished' END,'{}',NULL,NULL,o.created_at,o.finished_at,'operation_snapshot'
        FROM console_operations o JOIN console_work_runs r ON r.id=o.run_id JOIN console_work_items i ON i.id=r.item_id
        LEFT JOIN qm_run_links l ON l.run_id=r.id WHERE ${inScope("r.project_id", projects)}
          AND NOT EXISTS(SELECT 1 FROM qm_events e WHERE json_extract(e.data_json,'$.operation_id')=o.id
            AND (o.status IN ('unknown','reconciliation_required') AND json_extract(e.data_json,'$.status')=o.status
              OR o.status NOT IN ('unknown','reconciliation_required') AND e.event_type=CASE WHEN o.finished_at IS NULL THEN 'operation_started' ELSE 'operation_finished' END))`;
    }
    const prefix = workspaceHandle(nodeId, "");
    const base = `WITH activity AS (${source}), visible AS (SELECT *,${millis("at")} time,?||id reference FROM activity)`;
    parameters.push(prefix);
    const search = (query.q ?? "").trim().toLocaleLowerCase();
    const filter = `(?='' OR instr(lower(COALESCE(message,'')||' '||COALESCE(tool,'')||' '||task_title||' '||id||' '||
      COALESCE(request_id,'')||' '||COALESCE(operation_id,'')||' '||COALESCE(task_id,'')||' '||COALESCE(session_id,'')),?)>0)
      AND (?='' OR level=?)`;
    const filtered = [...parameters, search, search, query.level ?? "", query.level ?? ""];
    const after = query.after === undefined ? null : Number(query.after);
    if (after !== null && !Number.isFinite(after)) throw new Error("Invalid activity timestamp");
    const selected = `${filter} AND (?='' OR CAST(time/3600000 AS INTEGER)=CAST(? AS INTEGER))
      AND (? IS NULL OR time>? OR (time=? AND reference>?))`;
    const selectedParameters = [...filtered, query.hour ?? "", query.hour ?? "", after, after, after, query.afterId ?? ""];
    const limit = Math.min(1_000_100, Math.max(1, Math.trunc(query.limit)));
    const rows = ledger.db.prepare(`${base} SELECT * FROM visible WHERE ${selected}
      ORDER BY time ${after === null ? "DESC" : "ASC"},reference ${after === null ? "DESC" : "ASC"} LIMIT ?`)
      .all(...selectedParameters, limit) as Array<ActivityRow & { time: number; reference: string }>;
    const total = (ledger.db.prepare(`${base} SELECT COUNT(*) count FROM visible WHERE ${selected}`).get(...selectedParameters) as { count: number }).count;
    const bins = ledger.db.prepare(`${base} SELECT CAST(time/3600000 AS INTEGER)*3600000 start,COUNT(*) count,
      SUM(level='error') errors,SUM(level='warn') warnings FROM visible WHERE ${filter} AND time>=?
      GROUP BY CAST(time/3600000 AS INTEGER)`).all(...filtered, Date.now() - 86_400_000) as Array<{ start: number; count: number; errors: number; warnings: number }>;
    const items: WorkbenchEvent[] = rows.map(row => {
      const details = JSON.parse(row.details_json) as Record<string, unknown>;
      return {
      id: row.reference, time: row.time, nodeId, level: row.level, message: row.message,
      details: { ...details, source: row.source, eventType: row.event_type, task: row.task_title,
        run: row.run_id ? workspaceHandle(nodeId, row.run_id) : null, taskId: row.task_id, sessionId: row.session_id,
        operationId: row.operation_id, requestId: row.request_id, status: row.state },
      ...(kind === "calls" ? { requestId: row.request_id, invocationId: row.id, operationId: row.operation_id,
        taskId: row.task_id, runId: row.run_id ? workspaceHandle(nodeId, row.run_id) : null,
        tool: row.tool, summary: row.message, rootId: null, state: row.response_at ? "responded" : "pending",
        executionState: row.state, responseAt: row.response_at ? Date.parse(row.response_at) : null,
        duration: row.response_at ? Math.max(0, Date.parse(row.response_at) - Date.parse(row.created_at)) : null,
        executionDuration: row.finished_at ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.created_at)) : null,
        responseRecorded: Boolean(details.responseRecorded),
        ok: row.response_at && details.responseRecorded ? !details.requestError : null,
        error: details.requestError ? details.errorMessage ?? "请求返回错误" : null } : {}),
    }; });
    const last = items.at(-1);
    return { items, total, bins, hasMore: total > items.length,
      nextAfter: after !== null && last ? { after: last.time, afterId: last.id } : null };
  } finally { ledger.close(); }
}
