import { useEffect, useState } from "react";
import { label, sourceLabels } from "../format.js";
import { navigate, useRoute } from "../router.js";

/** 任务筛选：状态 / 来源 / 时间范围 / 关键字，全部写进网址。 */
export function RunFilters({ search = true, extra }: { search?: boolean; extra?: React.ReactNode }) {
  const route = useRoute();
  const q = route.get("q");
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const timer = setTimeout(() => { if (text !== q) navigate({ q: text }, { replace: true }); }, 300);
    return () => clearTimeout(timer);
  }, [text, q]);
  return (
    <div className="filters">
      {search && <input type="search" className="filter-search" placeholder="搜索标题或 ID" value={text} onChange={(event) => setText(event.target.value)} aria-label="搜索任务" />}
      <select aria-label="执行状态" value={route.get("status")} onChange={(event) => navigate({ status: event.target.value })}>
        <option value="">全部状态</option>
        {["running", "interrupted", "completed", "failed", "cancelled", "reconciliation_required"].map((value) => <option key={value} value={value}>{label(value)}</option>)}
      </select>
      <select aria-label="来源" value={route.get("source")} onChange={(event) => navigate({ source: event.target.value })}>
        <option value="">全部来源</option>
        {Object.entries(sourceLabels).map(([value, text2]) => <option key={value} value={value}>{text2}</option>)}
      </select>
      <select aria-label="开始时间" value={route.get("range") || "all"} onChange={(event) => navigate({ range: event.target.value === "all" ? null : event.target.value })}>
        <option value="all">全部时间</option>
        <option value="1">近 24 小时</option>
        <option value="7">近 7 天</option>
        <option value="30">近 30 天</option>
      </select>
      {extra}
    </div>
  );
}

export function matchRun(title: string, id: string, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return title.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
}
