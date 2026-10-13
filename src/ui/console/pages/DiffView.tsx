import { lazy, Suspense, useMemo } from "react";
import type { HostContext, ReviewPayloadData } from "../../card-types.js";
import { num } from "../format.js";
import { useTheme } from "../theme.js";
import { Badge, copyText, Empty, Notice, TimeText, useToast } from "../ui.js";
import type { ChangeSet, Detail } from "../types.js";

// Diff 查看器按需加载，不拖慢首屏。组件与对话内卡片共用同一实现。
const ReviewPayload = lazy(() => import("../../review-payload.js").then((module) => ({ default: module.ReviewPayload })));

const CAPTURED: Record<string, string> = { events: "事件记录", git: "Git 文件对比", snapshot: "文件快照对比", tool: "编辑工具回执" };
const KIND: Record<string, [string, string, string]> = {
  new: ["A", "added", "新增"], change: ["M", "edited", "修改"], deleted: ["D", "deleted", "删除"],
  "rename-pure": ["R", "renamed", "重命名"], "rename-changed": ["R", "renamed", "重命名并修改"],
};

export function DiffView({ changes, name }: { changes: ChangeSet; name: string }) {
  const { theme } = useTheme();
  const toast = useToast();
  const patch = changes.patch ?? "";
  const list = changes.files ?? [];
  const totals = list.reduce((acc, file) => ({ add: acc.add + (file.additions ?? 0), del: acc.del + (file.removals ?? 0) }), { add: 0, del: 0 });
  const data = useMemo<ReviewPayloadData>(() => ({
    files: list,
    ...(patch ? { patch } : {}),
    summary: { files: list.length, additions: totals.add, removals: totals.del },
  }), [list, patch, totals.add, totals.del]);
  const hostContext = useMemo(() => ({ theme }) as unknown as HostContext, [theme]);

  const download = () => {
    const blob = new Blob([patch], { type: "text/x-diff" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.replace(/[^\w.-]+/g, "_").slice(0, 80) || "changes"}.patch`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (!patch && !list.length) return <Empty title="这次执行没有记录到改动">可能确实没有修改文件，也可能后端尚未采集这类执行的改动。</Empty>;

  return (
    <div className="diffview">
      <div className="diff-meta">
        {list.length > 0 && <span className="diffstat"><span className="add">+{num(totals.add)}</span><span className="del">−{num(totals.del)}</span><small>{list.length} 个文件</small></span>}
        {changes.baseCommit && <span className="muted">基线 <code title={changes.baseCommit}>{changes.baseCommit.slice(0, 12)}</code></span>}
        {changes.capturedBy && <span className="muted">采集：{CAPTURED[changes.capturedBy] ?? changes.capturedBy}</span>}
        <span className="spacer" />
        {patch && <>
          <button type="button" className="sm" onClick={async () => { const copied = await copyText(patch); toast(copied ? "patch 已复制" : "复制失败，请改用下载", copied ? "ok" : "bad"); }}>复制 patch</button>
          <button type="button" className="sm" onClick={download}>下载 .patch</button>
        </>}
      </div>
      {changes.baseDirty && <Notice tone="warn">开始时工作区已有未提交改动。这些改动不属于本次任务；请以基线快照为准核对 diff。</Notice>}
      {changes.truncated && <Notice tone="warn">patch 超过存储上限，已截断。完整改动请在所属机器的工作区内查看。</Notice>}
      {changes.coverage === "partial" && <Notice tone="warn">这项改动只覆盖部分记录，不能当作完整累计差异。</Notice>}
      {changes.coverage === "unavailable" && <Notice tone="warn">这项旧记录缺少可重建的基线，只显示实际留下的内容。</Notice>}
      {patch ? (
        <div className="diff-host">
          <Suspense fallback={<p className="muted pad">正在加载 diff 查看器…</p>}>
            <ReviewPayload data={data} hostContext={hostContext} />
          </Suspense>
        </div>
      ) : (
        <>
          <p className="fine">后端只提供了文件清单，没有提供 patch 内容。</p>
          <ul className="file-list">
            {list.map((file, index) => {
              const [symbol, cls, text] = KIND[file.type ?? ""] ?? ["•", "unknown", "改动"];
              return (
                <li key={`${file.path ?? index}`}>
                  <span className={`review-file-kind ${cls}`} title={text}>{symbol}</span>
                  <code>{file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ${file.path}` : file.path}</code>
                  <span className="diffstat"><span className="add">+{num(file.additions ?? 0)}</span><span className="del">−{num(file.removals ?? 0)}</span></span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {changes.capturedBy !== "tool" && changes.baseDirty === undefined && changes.baseCommit === undefined && <p className="fine"><Badge tone="muted">提示</Badge> 基线信息未上报，无法判断开始前工作区是否干净。</p>}
    </div>
  );
}

export function RunChanges({ detail, name }: { detail: Detail; name: string }) {
  if (detail.changeSets?.length) return (
    <div className="stack">
      <p className="fine">按编辑发生的顺序展示每次工具记录的独立 patch，不把它们相加成累计净差异。</p>
      {detail.changeSets.map((changes, index) => (
        <section key={changes.operationId} className="stack">
          <div className="button-row"><strong>第 {index + 1} 次编辑</strong><TimeText value={changes.time} /></div>
          <DiffView changes={changes} name={`${name}-${index + 1}`} />
        </section>
      ))}
    </div>
  );
  if (detail.changes) return <DiffView changes={detail.changes} name={name} />;
  return <Empty title="这次任务未保存改动内容">新版本会记录后续通过编辑工具完成的修改。历史任务和其他编辑方式的内容，以所属工作区为准。</Empty>;
}
