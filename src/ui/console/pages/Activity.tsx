import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText, isAuthError } from "../api.js";
import { bytes, duration, label, parseTime } from "../format.js";
import { navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { Badge, Empty, Meter, NodeTag, Notice, Tabs, TimeText, useAct, useDialogs } from "../ui.js";
import type { OverviewNode, Transfer } from "../types.js";

type Tab = "events" | "transfers" | "mcp" | "audit";
type Level = "bad" | "warn" | "info";

function levelOf(level: string | undefined, message: string): Level {
  if (level === "error" || level === "bad") return "bad";
  if (level === "warn" || level === "warning") return "warn";
  if (level) return "info";
  if (/失败|错误|error|fail|离线|不可用/i.test(message)) return "bad";
  if (/切换|重试|超时|断开|warn/i.test(message)) return "warn";
  return "info";
}

export function ActivityPage() {
  const data = useData();
  const route = useRoute();
  const raw = route.get("tab");
  const tab: Tab = raw === "transfers" || raw === "mcp" || raw === "audit" ? raw : "events";
  const fleet = data.fleet;
  if (data.mode !== "fleet" || !fleet) return <div className="panel"><Empty title="单机模式下没有运行事件">连接与切换记录、跨机文件传输只在多机模式下产生。</Empty></div>;
  return (
    <div className="stack">
      <Tabs<Tab> value={tab} onChange={(value) => navigate({ tab: value === "events" ? null : value }, { replace: true })}
        tabs={[["events", "系统事件", fleet.events.length], ["transfers", "文件传输"], ["mcp", "MCP 调用", fleet.mcpCalls?.length ?? 0], ["audit", "配置审计", fleet.audit?.length ?? 0]]} />
      {tab === "events" && <EventsTab />}
      {tab === "transfers" && <TransfersTab />}
      {tab === "mcp" && <McpTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

function EventsTab() {
  const data = useData();
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const events = useMemo(() => (data.fleet?.events ?? [])
    .map((event, index) => ({ ...event, index, lv: levelOf(event.level, event.message), t: parseTime(event.time) ?? 0 }))
    .filter((event) => (!level || event.lv === level) && (!data.scopeNode || event.nodeId === data.scopeNode) && (!query || event.message.toLowerCase().includes(query.toLowerCase())))
    .sort((a, b) => b.t - a.t), [data.fleet, level, query, data.scopeNode]);
  return (
    <>
      <div className="filters">
        <input type="search" className="filter-search" placeholder="搜索事件内容" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索事件" />
        <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="级别"><option value="">全部级别</option><option value="bad">错误</option><option value="warn">警告</option><option value="info">信息</option></select>
      </div>
      <div className="panel flush">
        {!events.length ? <Empty title="暂无匹配的事件" /> : (
          <ol className="event-list">
            {events.map((event) => (
              <li key={`${event.t}-${event.index}`} className={`lv-${event.lv}`}>
                <TimeText value={event.time} compact />
                <Badge tone={event.lv === "bad" ? "bad" : event.lv === "warn" ? "warn" : "info"}>{event.lv === "bad" ? "错误" : event.lv === "warn" ? "警告" : "信息"}</Badge>
                <NodeTag id={event.nodeId} name={data.nodeName(event.nodeId)} />
                <span className="event-msg">{event.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function TransfersTab() {
  const data = useData();
  const dialogs = useDialogs();
  const { busy, act } = useAct();
  const [overview, setOverview] = useState<OverviewNode[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await api<{ nodes?: OverviewNode[] }>("fleet/overview");
      setOverview(result.nodes ?? []);
      setError("");
    } catch (cause) {
      if (!isAuthError(cause)) setError(errorText(cause, "读取传输记录失败"));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  const transfers = useMemo(() => {
    const map = new Map<string, Transfer>();
    for (const transfer of data.fleet?.transfers ?? []) map.set(transfer.id, transfer);
    for (const node of overview) for (const transfer of node.transfers ?? []) map.set(transfer.id, { nodeId: node.nodeId, ...transfer });
    return [...map.values()].sort((a, b) => (parseTime(b.startedAt ?? b.finishedAt) ?? 0) - (parseTime(a.startedAt ?? a.finishedAt) ?? 0));
  }, [data.fleet, overview]);
  const cancel = (transfer: Transfer) => act(async () => {
    if (!(await dialogs.confirm({ title: "取消文件传输？", message: `${transfer.source} → ${transfer.destination}\n已传输的部分文件可能残留在目标位置。`, confirmText: "取消传输", danger: true }))) return false;
    await api("fleet/transfers/cancel", { copyId: transfer.id });
    await load();
  }, "已发送取消请求");
  return (
    <>
      <p className="fine">GPT 通过 copy_artifact 显式复制单个文件，数据直接在源节点和目标节点之间流动。</p>
      {error && <Notice tone="warn">{error}</Notice>}
      <div className="panel flush">
        {!transfers.length ? <Empty title="暂无文件传输" /> : (
          <ul className="transfer-list">
            {transfers.map((transfer) => {
              const t0 = parseTime(transfer.startedAt);
              const t1 = parseTime(transfer.finishedAt);
              return (
                <li key={transfer.id}>
                  <div className="transfer-main">
                    <strong className="break">{transfer.source} → {transfer.destination}</strong>
                    <div className="sub">
                      {transfer.nodeId && <NodeTag id={transfer.nodeId} name={data.nodeName(transfer.nodeId)} />}
                      <span>{bytes(transfer.bytes)} / {bytes(transfer.totalBytes)}</span>
                      <Badge value={transfer.status}>{label(transfer.status)}</Badge>
                      {t0 !== null && <TimeText value={transfer.startedAt} compact />}
                      {t0 !== null && t1 !== null && <span className="muted">用时 {duration(t1 - t0)}</span>}
                    </div>
                    {transfer.error && <p className="field-error">{transfer.error}</p>}
                    <Meter value={transfer.bytes ?? 0} max={transfer.totalBytes || 1} tone={transfer.status === "failed" ? "bad" : "info"} />
                  </div>
                  {transfer.status === "running" && <button type="button" className="sm danger" disabled={busy} onClick={() => void cancel(transfer)}>取消</button>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function McpTab() {
  const data = useData();
  const calls = data.fleet?.mcpCalls ?? [];
  if (!calls.length) return <div className="panel"><Empty title="MCP 调用审计尚未开启">后端在 fleet/status 中返回 mcpCalls 后，这里会列出 GPT 每次工具调用的工具名、参数摘要、路由去向、耗时和结果。</Empty></div>;
  return (
    <div className="panel flush"><div className="table-scroll"><table className="table">
      <thead><tr><th>时间</th><th>工具</th><th>路由</th><th>耗时</th><th>结果</th></tr></thead>
      <tbody>{calls.map((call) => (
        <tr key={call.id}>
          <td><TimeText value={call.time} compact /></td>
          <td className="cell-title"><code>{call.tool}</code>{call.argsSummary && <div className="sub">{call.argsSummary}</div>}</td>
          <td>{call.routedNode ? <NodeTag id={call.routedNode} name={data.nodeName(call.routedNode)} /> : "—"}{call.routedRoot && <div className="sub"><code>{call.routedRoot}</code></div>}</td>
          <td>{call.durationMs != null ? duration(call.durationMs) : "—"}</td>
          <td>{call.ok ? <Badge tone="ok">成功</Badge> : <Badge tone="bad" >{call.error ?? "失败"}</Badge>}</td>
        </tr>
      ))}</tbody>
    </table></div></div>
  );
}

function AuditTab() {
  const audit = useData().fleet?.audit ?? [];
  if (!audit.length) return <div className="panel"><Empty title="配置审计尚未开启">后端记录配置变更（谁、何时、改了什么、前后内容）后会在这里显示。</Empty></div>;
  return (
    <div className="panel flush">
      <ul className="row-list">{audit.map((entry) => (
        <li key={entry.id} className="audit-line">
          <TimeText value={entry.time} compact />
          <strong>{entry.action}</strong>
          <span className="muted">{entry.target ?? ""}{entry.actor ? ` · ${entry.actor}` : ""}</span>
          {(entry.before !== undefined || entry.after !== undefined) && (
            <details><summary>查看变更</summary><pre className="ev-detail">{`- ${JSON.stringify(entry.before, null, 2)}\n+ ${JSON.stringify(entry.after, null, 2)}`}</pre></details>
          )}
        </li>
      ))}</ul>
    </div>
  );
}
