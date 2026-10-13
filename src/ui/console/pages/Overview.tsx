import { useEffect, useMemo, useRef, useState } from "react";
import { execParam, navigate } from "../router.js";
import { useData } from "../store.js";
import { isActive, isDone, num, parseTime } from "../format.js";
import { getAttentionItems } from "../attention.js";
import { Badge, CopyButton, DiffStatText, Elapsed, Empty, Link, NodeTag, Notice, TimeText, TokenValue } from "../ui.js";
import { MachineCard } from "./Machines.js";
import { mergeUsage } from "../usage.js";

const ATTENTION_LIMIT_KEY = "qm_overview_attention_limit";

function getInitialAttentionLimit(): number {
  try {
    const raw = localStorage.getItem(ATTENTION_LIMIT_KEY);
    if (raw === "all") return 999;
    const parsed = Number(raw);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  } catch {}
  return 3;
}

export function OverviewPage() {
  const data = useData();
  const [attentionLimit, setAttentionLimit] = useState<number>(getInitialAttentionLimit);
  const [zoomScale, setZoomScale] = useState<number>(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const todayStart = new Date(new Date().toDateString()).getTime();
  const attention = useMemo(() => getAttentionItems(data), [data]);

  useEffect(() => {
    const updateZoom = () => {
      if (!containerRef.current) return;
      const width = containerRef.current.clientWidth;
      // 智能缩放：当可用宽度低于 1080px 时自动按比例等比缩放，确保 4 台机器始终同行展示
      if (width > 0 && width < 1080) {
        const factor = Math.max(0.68, width / 1080);
        setZoomScale(Number(factor.toFixed(3)));
      } else {
        setZoomScale(1);
      }
    };
    updateZoom();
    const observer = new ResizeObserver(updateZoom);
    if (containerRef.current) observer.observe(containerRef.current);
    window.addEventListener("resize", updateZoom);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateZoom);
    };
  }, []);

  const changeAttentionLimit = (newLimit: number) => {
    setAttentionLimit(newLimit);
    try {
      localStorage.setItem(ATTENTION_LIMIT_KEY, newLimit >= 999 ? "all" : String(newLimit));
    } catch {}
  };

  const visibleAttention = attention.slice(0, attentionLimit);

  const running = data.runs.filter((run) => isActive(run.executionStatus));
  const today = data.runs.filter((run) => (run.startMs ?? 0) >= todayStart);
  const doneToday = data.runs.filter((run) => isDone(run.executionStatus) && (parseTime(run.finishedAt) ?? 0) >= todayStart).length;
  const failedToday = data.runs.filter((run) => run.executionStatus === "failed" && (parseTime(run.finishedAt) ?? 0) >= todayStart).length;
  const hasDiff = today.some((run) => run.diffStat);
  const linesToday = today.reduce((sum, run) => sum + (run.diffStat ? run.diffStat.additions + run.diffStat.deletions : 0), 0);
  const pending = data.scopedProjects.reduce((sum, project) => sum + (project.pendingAcceptance ?? 0), 0);
  const usage = useMemo(() => mergeUsage(data.scopedProjects), [data.scopedProjects]);

  const targetNodes = (data.fleet?.nodes && data.fleet.nodes.length > 0) ? data.fleet.nodes : data.nodes;
  const recentByNode = targetNodes.map((node) => ({
    node,
    runs: data.runs.filter((run) => run.nodeId === node.id).slice(0, 2)
  }));

  return (
    <div ref={containerRef} className="overview-container" style={{ "--ov-zoom": zoomScale } as React.CSSProperties}>
      <div className="overview-scalable stack">
        {attention.length > 0 ? (
          <section className="panel attention">
            <div className="panel-head">
              <div className="attention-title-group">
                <h2>状态提醒与近期失败 <span className="count bad">{attention.length}</span></h2>
                <span className="muted">当前告警恢复后消失；近 24 小时的失败记录保留</span>
              </div>
              <div className="attention-toolbar">
                <span className="muted">显示条数：</span>
                <select
                  className="attention-limit-select"
                  value={attentionLimit >= 999 ? "all" : attentionLimit}
                  onChange={(e) => changeAttentionLimit(e.target.value === "all" ? 999 : Number(e.target.value))}
                  aria-label="状态提醒显示条数"
                >
                  <option value={3}>最近 3 条（默认）</option>
                  <option value={5}>最近 5 条</option>
                  <option value={10}>最近 10 条</option>
                  <option value="all">显示全部 ({attention.length})</option>
                </select>
              </div>
            </div>
            <ul className="attention-list">
              {visibleAttention.map((item) => (
                <li key={item.key} className={`att-${item.tone}`}>
                  <div><strong>{item.title}</strong><small>{item.detail}</small></div>
                  <button type="button" className="sm" onClick={item.action}>{item.actionText}</button>
                </li>
              ))}
            </ul>
            {attention.length > attentionLimit ? (
              <div className="attention-foot">
                <span className="muted">已显示最近 {visibleAttention.length} 条（共 {attention.length} 条）</span>
                <button type="button" className="linklike sm" onClick={() => changeAttentionLimit(999)}>展开全部 ({attention.length} 条) →</button>
              </div>
            ) : attentionLimit >= 999 && attention.length > 3 ? (
              <div className="attention-foot">
                <span className="muted">已显示全部 {attention.length} 条</span>
                <button type="button" className="linklike sm" onClick={() => changeAttentionLimit(3)}>收起为最近 3 条 ↑</button>
              </div>
            ) : null}
          </section>
        ) : data.mode !== "unknown" && !data.runsLoading && !data.fleetError && !data.runErrors.length && <Notice tone="ok">一切正常：没有失败、待核对的任务，也没有离线机器。</Notice>}

        {data.hasMore && <p className="fine">任务指标基于已加载记录；项目用量为当前范围累计。</p>}
        <section className="metrics">
          <article className="metric"><span>运行中</span><strong>{running.length}</strong><small>{running.length ? `最早开始于 ${running.at(-1)?.startMs ? new Date(running.at(-1)!.startMs!).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}` : "当前没有执行中的任务"}</small></article>
          <article className="metric"><span>今日完成</span><strong className="ok">{doneToday}</strong><small>执行结束，不代表验收通过</small></article>
          <article className="metric"><span>今日失败</span><strong className={failedToday ? "bad" : ""}>{failedToday}</strong><small>失败原因见任务详情</small></article>
          <article className="metric"><span>等待验收</span><strong className={pending ? "warn" : ""}>{pending}</strong><small>模型回复结束 ≠ 验收通过</small></article>
          <article className="metric"><span>今日改动</span><strong>{hasDiff ? num(linesToday) : "—"}</strong><small>{hasDiff ? "新增 + 删除行数" : "后端尚未上报改动统计"}</small></article>
          <article className="metric"><span>已记录 Token</span><TokenValue usage={usage} /><small>当前范围累计 · 不等于订阅账单</small></article>
        </section>

        {data.mode === "fleet" && data.fleet && (
          <section className="overview-row-section">
            <div className="section-head"><h2>机器 (4 台同行展示)</h2><Link to={{ view: "machines" }} className="more-link">全部机器 →</Link></div>
            <div className="machine-layout">
              <div className="machine-grid overview-four-col">{data.fleet.nodes.map((node) => <MachineCard key={node.id} node={node} gateway={node.id === data.fleet?.gatewayId} running={data.runs.filter((run) => run.nodeId === node.id && isActive(run.executionStatus))} />)}</div>
            </div>
          </section>
        )}

        <section className="overview-row-section">
          <div className="section-head"><h2>最近任务 (同行展示)</h2><Link to={{ view: "tasks" }} className="more-link">全部任务 →</Link></div>
          {!recentByNode.length ? (
            <div className="panel"><Empty title={data.runsLoading ? "正在读取任务…" : "还没有任务"}>通过 QuayMesh 打开工作区，再由主控使用 work_task 开始一项任务。纯主控任务也会记账，未调用 Codex 时明确显示零。</Empty></div>
          ) : (
            <div className="recent-grid overview-four-col">
              {recentByNode.map(({ node, runs }) => (
                <div className="panel" key={node.id}>
                  <div className="panel-head"><NodeTag id={node.id} name={"name" in node ? node.name : node.nickname} online={node.online} /><Link to={{ view: "tasks", node: node.id === "local" ? null : node.id }} className="more-link">查看 →</Link></div>
                  {runs.length === 0 ? (
                    <p className="muted empty-mini">暂无近期任务</p>
                  ) : (
                    <ul className="mini-runs">
                      {runs.map((run) => (
                        <li key={run.key}>
                          <button type="button" className="link-title" onClick={() => navigate({ exec: execParam(run.nodeId, run.projectId, run.workRunId), dtab: null })}>{run.title || run.workRunId}</button>
                          <div className="mini-meta"><Badge value={run.executionStatus} /><TimeText value={run.startedAt ?? run.createdAt} compact /><Elapsed start={run.startMs} end={run.endMs} active={isActive(run.executionStatus)} /><DiffStatText stat={run.diffStat} /></div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {data.fleet?.publicMcpUrl && (
          <section className="panel endpoint">
            <div><h3>当前节点的 MCP 地址</h3><code>{data.fleet.publicMcpUrl}</code><p className="muted">供节点连接与维护使用。ChatGPT 继续使用已配置的 NAT 主控连接。</p></div>
            <CopyButton text={data.fleet.publicMcpUrl} label="复制地址" className="" />
          </section>
        )}
      </div>
    </div>
  );
}
