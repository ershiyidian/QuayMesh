import { useMemo } from "react";
import { compactNum, fmtTime, num, qualities, qualityHelp } from "../format.js";
import { navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { Empty, NodeTag, Notice, Segmented, TokenValue } from "../ui.js";
import { mergeUsage as merge } from "../usage.js";
import type { Usage } from "../types.js";

type Group = "project" | "node" | "day";

export function UsagePage() {
  const data = useData();
  const route = useRoute();
  const raw = route.get("group");
  const group: Group = raw === "node" || raw === "day" ? raw : "project";
  const total = useMemo(() => merge(data.scopedProjects), [data.scopedProjects]);

  const rows = useMemo(() => {
    if (group === "project") return data.scopedProjects.map((project) => ({ key: `${project.nodeId}/${project.id}`, title: project.name, nodeId: project.nodeId, usage: project as Usage }));
    if (group === "node") return data.nodes.filter((node) => !data.scopeNode || node.id === data.scopeNode).map((node) => ({ key: node.id, title: node.name, nodeId: node.id, usage: merge(data.scopedProjects.filter((project) => project.nodeId === node.id)) }));
    const map = new Map<string, Usage[]>();
    for (const run of data.runs) {
      const key = run.startMs ? fmtTime(run.startMs).slice(0, 10) : "时间未知";
      map.set(key, [...(map.get(key) ?? []), run]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, list]) => ({ key: day, title: day, nodeId: "", usage: merge(list) }));
  }, [group, data.scopedProjects, data.nodes, data.runs]);
  const max = Math.max(1, ...rows.map((row) => row.usage.codexUsage?.totalTokens ?? 0));
  const u = total.codexUsage;

  return (
    <div className="stack">
      <section className="panel usage-top">
        <div><p className="eyebrow">当前范围已记录的 Codex 消耗</p><TokenValue usage={total} /><p className="fine">{qualityHelp[total.usageStatus]} 按任务开始时间统计，不等于订阅账单。</p></div>
        <dl className="breakdown">
          <div><dt>输入</dt><dd>{num(u?.inputTokens)}</dd></div>
          <div><dt>其中缓存读取</dt><dd>{num(u?.cachedInputTokens)}</dd></div>
          <div><dt>输出</dt><dd>{num(u?.outputTokens)}</dd></div>
          <div><dt>其中推理</dt><dd>{num(u?.reasoningOutputTokens)}</dd></div>
          <div><dt>缺少完整用量的执行</dt><dd className={total.missingExecutions ? "warn" : ""}>{num(total.missingExecutions)}</dd></div>
        </dl>
      </section>
      <Notice tone="info">
        {Object.entries(qualities).map(([key, text]) => <span key={key} className="quality-legend"><b className={`quality q-${key}`}>{text}</b>{qualityHelp[key]}</span>)}
      </Notice>
      <div className="toolbar">
        <Segmented<Group> ariaLabel="分组" value={group} onChange={(value) => navigate({ group: value === "project" ? null : value }, { replace: true })}
          options={[["project", "按项目"], ["node", "按机器"], ["day", "按日期"]]} />
        {group === "day" && <span className="fine">按日期只统计已加载的任务{data.hasMore ? "，还有更早的任务未加载" : ""}。</span>}
      </div>
      <div className="panel flush">
        {!rows.length ? <Empty title="暂无用量数据" /> : (
          <ul className="usage-bars">
            {rows.map((row) => {
              const value = row.usage.codexUsage?.totalTokens;
              return (
                <li key={row.key}>
                  <span className="ub-title">{row.nodeId && data.nodes.length > 1 && group === "project" && <NodeTag id={row.nodeId} name={data.nodeName(row.nodeId)} />}{row.title}</span>
                  <span className="ub-bar"><i style={{ width: `${((value ?? 0) / max) * 100}%` }} /></span>
                  <span className="ub-value" title={num(value)}>{compactNum(value)}</span>
                  <span className={`quality q-${row.usage.usageStatus}`}>{qualities[row.usage.usageStatus]}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {data.hasMore && group === "day" && <button type="button" className="load-more" onClick={() => void data.loadMore()}>加载更早的任务</button>}
      <p className="fine">费用估算与配额剩余需要后端提供价格表与账号配额后显示。</p>
    </div>
  );
}
