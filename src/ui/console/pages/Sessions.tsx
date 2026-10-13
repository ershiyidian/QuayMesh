import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText, isAuthError } from "../api.js";
import { label, LOCAL, reasons, sourceLabels } from "../format.js";
import { execParam, navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { Badge, Dialog, Empty, NodeTag, Notice, Segmented, Tabs, TimeText, useAct, useDialogs, useToast } from "../ui.js";
import type { AttentionData, Batch, BatchSummary, Thread } from "../types.js";

type ControlAction = "steer" | "interrupt" | "takeover" | "returnControl";

/** 实时控制：转向 / 中断 / 接管 / 归还。会话页与任务抽屉共用。 */
export function ThreadControls({ thread, nodeId, projectId, onChanged }: { thread: Thread; nodeId: string; projectId: string; onChanged: () => void }) {
  const dialogs = useDialogs();
  const toast = useToast();
  const { busy, act } = useAct();
  const state = thread.control?.state ?? "terminal";

  const send = async (action: ControlAction) => {
    const run = (thread.runs ?? []).find((entry) => entry.status === "running") ?? thread.runs?.[0];
    if (!run) {
      toast("该会话没有可验证的工作运行，不能发送控制请求。", "bad");
      return;
    }
    let prompt: string | undefined;
    if (action === "steer") {
      const value = await dialogs.prompt({ title: "转向当前轮次", message: "输入要追加到当前轮次的新方向。内容会原样发送给当前 Codex turn。", multiline: true, placeholder: "例如：先修复失败的单元测试，再继续重构。", confirmText: "发送" });
      if (!value) return;
      prompt = value;
    }
    if (action === "interrupt" && !(await dialogs.confirm({ title: "中断当前轮次？", message: "只中断正在进行的 Codex turn，不删除会话、任务或用量记录。", confirmText: "中断", danger: true }))) return;
    if (action === "takeover" && !(await dialogs.confirm({ title: "接管到 Codex Desktop？", message: "接管会先中断当前轮次；只有收到 interrupted 终态后才把写入权交给 Desktop。完成后将打开 Desktop 会话。", confirmText: "接管" }))) return;
    const requestKey = `console-${action}-${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    await act(async () => {
      const result = await api<{ note?: string; desktopThreadUrl?: string }>(
        `projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(thread.id)}/control`,
        { action, workRunId: run.id, requestKey, ...(thread.control?.providerTurnId ? { expectedTurnId: thread.control.providerTurnId } : {}), ...(prompt ? { prompt } : {}) },
        nodeId,
      );
      if (result.note) toast(result.note, "info");
      onChanged();
      if (action === "takeover" && result.desktopThreadUrl) location.href = result.desktopThreadUrl;
    });
  };

  const events = thread.control?.events ?? [];
  return (
    <div className="control-cell">
      <div className="button-row">
        <Badge value={state} />
        {thread.desktopThreadUrl && <a className="btn sm" href={thread.desktopThreadUrl}>在 Desktop 打开</a>}
        {state === "qm_active" && <>
          <button type="button" className="sm" disabled={busy} onClick={() => void send("steer")}>转向</button>
          <button type="button" className="sm" disabled={busy} onClick={() => void send("interrupt")}>中断</button>
          <button type="button" className="sm primary" disabled={busy} onClick={() => void send("takeover")}>接管</button>
        </>}
        {state === "desktop_owned" && <button type="button" className="sm" disabled={busy} onClick={() => void send("returnControl")}>归还 QuayMesh</button>}
      </div>
      {events.length > 0 && (
        <ol className="control-events">
          {events.slice(-3).map((event) => <li key={event.sequence}><TimeText value={event.createdAt} compact /> · {label(event.state)}</li>)}
        </ol>
      )}
    </div>
  );
}

export function SessionsPage() {
  const data = useData();
  const project = data.scopeProject ? data.scopedProjects[0] : undefined;
  if (!project) return <ProjectPicker />;
  return <ProjectSessions key={`${project.nodeId}/${project.id}`} nodeId={project.nodeId} projectId={project.id} projectName={project.name} />;
}

function ProjectPicker() {
  const data = useData();
  const projects = data.allProjects.filter((project) => !data.scopeNode || project.nodeId === data.scopeNode);
  return (
    <div className="stack">
      <Notice tone="info">Codex 会话按项目管理。选择一个项目后，可以查看会话归属、实时控制、归档与恢复批次，以及执行占用。</Notice>
      {!projects.length ? <div className="panel"><Empty title="还没有可见项目">通过 QuayMesh 打开工作区并开始任务后，这里会出现项目。</Empty></div> : (
        <div className="project-grid">
          {projects.map((project) => (
            <button type="button" key={`${project.nodeId}/${project.id}`} className="project-card"
              onClick={() => navigate({ project: project.id, node: data.mode === "fleet" ? project.nodeId : null })}>
              <span className="project-initial">{project.name.slice(0, 1).toUpperCase()}</span>
              <span className="project-body">
                <strong>{project.name}</strong>
                <small title={project.root}>{project.root}</small>
                <span className="project-meta">
                  {data.mode === "fleet" && <NodeTag id={project.nodeId} name={project.nodeName} />}
                  <span>{project.taskCount} 项任务</span>
                  {project.activeTasks > 0 && <span className="info">{project.activeTasks} 项进行中</span>}
                  {project.needsAttention > 0 && <span className="bad">{project.needsAttention} 项需关注</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type SubTab = "threads" | "batches" | "claims";
type ThreadFilter = "all" | "active" | "archived" | "protected" | "external";

function ProjectSessions({ nodeId, projectId, projectName }: { nodeId: string; projectId: string; projectName: string }) {
  const data = useData();
  const route = useRoute();
  const raw = route.get("tab");
  const tab: SubTab = raw === "batches" || raw === "claims" ? raw : "threads";
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [attention, setAttention] = useState<AttentionData>({ claims: [], waiters: [] });
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [acceptPartial, setAcceptPartial] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [filter, setFilter] = useState<ThreadFilter>("all");
  const { busy, act } = useAct();
  const root = `projects/${encodeURIComponent(projectId)}`;

  const load = useCallback(async () => {
    try {
      const [sessions, batches, claims] = await Promise.all([
        api<{ threads?: Thread[] }>(`${root}/threads`, undefined, nodeId),
        api<{ batches?: BatchSummary[] }>(`${root}/archive`, undefined, nodeId).catch(() => ({ batches: [] as BatchSummary[] })),
        api<Partial<AttentionData>>(`${root}/attention`, undefined, nodeId).catch(() => ({ claims: [], waiters: [] })),
      ]);
      setThreads(sessions.threads ?? []);
      setHistory(batches.batches ?? []);
      setAttention({ claims: claims.claims ?? [], waiters: claims.waiters ?? [] });
      setError("");
    } catch (cause) {
      if (!isAuthError(cause)) setError(errorText(cause, "读取会话失败"));
    }
  }, [root, nodeId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden && !batch && !busy) void load(); }, 10_000);
    return () => clearInterval(timer);
  }, [load, batch, busy]);
  useEffect(() => {
    if (!threads) return;
    const ids = new Set(threads.map((thread) => thread.id));
    setSelection((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [threads]);

  const visible = useMemo(() => (threads ?? []).filter((thread) => {
    if (filter === "active") return thread.archiveState !== "archived";
    if (filter === "archived") return thread.archiveState === "archived";
    if (filter === "protected") return thread.protected;
    if (filter === "external") return thread.externalActivity;
    return true;
  }), [threads, filter]);

  const allSelected = visible.length > 0 && visible.every((thread) => selection.has(thread.id));
  const toggleAll = () => setSelection((current) => {
    const next = new Set(current);
    if (allSelected) visible.forEach((thread) => next.delete(thread.id));
    else visible.forEach((thread) => next.add(thread.id));
    return next;
  });
  const preview = (mode: "archive" | "restore") => act(async () => {
    setBatch(await api<Batch>(`${root}/archive/preview`, { mode, acceptPartial, ...(selection.size ? { threadKeys: [...selection] } : {}) }, nodeId));
  });
  const openBatch = (id: string) => act(async () => setBatch(await api<Batch>(`${root}/archive/${encodeURIComponent(id)}`, undefined, nodeId)));
  const protect = (thread: Thread) => act(async () => {
    await api(`${root}/threads/${encodeURIComponent(thread.id)}/protect`, { protected: !thread.protected }, nodeId);
    await load();
  }, thread.protected ? "已取消保留" : "已设为保留，归档时会跳过");

  const claimCount = attention.claims.length + attention.waiters.length;
  return (
    <div className="stack">
      <div className="panel sess-head">
        <div>
          <p className="eyebrow">当前项目</p>
          <h2>{projectName}</h2>
          <div className="button-row">{data.mode === "fleet" && <NodeTag id={nodeId} name={data.nodeName(nodeId)} />}<span className="muted">{threads?.length ?? "—"} 个受管会话 · 来源登记，不靠标题猜测</span></div>
        </div>
        <button type="button" className="ghost" onClick={() => navigate({ project: null, tab: null })}>切换项目</button>
      </div>

      {error && <Notice tone="bad" action={<button type="button" className="sm" onClick={() => void load()}>重试</button>}>{error}</Notice>}

      <Tabs<SubTab> value={tab} onChange={(value) => navigate({ tab: value === "threads" ? null : value }, { replace: true })}
        tabs={[["threads", "受管会话", threads?.length ?? 0], ["batches", "归档与恢复批次", history.length], ["claims", "执行占用", claimCount]]} />

      {tab === "threads" && <>
        <Notice tone="info">
          <b>只整理能证明归属的会话。</b>Codex 归档会隐藏原聊天，不删除任务或 Token 历史，也不会取消进程。存在外部续写或未验收任务时默认跳过。
        </Notice>
        <div className="toolbar">
          <Segmented<ThreadFilter> ariaLabel="会话筛选" value={filter} onChange={setFilter}
            options={[["all", "全部"], ["active", "未归档"], ["archived", "已归档"], ["protected", "已保留"], ["external", "外部续写"]]} />
          <div className="button-row">
            <label className="check"><input type="checkbox" checked={acceptPartial} onChange={(event) => setAcceptPartial(event.target.checked)} />预览时允许保留不完整用量回执</label>
            <button type="button" onClick={() => void preview("restore")} disabled={busy}>{selection.size ? `预览恢复 ${selection.size} 个` : "恢复已归档会话"}</button>
            <button type="button" className="primary" onClick={() => void preview("archive")} disabled={busy}>{selection.size ? `预览归档 ${selection.size} 个` : "预览项目归档"}</button>
          </div>
        </div>
        <div className="panel flush">
          {threads === null ? <div className="loading"><span className="spinner" />正在读取会话…</div> : !visible.length ? (
            <Empty title={threads.length ? "没有符合条件的会话" : "没有受管 Codex 会话"}>主控直接读取不创建 Codex 聊天。</Empty>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th className="cell-check"><input type="checkbox" aria-label="选择全部可见会话" checked={allSelected} onChange={toggleAll} /></th>
                    <th>会话 / 归属</th><th>实时控制</th><th>来源可信度</th><th>归档</th><th>关联任务</th><th>更新</th><th>保留</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((thread) => (
                    <tr key={thread.id} className={selection.has(thread.id) ? "row-selected" : ""}>
                      <td className="cell-check">
                        <input type="checkbox" aria-label={`选择 ${thread.title}`} checked={selection.has(thread.id)}
                          onChange={(event) => setSelection((current) => { const next = new Set(current); if (event.target.checked) next.add(thread.id); else next.delete(thread.id); return next; })} />
                      </td>
                      <td className="cell-title">
                        <strong className="thread-title">{thread.title}</strong>
                        <div className="sub"><span>{sourceLabels[thread.origin?.entryPoint ?? ""] ?? "来源待确认"}</span><span>· {thread.runs?.length ?? 0} 个工作执行</span></div>
                        <code>{thread.agentId}</code>
                      </td>
                      <td><ThreadControls thread={thread} nodeId={nodeId} projectId={projectId} onChanged={() => void load()} /></td>
                      <td>
                        {thread.externalActivity
                          ? <Badge tone="bad">外部续写</Badge>
                          : thread.createdHere && thread.identityVerified ? <Badge tone="ok">已登记创建</Badge> : <Badge tone="warn">关联待核实</Badge>}
                      </td>
                      <td><Badge value={thread.archiveState} /></td>
                      <td>
                        <div className="run-chips">
                          {(thread.runs ?? []).slice(0, 3).map((entry) => (
                            <button type="button" key={entry.id} className="chip" onClick={() => navigate({ exec: execParam(nodeId === LOCAL ? "" : nodeId, projectId, entry.id), dtab: null })} title={`${label(entry.status)} · ${label(entry.acceptance)}`}>
                              <i className={`dot tone-${entry.status === "running" ? "info" : entry.status === "failed" ? "bad" : "ok"}`} />{entry.id.slice(-8)}
                            </button>
                          ))}
                          {(thread.runs?.length ?? 0) > 3 && <span className="muted">+{(thread.runs?.length ?? 0) - 3}</span>}
                        </div>
                      </td>
                      <td><TimeText value={thread.updatedAt} compact rel /></td>
                      <td><button type="button" className={`sm protect ${thread.protected ? "on" : ""}`} onClick={() => void protect(thread)} disabled={busy}>{thread.protected ? "已保留" : "设为保留"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>}

      {tab === "batches" && (
        <div className="panel">
          {!history.length ? <Empty title="尚无批次">预览和确认会留存独立记录，这里可以随时查看回执。</Empty> : (
            <ul className="row-list">
              {history.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="row-button" onClick={() => void openBatch(entry.id)} disabled={busy}>
                    <span><strong>{entry.mode === "archive" ? "归档" : "恢复"}</strong> · <TimeText value={entry.created_at} /></span>
                    <Badge value={entry.status} />
                    <span className="muted">查看回执 →</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "claims" && (
        <div className="panel">
          <p className="fine">进程存在、模型线程空闲、任务完成是三种不同状态。中断遗留的占用需要核对，不能靠归档聊天来"清理"。这里只展示证据，不会自动结束进程。</p>
          {!claimCount ? <Empty title="当前没有登记的占用或等待">这不等于已扫描并确认所有外部 Codex 客户端都已停止。</Empty> : (
            <ul className="claim-list">
              {[...attention.claims.map((entry) => ({ ...entry, group: "占用" })), ...attention.waiters.map((entry) => ({ ...entry, group: "等待" }))].map((entry) => (
                <li key={`${entry.group}-${entry.id}`}>
                  <Badge tone={entry.group === "占用" ? "info" : "warn"}>{entry.group}</Badge>
                  <strong>{entry.kind ?? "queued"}</strong>
                  <code>{entry.agent_id ?? entry.id}</code>
                  <span className="muted">{entry.access_mode ?? "—"} · {entry.owner_pid ? `PID ${entry.owner_pid}` : "尚未调用模型"}</span>
                  {entry.created_at && <TimeText value={entry.created_at} compact rel />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {batch && <BatchDialog batch={batch} nodeId={nodeId} projectId={projectId} onUpdate={setBatch} onClose={() => setBatch(null)} onDone={() => { setSelection(new Set()); void load(); }} />}
    </div>
  );
}

function BatchDialog({ batch, nodeId, projectId, onUpdate, onClose, onDone }: {
  batch: Batch; nodeId: string; projectId: string; onUpdate: (batch: Batch) => void; onClose: () => void; onDone: () => void;
}) {
  const [externalIdle, setExternalIdle] = useState(false);
  const toast = useToast();
  const { busy, act } = useAct();
  const reconcile = batch.status === "reconciliation_required";
  const counts = batch.entries.reduce<Record<string, number>>((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {});
  const finished = ["succeeded", "partial", "failed", "expired"].includes(batch.status);

  const execute = () => act(async () => {
    let result = batch;
    do {
      const before = JSON.stringify([result.status, result.readyCount, result.succeededCount, result.entries]);
      result = await api<Batch>(`projects/${encodeURIComponent(projectId)}/archive/${encodeURIComponent(result.batchId)}/execute`, { confirmationHash: result.confirmationHash, externalIdle: true }, nodeId);
      onUpdate(result);
      if (result.status === "executing" && before === JSON.stringify([result.status, result.readyCount, result.succeededCount, result.entries])) {
        toast("批次仍在处理中，请稍后重新查看回执。", "info");
        break;
      }
    } while (result.status === "executing" && result.readyCount > 0);
    toast(result.status === "reconciliation_required" ? "部分结果需要核对，未盲目重试。批次记录已保存。" : "批次执行结果已保存，任务和用量历史保持不变。", result.status === "reconciliation_required" ? "info" : "ok");
    onDone();
  });

  return (
    <Dialog title={batch.mode === "archive" ? "确认项目会话归档" : "确认恢复 Codex 会话"} onClose={onClose} locked={busy} size="md" footer={<>
      <button type="button" onClick={onClose} disabled={busy}>{finished ? "关闭" : "取消"}</button>
      {!finished && (
        <button type="button" className="primary" disabled={busy || !externalIdle || (!batch.readyCount && !reconcile)} onClick={() => void execute()}>
          {busy ? "正在逐项核对与执行…" : reconcile ? "核对上次执行结果（不盲目重放）" : `确认${batch.mode === "archive" ? "归档" : "恢复"} ${batch.readyCount} 个`}
        </button>
      )}
    </>}>
      <div className="batch-summary">
        <div><strong>{batch.readyCount}</strong><span>可执行</span></div>
        <div><strong className="ok">{batch.succeededCount}</strong><span>已成功</span></div>
        <div><strong>{counts.skipped ?? 0}</strong><span>已跳过</span></div>
        <div><Badge value={batch.status} /><span>批次状态</span></div>
      </div>
      <p className="fine">范围已冻结，确认后新创建的会话不会被加入。本操作不删除聊天、任务或用量历史。预览有效期至 <TimeText value={batch.expiresAt} />。</p>
      <div className="batch-entries">
        {batch.entries.length ? batch.entries.map((entry) => (
          <div className="batch-entry" key={entry.managedThreadId}>
            <strong>{entry.title}</strong>
            <Badge value={entry.status} />
            {entry.reason && <p>{reasons[entry.reason] ?? entry.reason}</p>}
          </div>
        )) : <Empty title="没有可选会话" />}
      </div>
      {!finished && (
        <label className="check external-confirm">
          <input type="checkbox" checked={externalIdle} onChange={(event) => setExternalIdle(event.target.checked)} disabled={busy} />
          我已暂停此项目在其他 Codex 客户端中的操作，确认只处理上述清单。
        </label>
      )}
      <p className="fine">QuayMesh 无法锁住独立的外部客户端；状态不明、外部续写或后代关系无法核实时仍会跳过。归档不代表后台任务已停止。</p>
    </Dialog>
  );
}
