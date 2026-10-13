import { useCallback, useEffect, useMemo, useState } from "react";
import { api, AUTHENTICATED, errorText, isAuthError } from "../api.js";
import { duration, fmtTime, isActive, label, LOCAL, num, parseTime, qualityHelp, sourceLabels } from "../format.js";
import { navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { Badge, CopyButton, Dialog, DiffStatText, Elapsed, Empty, Link, NodeTag, Notice, Tabs, TimeText, TokenValue } from "../ui.js";
import { RunChanges } from "./DiffView.js";
import { ThreadControls } from "./Sessions.js";
import type { Detail, Thread, TimelineEvent } from "../types.js";

type DTab = "summary" | "changes" | "timeline" | "evidence" | "context" | "control";
const TABS: DTab[] = ["summary", "changes", "timeline", "evidence", "context", "control"];

const TYPE_LABELS: Record<string, string> = {
  message: "消息", reasoning: "推理摘要", command: "命令", file_change: "文件修改", mcp_call: "MCP 调用",
  subagent_start: "子代理启动", subagent_end: "子代理结束", error: "错误", created: "任务登记",
  turn_start: "执行开始", turn_end: "执行结束", finished: "任务结束", operation: "操作",
};

export function ExecutionDrawer({ node, project, run }: { node: string; project: string; run: string }) {
  const data = useData();
  const route = useRoute();
  const raw = route.get("dtab") as DTab;
  const tab: DTab = TABS.includes(raw) ? raw : "summary";
  const [fetchedDetail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const listedRun = data.runs.find((entry) => entry.nodeId === node && entry.projectId === project && entry.workRunId === run);
  const detail = useMemo(() => fetchedDetail ? {
    ...fetchedDetail,
    createdAt: fetchedDetail.createdAt ?? listedRun?.createdAt,
    startedAt: fetchedDetail.startedAt ?? fetchedDetail.createdAt ?? listedRun?.startedAt ?? listedRun?.createdAt,
    turns: fetchedDetail.turns.map((turn) => ({ ...turn, startedAt: turn.startedAt ?? turn.createdAt })),
  } : null, [fetchedDetail, listedRun]);

  const load = useCallback(async () => {
    try {
      const result = await api<Detail>(`projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(run)}`, undefined, node);
      setDetail({ ...result, evidence: result.evidence ?? [], operations: result.operations ?? [], turns: result.turns ?? [] });
      setError("");
    } catch (cause) {
      if (!isAuthError(cause)) setError(errorText(cause, "读取任务详情失败"));
    }
  }, [node, project, run]);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(AUTHENTICATED, refresh);
    return () => window.removeEventListener(AUTHENTICATED, refresh);
  }, [load]);
  const active = detail ? isActive(detail.executionStatus) : false;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => clearInterval(timer);
  }, [active, load]);

  const close = () => navigate({ exec: null, dtab: null });
  const setTab = (value: DTab) => navigate({ dtab: value === "summary" ? null : value }, { replace: true });
  const projectName = data.allProjects.find((entry) => entry.nodeId === node && entry.id === project)?.name ?? project;
  const ref = `${node}/exec/${run}`;
  const timeline = useMemo(() => (detail ? timelineOf(detail) : { items: [], synthetic: true }), [detail]);

  return (
    <Dialog title="任务详情与完成回执" size="drawer" onClose={close}>
      {!detail && error && <Notice tone="bad" action={<button type="button" className="sm" onClick={() => void load()}>重试</button>}>{error}</Notice>}
      {!detail && !error && <div className="loading"><span className="spinner" />正在读取任务详情…</div>}
      {detail && (
        <div className="drawer">
          <div className="drawer-head">
            <div className="drawer-crumbs">
              <NodeTag id={node} name={data.nodeName(node)} />
              <span>{projectName}</span>
              <span>·</span>
              <span>{sourceLabels[detail.origin?.entryPoint ?? ""] ?? detail.origin?.entryPoint ?? "来源未记录"}</span>
            </div>
            <h2 className="drawer-title">{detail.title || run}</h2>
            <div className="button-row">
              <Badge value={detail.executionStatus} />
              <Badge value={detail.acceptanceStatus} />
              <Elapsed start={parseTime(detail.startedAt ?? detail.createdAt)} end={parseTime(detail.finishedAt)} active={active} />
              <span className="spacer" />
              <CopyButton text={ref} label="复制引用" />
            </div>
            {error && <Notice tone="warn">刷新失败：{error}。以下是上次读取的内容。</Notice>}
          </div>
          <Tabs<DTab> value={tab} onChange={setTab} tabs={[
            ["summary", "概要"],
            ["changes", "改动", detail.changes?.files?.length ?? detail.diffStat?.files ?? 0],
            ["timeline", "时间线", timeline.items.length],
            ["evidence", "验收证据", detail.evidence.length],
            ["context", "执行上下文", detail.turns.length],
            ["control", "会话控制"],
          ]} />
          <div className="drawer-body">
            {tab === "summary" && <SummaryTab detail={detail} nodeName={data.nodeName(node)} projectName={projectName} onTab={setTab} timelineCount={timeline.items.length} />}
            {tab === "changes" && <RunChanges detail={detail} name={detail.title || run} />}
            {tab === "timeline" && <TimelineTab items={timeline.items} synthetic={timeline.synthetic} />}
            {tab === "evidence" && <EvidenceTab detail={detail} />}
            {tab === "context" && <ContextTab detail={detail} />}
            {tab === "control" && <ControlTab node={node} project={project} run={run} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SummaryTab({ detail, nodeName, projectName, onTab, timelineCount }: {
  detail: Detail; nodeName: string; projectName: string; onTab: (tab: DTab) => void; timelineCount: number;
}) {
  const usage = detail.codexUsage;
  const active = isActive(detail.executionStatus);
  return (
    <div className="stack">
      {detail.attentionReason && <Notice tone="bad"><b>需要处理：</b>{detail.attentionReason}</Notice>}
      {detail.executionStatus === "reconciliation_required" && !detail.attentionReason && <Notice tone="warn">这次执行的结果需要核对（例如进程中断、回执缺失）。系统不会自动重放，请查看时间线和会话控制后再决定下一步。</Notice>}
      {detail.executionStatus === "interrupted" && <Notice tone="warn">执行中断，可恢复。租约到期且没有活跃子任务，这次工作不再显示为仍在运行。历史记录仍在，可从原 run 恢复。</Notice>}
      <section>
        <h3>完成回执</h3>
        <p className="summary-text">{detail.summary || "工作尚未提交最终验收摘要。模型回复结束不等于验收通过。"}</p>
      </section>
      <div className="quick-links">
        <button type="button" onClick={() => onTab("changes")}><span>改动</span><DiffStatText stat={detail.diffStat} /></button>
        <button type="button" onClick={() => onTab("timeline")}><span>时间线</span><b>{timelineCount}</b></button>
        <button type="button" onClick={() => onTab("evidence")}><span>验收证据</span><b>{detail.evidence.length}</b></button>
        <button type="button" onClick={() => onTab("context")}><span>Codex 执行</span><b>{detail.turns.length}</b></button>
      </div>
      <dl className="kv">
        <div><dt>机器</dt><dd>{nodeName}</dd></div>
        <div><dt>项目</dt><dd>{projectName}</dd></div>
        <div><dt>任务 ID</dt><dd><code>{detail.workRunId}</code></dd></div>
        <div><dt>来源</dt><dd>{sourceLabels[detail.origin?.entryPoint ?? ""] ?? detail.origin?.entryPoint ?? "—"}{detail.origin?.clientLabel ? ` · ${detail.origin.clientLabel}` : ""}</dd></div>
        <div><dt>登记时间</dt><dd><TimeText value={detail.createdAt} rel /></dd></div>
        <div><dt>开始时间</dt><dd><TimeText value={detail.startedAt ?? detail.createdAt} /></dd></div>
        <div><dt>结束时间</dt><dd>{detail.finishedAt ? <TimeText value={detail.finishedAt} rel /> : <span className="muted">{active ? "进行中" : "未记录"}</span>}</dd></div>
        <div><dt>耗时</dt><dd><Elapsed start={parseTime(detail.startedAt ?? detail.createdAt)} end={parseTime(detail.finishedAt)} active={active} /></dd></div>
        <div><dt>模型标签</dt><dd>{detail.origin?.modelLabel ?? "—"}{detail.origin?.modelLabel && <small className="muted"> · 标签不作为可信来源证明</small>}</dd></div>
        <div><dt>Codex 会话</dt><dd>{detail.codexThreads}</dd></div>
        <div><dt>回执版本</dt><dd>{detail.receiptRevision}</dd></div>
        <div><dt>执行次数</dt><dd>{detail.executions}{detail.pendingExecutions ? `（${detail.pendingExecutions} 个进行中）` : ""}</dd></div>
      </dl>
      <section className="usage-box">
        <div className="usage-main">
          <TokenValue usage={detail} />
          <p className="fine">{qualityHelp[detail.usageStatus] ?? ""}{detail.usageQualityReason ? ` ${detail.usageQualityReason}` : ""}{detail.missingExecutions ? ` · ${detail.missingExecutions} 个执行存在用量缺口` : ""}</p>
        </div>
        <dl className="breakdown">
          <div><dt>输入</dt><dd>{num(usage?.inputTokens)}</dd></div>
          <div><dt>其中缓存读取</dt><dd>{num(usage?.cachedInputTokens)}</dd></div>
          <div><dt>缓存写入</dt><dd>{num(usage?.cacheWriteInputTokens)}</dd></div>
          <div><dt>输出</dt><dd>{num(usage?.outputTokens)}</dd></div>
          <div><dt>其中推理</dt><dd>{num(usage?.reasoningOutputTokens)}</dd></div>
        </dl>
        <p className="fine">缓存与推理是明细，不重复计入总量；Token 不等于订阅账单。</p>
      </section>
    </div>
  );
}

function timelineOf(detail: Detail): { items: TimelineEvent[]; synthetic: boolean } {
  const byTime = (a: TimelineEvent, b: TimelineEvent) => (parseTime(a.time) ?? 0) - (parseTime(b.time) ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);
  if (detail.events?.length) return { items: [...detail.events].sort(byTime), synthetic: false };
  const items: TimelineEvent[] = [];
  if (detail.createdAt) items.push({ time: detail.createdAt, type: "created", title: "任务登记" });
  for (const turn of detail.turns) {
    if (turn.startedAt) items.push({ time: turn.startedAt, type: "turn_start", title: `Codex 执行开始`, detail: [turn.requestedModel, turn.requestedEffort].filter(Boolean).join(" · ") || undefined, agentId: turn.agentId });
    if (turn.finishedAt) {
      const s = parseTime(turn.startedAt);
      const e = parseTime(turn.finishedAt);
      items.push({ time: turn.finishedAt, type: "turn_end", title: `Codex 执行${label(turn.status)}`, detail: `${num(turn.codexUsage?.totalTokens)} Token · ${turn.boundary}`, durationMs: s !== null && e !== null ? e - s : null, agentId: turn.agentId });
    }
  }
  for (const op of detail.operations) items.push({ time: op.created_at, type: op.kind || "operation", title: op.label, detail: label(op.status) });
  if (detail.finishedAt) items.push({ time: detail.finishedAt, type: "finished", title: `任务${label(detail.executionStatus)}` });
  return { items: items.filter((item) => parseTime(item.time) !== null).sort(byTime), synthetic: true };
}

function TimelineTab({ items, synthetic }: { items: TimelineEvent[]; synthetic: boolean }) {
  const [agent, setAgent] = useState("");
  const [query, setQuery] = useState("");
  const agents = [...new Set(items.map((item) => item.agentId).filter((value): value is string => Boolean(value)))];
  const first = parseTime(items[0]?.time) ?? 0;
  const shown = items.filter((item) => (!agent || item.agentId === agent) && (!query || `${item.title ?? ""} ${item.detail ?? ""} ${item.type}`.toLowerCase().includes(query.toLowerCase())));
  if (!items.length) return <Empty title="暂无时间线">后端尚未记录这次执行的过程事件。</Empty>;
  return (
    <div className="stack">
      {synthetic && <Notice tone="info">后端尚未上报完整事件流。以下时间线由执行记录与操作记录合成，不包含命令输出和推理过程。</Notice>}
      <div className="filters">
        <input type="search" className="filter-search" placeholder="搜索事件" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索事件" />
        {agents.length > 1 && (
          <select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="按代理筛选">
            <option value="">全部代理（{agents.length}）</option>
            {agents.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        )}
      </div>
      <ol className="timeline-list">
        {shown.map((item, index) => {
          const t = parseTime(item.time) ?? first;
          const offset = t - first;
          return (
            <li key={`${item.seq ?? index}-${item.time}`} className={`ev ev-${item.type}`}>
              <div className="ev-time">
                <time title={fmtTime(t)}>{fmtTime(t).slice(11)}</time>
                <small>+{duration(offset)}</small>
              </div>
              <div className="ev-body">
                <div className="ev-title">
                  <span className="ev-type">{TYPE_LABELS[item.type] ?? item.type}</span>
                  <strong>{item.title}</strong>
                  {item.exitCode !== undefined && item.exitCode !== null && <Badge tone={item.exitCode === 0 ? "ok" : "bad"}>退出码 {item.exitCode}</Badge>}
                  {item.durationMs !== undefined && item.durationMs !== null && <span className="muted">{duration(item.durationMs)}</span>}
                </div>
                {item.detail && (item.type === "command" || item.detail.includes("\n") ? <pre className="ev-detail">{item.detail}</pre> : <p className="ev-text">{item.detail}</p>)}
                {item.agentId && <code className="ev-agent">{item.agentId}</code>}
              </div>
            </li>
          );
        })}
      </ol>
      {!shown.length && <p className="muted">没有匹配的事件。</p>}
    </div>
  );
}

function EvidenceTab({ detail }: { detail: Detail }) {
  return (
    <div className="stack">
      <section>
        <h3>验收证据</h3>
        {detail.evidence.length ? (
          <ul className="evidence-list">
            {detail.evidence.map((entry, index) => (
              <li key={index}><Badge value={entry.outcome} /><div><strong>{entry.label}</strong><code>{entry.reference}</code></div></li>
            ))}
          </ul>
        ) : <p className="muted">尚无最终验收证据，不将模型回复自动视为通过。</p>}
      </section>
      <section>
        <h3>工具与验证操作</h3>
        {detail.operations.length ? (
          <ul className="op-list">
            {detail.operations.map((op) => (
              <li key={op.id}><span className="op-kind">{op.kind}</span><span className="op-label">{op.label}</span><Badge value={op.status} /><TimeText value={op.created_at} compact /></li>
            ))}
          </ul>
        ) : <p className="muted">没有记录工具或验证操作。</p>}
      </section>
      <p className="fine">这里只展示任务摘要与证据引用，不复制私人聊天全文或隐藏推理。</p>
    </div>
  );
}

function ContextTab({ detail }: { detail: Detail }) {
  return (
    <div className="stack">
      <section>
        <h3>来源</h3>
        <dl className="kv">
          <div><dt>入口</dt><dd>{sourceLabels[detail.origin?.entryPoint ?? ""] ?? detail.origin?.entryPoint ?? "—"}</dd></div>
          <div><dt>客户端</dt><dd>{detail.origin?.clientLabel ?? "—"}</dd></div>
          <div><dt>模型标签</dt><dd>{detail.origin?.modelLabel ?? "—"}</dd></div>
          <div><dt>来源依据</dt><dd>{detail.origin?.evidence ?? "—"}</dd></div>
        </dl>
      </section>
      <section>
        <h3>Codex 执行</h3>
        {detail.turns.length ? detail.turns.map((turn) => (
          <article className="exec-card" key={turn.executionId}>
            <header><code>{turn.agentId}</code><Badge value={turn.status} /></header>
            <dl className="kv compact">
              <div><dt>模型</dt><dd>{turn.requestedModel ?? "未记录"}</dd></div>
              <div><dt>推理档位</dt><dd>{turn.requestedEffort ?? "未记录"}</dd></div>
              <div><dt>Token</dt><dd>{num(turn.codexUsage?.totalTokens)} · {qualityHelp[turn.usageStatus] ? label(turn.usageStatus) : turn.usageStatus}</dd></div>
              <div><dt>开始 / 结束</dt><dd><TimeText value={turn.startedAt} compact /> → <TimeText value={turn.finishedAt} compact /></dd></div>
            </dl>
            <p className="fine">{turn.boundary}</p>
          </article>
        )) : <p className="muted">没有 Codex 执行记录；主控和本地工具可以独立完成任务。</p>}
      </section>
      <p className="fine">skills、AGENTS.md 与代理配置目前只在对话里的工作区卡片中展示；后端把它们关联到执行后，会在这里显示。</p>
    </div>
  );
}

function ControlTab({ node, project, run }: { node: string; project: string; run: string }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await api<{ threads?: Thread[] }>(`projects/${encodeURIComponent(project)}/threads`, undefined, node);
      setThreads((result.threads ?? []).filter((thread) => (thread.runs ?? []).some((entry) => entry.id === run)));
      setError("");
    } catch (cause) {
      if (!isAuthError(cause)) setError(errorText(cause, "读取会话失败"));
    }
  }, [node, project, run]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => clearInterval(timer);
  }, [load]);
  if (error && !threads) return <Notice tone="bad" action={<button type="button" className="sm" onClick={() => void load()}>重试</button>}>{error}</Notice>;
  if (!threads) return <div className="loading"><span className="spinner" />正在读取关联会话…</div>;
  return (
    <div className="stack">
      {!threads.length ? <Empty title="没有关联的 Codex 会话">主控直接完成的任务不会创建 Codex 聊天。</Empty> : threads.map((thread) => (
        <article className="thread-card" key={thread.id}>
          <header>
            <div><strong>{thread.title}</strong><code>{thread.agentId}</code></div>
            <div className="button-row"><Badge value={thread.archiveState} />{thread.protected && <Badge tone="ok">已保留</Badge>}{thread.externalActivity && <Badge tone="bad">外部续写</Badge>}</div>
          </header>
          <ThreadControls thread={thread} nodeId={node} projectId={project} onChanged={() => void load()} />
        </article>
      ))}
      <Link to={{ view: "sessions", node: node === LOCAL ? null : node, project }} reset className="more-link">到会话页管理归档与保留 →</Link>
    </div>
  );
}
