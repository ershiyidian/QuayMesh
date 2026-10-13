import { useMemo, type ReactNode } from "react";
import { execParam, navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { duration, fmtTime, isActive, isDone, label, needsAttention, sourceLabels, tone } from "../format.js";
import { Badge, CopyButton, DiffStatText, Elapsed, Empty, NodeTag, Notice, Segmented, TimeText, TokenValue, useSlowNow } from "../ui.js";
import { matchRun, RunFilters } from "./common.js";
import { rangeDays } from "../validation.js";
import type { RunRow } from "../types.js";

type Layout = "list" | "board" | "timeline";
type Sort = "time" | "duration" | "tokens" | "attention";

export const openRun = (run: Pick<RunRow, "nodeId" | "projectId" | "workRunId">, tab?: string): void =>
  navigate({ exec: execParam(run.nodeId, run.projectId, run.workRunId), dtab: tab ?? null });

export const runRef = (run: Pick<RunRow, "nodeId" | "workRunId">): string => `${run.nodeId}/exec/${run.workRunId}`;

export function useFilteredRuns(): RunRow[] {
  const data = useData();
  const route = useRoute();
  const q = route.get("q");
  const sort = (route.get("sort") || "time") as Sort;
  const changedOnly = route.get("changed") === "1";
  return useMemo(() => {
    const now = Date.now();
    const rows = data.runs.filter((run) => matchRun(run.title ?? "", run.workRunId, q) && (!changedOnly || (run.diffStat?.files ?? 0) > 0));
    const length = (run: RunRow) => (run.startMs === null ? -1 : (run.endMs ?? (isActive(run.executionStatus) ? now : run.startMs)) - run.startMs);
    if (sort === "duration") rows.sort((a, b) => length(b) - length(a));
    else if (sort === "tokens") rows.sort((a, b) => (b.codexUsage?.totalTokens ?? -1) - (a.codexUsage?.totalTokens ?? -1));
    else if (sort === "attention") {
      const rank = (run: RunRow) => (needsAttention(run.executionStatus) ? 0 : run.executionStatus === "failed" ? 1 : isActive(run.executionStatus) ? 2 : 3);
      rows.sort((a, b) => rank(a) - rank(b) || (b.startMs ?? 0) - (a.startMs ?? 0));
    }
    return rows;
  }, [data.runs, q, sort, changedOnly]);
}

export function TasksPage() {
  const data = useData();
  const route = useRoute();
  const rows = useFilteredRuns();
  const rawLayout = route.get("layout");
  const layout: Layout = rawLayout === "board" || rawLayout === "timeline" ? rawLayout : "list";
  const multi = data.nodes.length > 1;
  const grouped = multi && route.get("group") !== "0";
  const filtered = ["q", "status", "source", "range", "changed"].some((key) => route.get(key));
  const running = rows.filter((run) => isActive(run.executionStatus)).length;
  const failed = rows.filter((run) => run.executionStatus === "failed").length;
  const attention = rows.filter((run) => needsAttention(run.executionStatus)).length;

  return (
    <div className="stack">
      <div className="toolbar">
        <RunFilters extra={<>
          <select aria-label="排序" value={route.get("sort") || "time"} onChange={(event) => navigate({ sort: event.target.value === "time" ? null : event.target.value })}>
            <option value="time">按开始时间</option>
            <option value="attention">需处理优先</option>
            <option value="duration">按耗时</option>
            <option value="tokens">按 Token</option>
          </select>
          <label className="check"><input type="checkbox" checked={route.get("changed") === "1"} onChange={(event) => navigate({ changed: event.target.checked ? "1" : null })} />只看有改动</label>
          {multi && <label className="check"><input type="checkbox" checked={grouped} onChange={(event) => navigate({ group: event.target.checked ? null : "0" })} />按机器分组</label>}
        </>} />
        <Segmented<Layout> ariaLabel="视图" value={layout} options={[["list", "列表"], ["board", "看板"], ["timeline", "时间轴"]]}
          onChange={(value) => navigate({ layout: value === "list" ? null : value }, { replace: true })} />
      </div>

      {data.nodes.filter((node) => !node.online && (!data.scopeNode || data.scopeNode === node.id)).map((node) => <Notice key={node.id} tone="warn">{node.name} 已离线；该机器只显示本次会话已缓存的任务。</Notice>)}
      {Object.values(data.projects).filter((entry) => entry.error && (!data.scopeNode || data.scopeNode === entry.nodeId)).map((entry) => <Notice key={entry.nodeId} tone="warn">{data.nodeName(entry.nodeId)}：{entry.error}</Notice>)}
      {data.runErrors.map((error) => (
        <Notice key={error.key} tone="warn" action={<button type="button" className="sm" onClick={() => void data.refresh()}>重试</button>}>
          {data.nodeName(error.nodeId)} / {error.projectId}：{error.message}。其他机器的数据照常显示。
        </Notice>
      ))}

      <div className="result-line">
        <span>共 <b>{rows.length}</b> 项</span>
        {running > 0 && <span className="info">· {running} 项运行中</span>}
        {attention > 0 && <span className="bad">· {attention} 项待核对</span>}
        {failed > 0 && <span className="bad">· {failed} 项失败</span>}
        {data.runsLoading && <span className="muted">· 正在读取…</span>}
        {data.hasMore && <span className="muted">· 还有更早的任务未加载</span>}
      </div>

      {!rows.length ? (
        <div className="panel">
          {filtered ? (
            <Empty title="没有符合条件的任务" action={<button type="button" onClick={() => navigate({ q: null, status: null, source: null, range: null, changed: null })}>清除筛选</button>}>
              调整筛选条件，或扩大时间范围。
            </Empty>
          ) : (
            <Empty title={data.runsLoading ? "正在读取任务…" : "还没有任务"}>
              通过 QuayMesh 打开工作区，再由主控使用 work_task 开始一项任务。纯主控任务也会记账，未调用 Codex 时明确显示零。
            </Empty>
          )}
        </div>
      ) : layout === "board" ? <BoardView rows={rows} /> : layout === "timeline" ? <TimelineView rows={rows} /> : <ListView rows={rows} grouped={grouped} />}

      {data.hasMore && <button type="button" className="load-more" onClick={() => void data.loadMore()}>加载更早的任务</button>}
    </div>
  );
}

function ListView({ rows, grouped }: { rows: RunRow[]; grouped: boolean }) {
  const data = useData();
  const groups = grouped
    ? data.nodes.map((node) => ({ id: node.id, name: node.name, online: node.online, rows: rows.filter((run) => run.nodeId === node.id) })).filter((group) => group.rows.length)
    : [{ id: "", name: "", online: true, rows }];
  const showNode = !grouped && data.nodes.length > 1;
  return (
    <div className="panel flush">
      <div className="table-scroll">
        <table className="table runs-table">
          <thead>
            <tr><th>任务</th><th>执行 / 验收</th><th>开始时间</th><th>耗时</th><th>改动</th><th>Codex Token</th><th><span className="sr-only">操作</span></th></tr>
          </thead>
          {groups.map((group) => {
            const active = group.rows.filter((run) => isActive(run.executionStatus)).length;
            return (
              <tbody key={group.id || "all"}>
                {grouped && (
                  <tr className="group-row">
                    <td colSpan={7}><NodeTag id={group.id} name={group.name} online={group.online} /><span className="muted">{group.rows.length} 项{active ? ` · ${active} 项运行中` : ""}</span></td>
                  </tr>
                )}
                {group.rows.map((run) => <RunTr key={run.key} run={run} showNode={showNode} />)}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}

function RunTr({ run, showNode }: { run: RunRow; showNode: boolean }) {
  const data = useData();
  const attention = needsAttention(run.executionStatus);
  return (
    <tr className={`run-row ${attention ? "row-attn" : ""} ${run.executionStatus === "failed" ? "row-failed" : ""}`} onClick={() => openRun(run)}>
      <td className="cell-title">
        <button type="button" className="link-title" onClick={(event) => { event.stopPropagation(); openRun(run); }}>{run.title || run.workRunId}</button>
        <div className="sub">
          {showNode && <NodeTag id={run.nodeId} name={data.nodeName(run.nodeId)} />}
          <span>{run.projectName}</span>
          <span>· {sourceLabels[run.origin?.entryPoint ?? ""] ?? run.origin?.entryPoint ?? "来源未记录"}</span>
          {run.origin?.modelLabel && <span title="模型名称标签不作为可信来源证明">· {run.origin.modelLabel}（标签）</span>}
        </div>
        {run.lastEventSummary && <div className="last-event" title={run.lastEventSummary}>{run.lastEventSummary}</div>}
        {run.attentionReason && <div className="attn-reason">{run.attentionReason}</div>}
      </td>
      <td><div className="state-stack"><Badge value={run.executionStatus} /><Badge value={run.acceptanceStatus} /></div></td>
      <td><TimeText value={run.startedAt ?? run.createdAt} compact rel /></td>
      <td><Elapsed start={run.startMs} end={run.endMs} active={isActive(run.executionStatus)} /></td>
      <td>
        {run.diffStat?.files
          ? <button type="button" className="linklike" title="查看改动" onClick={(event) => { event.stopPropagation(); openRun(run, "changes"); }}><DiffStatText stat={run.diffStat} /></button>
          : <DiffStatText stat={run.diffStat} />}
      </td>
      <td><TokenValue usage={run} compact /></td>
      <td className="cell-actions" onClick={(event) => event.stopPropagation()}><CopyButton text={runRef(run)} label="复制引用" /></td>
    </tr>
  );
}

function BoardView({ rows }: { rows: RunRow[] }) {
  const data = useData();
  const byNode = data.nodes.length > 1;
  const columns: { key: string; head: ReactNode; rows: RunRow[] }[] = byNode
    ? data.nodes.map((node) => ({ key: node.id, head: <NodeTag id={node.id} name={node.name} online={node.online} />, rows: rows.filter((run) => run.nodeId === node.id) }))
    : [
        { key: "active", head: "运行中", rows: rows.filter((run) => isActive(run.executionStatus)) },
        { key: "attention", head: "需处理", rows: rows.filter((run) => needsAttention(run.executionStatus) || run.executionStatus === "failed") },
        { key: "done", head: "执行完成", rows: rows.filter((run) => isDone(run.executionStatus)) },
        { key: "other", head: "已取消 / 其他", rows: rows.filter((run) => !isActive(run.executionStatus) && !needsAttention(run.executionStatus) && run.executionStatus !== "failed" && !isDone(run.executionStatus)) },
      ];
  return (
    <div className="board">
      {columns.map((column) => (
        <section className="board-col" key={column.key}>
          <header><span>{column.head}</span><span className="count">{column.rows.length}</span></header>
          <div className="board-cards">
            {column.rows.slice(0, 60).map((run) => (
              <button type="button" key={run.key} className={`board-card tone-${tone(run.executionStatus)}`} onClick={() => openRun(run)}>
                <span className="bc-title">{run.title || run.workRunId}</span>
                <span className="bc-project">{run.projectName}</span>
                <span className="bc-meta">
                  <Badge value={run.executionStatus} />
                  <TimeText value={run.startedAt ?? run.createdAt} compact />
                  <Elapsed start={run.startMs} end={run.endMs} active={isActive(run.executionStatus)} />
                </span>
                {(run.diffStat || run.codexUsage) && <span className="bc-meta"><DiffStatText stat={run.diffStat} /><TokenValue usage={run} compact /></span>}
              </button>
            ))}
            {column.rows.length > 60 && <p className="fine">另有 {column.rows.length - 60} 项，请切换到列表视图查看。</p>}
            {!column.rows.length && <p className="fine board-empty">暂无任务</p>}
          </div>
        </section>
      ))}
    </div>
  );
}

function TimelineView({ rows }: { rows: RunRow[] }) {
  const data = useData();
  const route = useRoute();
  const now = Math.max(useSlowNow(), Date.now());
  const days = rangeDays(route.get("range")) ?? 1;
  const span = days * 86_400_000;
  const start = now - span;
  const endOf = (run: RunRow) => run.endMs ?? (isActive(run.executionStatus) ? now : (run.startMs ?? now) + 60_000);
  const visible = rows.filter((run) => run.startMs !== null && run.startMs <= now && endOf(run) >= start);
  const hidden = rows.length - visible.length;
  const ticks = Array.from({ length: 7 }, (_, index) => start + (span * index) / 6);
  const pct = (t: number) => ((Math.min(Math.max(t, start), now) - start) / span) * 100;
  const tickLabel = (t: number) => fmtTime(t, false).slice(days <= 1 ? 11 : 5);

  const lanes = data.nodes.map((node) => {
    const tracks: RunRow[][] = [];
    const ends: number[] = [];
    const nodeRuns = visible.filter((run) => run.nodeId === node.id).sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    for (const run of nodeRuns) {
      const s = Math.max(run.startMs ?? start, start);
      let index = ends.findIndex((end) => end <= s);
      if (index === -1) {
        index = tracks.length;
        tracks.push([]);
        ends.push(0);
      }
      tracks[index].push(run);
      ends[index] = endOf(run) + span * 0.006;
    }
    return { node, tracks, count: nodeRuns.length };
  });

  return (
    <div className="panel timeline">
      <div className="tl-row tl-axis">
        <div className="tl-lane-head muted">机器</div>
        <div className="tl-track">{ticks.map((t, index) => <span key={index} className="tl-tick" style={{ left: `${(index / 6) * 100}%` }}>{tickLabel(t)}</span>)}</div>
      </div>
      {lanes.map(({ node, tracks, count }) => (
        <div className="tl-row" key={node.id}>
          <div className="tl-lane-head"><NodeTag id={node.id} name={node.name} online={node.online} /><small className="muted">{count} 项</small></div>
          <div className="tl-track">
            <div className="tl-grid" aria-hidden="true">{ticks.map((_, index) => <i key={index} style={{ left: `${(index / 6) * 100}%` }} />)}</div>
            {tracks.length ? tracks.map((track, index) => (
              <div className="tl-sub" key={index}>
                {track.map((run) => {
                  const s = run.startMs ?? start;
                  const e = endOf(run);
                  const active = isActive(run.executionStatus);
                  return (
                    <button type="button" key={run.key} className={`tl-bar tone-${tone(run.executionStatus)} ${active ? "live" : ""}`}
                      style={{ left: `${pct(s)}%`, width: `${Math.min(100 - pct(s), Math.max(0.6, pct(e) - pct(s)))}%` }}
                      title={`${run.title || run.workRunId}\n${fmtTime(s)} → ${run.endMs ? fmtTime(run.endMs) : active ? "进行中" : "结束时间未记录"}\n${duration(e - s)} · ${label(run.executionStatus)}`}
                      onClick={() => openRun(run)}>
                      <span>{run.title || run.workRunId}</span>
                    </button>
                  );
                })}
              </div>
            )) : <div className="tl-sub tl-empty">该时段无任务</div>}
            <i className="tl-now" aria-hidden="true" />
          </div>
        </div>
      ))}
      <p className="fine tl-note">
        时间窗口：{days <= 1 ? "近 24 小时" : `近 ${days} 天`}（跟随"开始时间"筛选）{hidden ? ` · ${hidden} 项在窗口之外` : ""} · 色块宽度为实际耗时，运行中的任务一直延伸到当前时刻。
      </p>
    </div>
  );
}
