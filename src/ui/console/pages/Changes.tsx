import { useEffect, useMemo, useState } from "react";
import { api, errorText, isAuthError } from "../api.js";
import { fmtTime, isActive, num } from "../format.js";
import { useRoute } from "../router.js";
import { useData } from "../store.js";
import { Badge, DiffStatText, Empty, NodeTag, Notice, TimeText } from "../ui.js";
import { RunChanges } from "./DiffView.js";
import { matchRun, RunFilters } from "./common.js";
import { openRun } from "./Tasks.js";
import type { Detail, RunRow } from "../types.js";

export function ChangesPage() {
  const data = useData();
  const route = useRoute();
  const q = route.get("q");
  const reported = data.runs.some((run) => run.diffStat);
  const rows = useMemo(() => data.runs.filter((run) => (run.diffStat?.files ?? 0) > 0 && matchRun(run.title ?? "", run.workRunId, q)), [data.runs, q]);
  const days = useMemo(() => {
    const map = new Map<string, RunRow[]>();
    for (const run of rows) {
      const key = run.startMs ? fmtTime(run.startMs).slice(0, 10) : "时间未知";
      map.set(key, [...(map.get(key) ?? []), run]);
    }
    return [...map.entries()];
  }, [rows]);
  const totals = rows.reduce((acc, run) => ({ files: acc.files + (run.diffStat?.files ?? 0), add: acc.add + (run.diffStat?.additions ?? 0), del: acc.del + (run.diffStat?.deletions ?? 0) }), { files: 0, add: 0, del: 0 });

  if (!reported) {
    const recent = data.runs.filter((run) => !isActive(run.executionStatus)).slice(0, 30);
    return (
      <div className="stack">
        <Notice tone="info">
          <b>后端尚未上报改动统计。</b>任务列表接口返回 <code>diffStat</code>、任务详情返回 <code>changes</code> 之后，这里会按时间汇总所有机器上的改动。在此之前，可以逐个打开任务的"改动"标签查看。
        </Notice>
        <div className="panel flush">
          {!recent.length ? <Empty title="还没有已结束的任务" /> : (
            <ul className="row-list">
              {recent.map((run) => (
                <li key={run.key}>
                  <button type="button" className="row-button" onClick={() => openRun(run, "changes")}>
                    <span className="row-main"><strong>{run.title || run.workRunId}</strong><small className="muted">{data.nodeName(run.nodeId)} · {run.projectName}</small></span>
                    <Badge value={run.executionStatus} />
                    <TimeText value={run.startedAt ?? run.createdAt} compact />
                    <span className="muted">查看改动 →</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <RunFilters />
        <span className="diffstat big"><span className="add">+{num(totals.add)}</span><span className="del">−{num(totals.del)}</span><small>{rows.length} 次执行 · {num(totals.files)} 个文件次</small></span>
      </div>
      {!rows.length ? <div className="panel"><Empty title="当前范围内没有改动">调整范围或时间筛选后再看。</Empty></div> : days.map(([day, list]) => (
        <section key={day} className="day-group">
          <h3 className="day-head">{day === fmtTime(Date.now()).slice(0, 10) ? `今天 · ${day}` : day}<span className="muted">{list.length} 次执行</span></h3>
          <div className="panel flush">{list.map((run) => <ChangeRow key={run.key} run={run} />)}</div>
        </section>
      ))}
      {data.hasMore && <button type="button" className="load-more" onClick={() => void data.loadMore()}>加载更早的任务</button>}
    </div>
  );
}

function ChangeRow({ run }: { run: RunRow }) {
  const data = useData();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || detail) return;
    let cancelled = false;
    api<Detail>(`projects/${encodeURIComponent(run.projectId)}/runs/${encodeURIComponent(run.workRunId)}`, undefined, run.nodeId)
      .then((result) => { if (!cancelled) { setDetail(result); setError(""); } })
      .catch((cause) => { if (!cancelled && !isAuthError(cause)) setError(errorText(cause, "读取改动失败")); });
    return () => { cancelled = true; };
  }, [open, detail, run.nodeId, run.projectId, run.workRunId]);
  return (
    <div className={`change-row ${open ? "open" : ""}`}>
      <button type="button" className="change-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="row-main"><strong>{run.title || run.workRunId}</strong><small className="muted">{run.projectName} · {run.workRunId}</small></span>
        {data.nodes.length > 1 && <NodeTag id={run.nodeId} name={data.nodeName(run.nodeId)} />}
        <Badge value={run.executionStatus} />
        <DiffStatText stat={run.diffStat} />
        <TimeText value={run.startedAt ?? run.createdAt} compact />
      </button>
      {open && (
        <div className="change-body">
          {error ? <Notice tone="bad">{error}</Notice>
            : !detail ? <div className="loading"><span className="spinner" />正在读取改动…</div>
            : <RunChanges detail={detail} name={run.title || run.workRunId} />}
          <button type="button" className="sm ghost" onClick={() => openRun(run, "changes")}>在任务详情中打开 →</button>
        </div>
      )}
    </div>
  );
}
