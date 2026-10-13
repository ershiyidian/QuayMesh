import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { isActive, LOCAL } from "../format.js";
import { navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { Badge, CopyButton, Dialog, Empty, Link, NodeTag, Notice, useAct, useDialogs } from "../ui.js";
import type { FleetNode, NodeSettings, RootEntry, Project } from "../types.js";

import { pathContains as under } from "../validation.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

interface RootRow extends RootEntry { node: FleetNode }

export function WorkspacesPage() {
  const data = useData();
  const route = useRoute();
  const q = route.get("q").toLowerCase();
  const [edit, setEdit] = useState<{ root?: RootRow } | null>(null);
  const [text, setText] = useState(route.get("q"));
  useEffect(() => setText(route.get("q")), [q]);
  useEffect(() => {
    const timer = setTimeout(() => { if (text !== route.get("q")) navigate({ q: text }, { replace: true }); }, 300);
    return () => clearTimeout(timer);
  }, [text, q]);

  const roots = useMemo<RootRow[]>(() => (data.fleet?.nodes ?? []).flatMap((node) => node.roots.map((root) => ({ ...root, node })))
    .filter((root) => (!data.scopeNode || root.node.id === data.scopeNode)
      && [root.nickname, root.id, root.path, root.description, ...root.tags, root.node.nickname, root.node.id].join(" ").toLowerCase().includes(q)), [data.fleet, data.scopeNode, q]);
  const projects = data.allProjects.filter((project) => (!data.scopeNode || project.nodeId === data.scopeNode) && (!q || `${project.name} ${project.root}`.toLowerCase().includes(q)));

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="filters"><input type="search" className="filter-search" placeholder="搜索昵称、ID、标签、路径或机器" value={text} onChange={(event) => setText(event.target.value)} aria-label="搜索工作空间" /></div>
        {data.mode === "fleet" && <button type="button" className="primary" onClick={() => setEdit({})}>添加根目录</button>}
      </div>

      {data.mode === "fleet" ? (
        <section className="panel flush">
          <div className="panel-head pad"><h2>根目录</h2><span className="muted">GPT 按昵称和用途选择。新增或停用后，GPT 需在下一次调用工作区工具（或重新连接 MCP）时才能看到变化。</span></div>
          {!roots.length ? <Empty title="暂无匹配的根目录">添加根目录后，GPT 可以按昵称和用途选择工作空间。</Empty> : (
            <div className="table-scroll">
              <table className="table">
                <thead><tr><th>工作空间</th><th>机器</th><th>路径 / 引用</th><th>项目</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>
                  {roots.map((root) => {
                    const inside = data.allProjects.filter((project) => project.nodeId === root.node.id && under(project.root, root.path));
                    const running = data.runs.filter((run) => run.nodeId === root.node.id && isActive(run.executionStatus) && inside.some((project) => project.id === run.projectId)).length;
                    return (
                      <tr key={`${root.node.id}/${root.id}`}>
                        <td className="cell-title"><strong>{root.nickname}</strong>{root.description && <div className="sub">{root.description}</div>}<div className="chips">{root.tags.map((tag) => <span className="chip" key={tag}>{tag}</span>)}</div></td>
                        <td><NodeTag id={root.node.id} name={root.node.nickname} online={root.node.online} /></td>
                        <td><code>{root.path}</code><div className="sub"><code>{root.node.id}/{root.id}</code></div></td>
                        <td>{inside.length ? inside.map((project) => <Link key={project.id} className="chip" to={{ view: "tasks", node: root.node.id, project: project.id }} reset>{project.name}</Link>) : <span className="muted">—</span>}{running > 0 && <div className="sub info">{running} 项运行中</div>}</td>
                        <td>{!root.enabled ? <Badge tone="muted">已停用</Badge> : root.node.online ? <Badge tone="ok">可用</Badge> : <Badge tone="warn">机器离线</Badge>}</td>
                        <td className="cell-actions"><div className="button-row"><CopyButton text={`${root.node.id}/${root.id}`} label="复制 ID" /><button type="button" className="sm" disabled={!root.node.online} title={root.node.online ? "" : "机器离线，暂不能编辑"} onClick={() => setEdit({ root })}>编辑</button></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : <Notice tone="info">单机模式下，工作区由 QuayMesh 打开时登记为项目。开启多机模式后可在这里维护 GPT 可用的根目录。</Notice>}

      <section className="panel flush">
        <div className="panel-head pad"><h2>项目</h2><span className="muted">{projects.length} 个 · 由 work_task 登记</span></div>
        {!projects.length ? <Empty title="还没有可见项目">通过 QuayMesh 打开工作区并开始任务后，这里会出现项目。</Empty> : (
          <ul className="row-list">
            {projects.map((project) => (
              <li key={`${project.nodeId}/${project.id}`}>
                <button type="button" className="row-button" onClick={() => navigate({ view: "tasks", node: project.nodeId === LOCAL ? null : project.nodeId, project: project.id }, { reset: true })}>
                  <span className="row-main"><strong>{project.name}</strong><small className="muted" title={project.root}>{project.root}</small></span>
                  {data.mode === "fleet" && <NodeTag id={project.nodeId} name={project.nodeName} />}
                  <span className="muted">{project.taskCount} 项任务</span>
                  {project.activeTasks > 0 && <span className="info">{project.activeTasks} 项进行中</span>}
                  {project.needsAttention > 0 && <Badge tone="bad">{project.needsAttention} 项需关注</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {edit && <RootDialog root={edit.root} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RootDialog({ root, onClose }: { root?: RootRow; onClose: () => void }) {
  const data = useData();
  const dialogs = useDialogs();
  const { busy, act } = useAct();
  const online = (data.fleet?.nodes ?? []).filter((node) => node.online);
  const defaultNode = root?.node.id ?? (online.some((node) => node.id === data.scopeNode) ? data.scopeNode : online.length === 1 ? online[0].id : "");
  const [nodeId, setNodeId] = useState(defaultNode);
  const [form, setForm] = useState({ id: root?.id ?? "", nickname: root?.nickname ?? "", path: root?.path ?? "", description: root?.description ?? "", tags: root?.tags.join(", ") ?? "", enabled: root?.enabled ?? true });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const original = root ? { id: root.id, nickname: root.nickname, path: root.path, description: root.description ?? "", tags: root.tags, enabled: root.enabled } : null;

  const problems: string[] = [];
  if (!nodeId) problems.push("请明确选择所在机器。");
  else if (!online.some((node) => node.id === nodeId)) problems.push("该机器已离线，暂时不能保存目录。");
  if (!form.nickname.trim()) problems.push("目录昵称不能为空。");
  if (!ID_PATTERN.test(form.id.trim())) problems.push("稳定 ID 只能包含字母、数字、点、下划线和连字符，且以字母或数字开头。");
  if (!ABSOLUTE.test(form.path.trim())) problems.push("请填写该机器上的绝对路径，例如 /data/projects/vla 或 D:\\Projects\\Game。");

  const same = (entry: RootEntry) => JSON.stringify([entry.id, entry.nickname, entry.path, entry.description ?? "", entry.tags ?? [], entry.enabled]) === JSON.stringify(original && [original.id, original.nickname, original.path, original.description, original.tags, original.enabled]);

  const save = () => act(async () => {
    const latest = await api<NodeSettings>("fleet/settings/get", { nodeId });
    const entry: RootEntry = { id: form.id.trim(), nickname: form.nickname.trim(), path: form.path.trim(), description: form.description, tags: [...new Set(form.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))], enabled: form.enabled };
    let next: RootEntry[];
    if (root) {
      const current = latest.roots.find((candidate) => candidate.id === root.id);
      if (!current) throw new Error("这个根目录已在别处被移除，请刷新后再试。");
      if (!same(current) && !(await dialogs.confirm({ title: "根目录已在别处被修改", message: "打开此窗口后，这个根目录被其他页面或设备修改过。继续保存会覆盖对方的修改。", confirmText: "覆盖保存", danger: true }))) return false;
      next = latest.roots.map((candidate) => (candidate.id === root.id ? entry : candidate));
    } else {
      if (latest.roots.some((candidate) => candidate.id === entry.id)) throw new Error("这个 ID 在该机器上已存在，请换一个。");
      next = [...latest.roots, entry];
    }
    await api("fleet/settings/update", { nodeId, settings: { roots: next } });
    await data.refresh();
    onClose();
  }, "根目录已保存；GPT 在下一次调用工作区工具时生效");

  const remove = () => act(async () => {
    if (!root) return;
    const result = await api<{ projects: Project[] }>("projects", undefined, root.node.id);
    const inside = result.projects.filter((project) => under(project.root, root.path));
    if (inside.some((project) => project.activeTasks === undefined)) throw new Error("无法确认目录下的活动任务，请刷新后再试。");
    const running = inside.reduce((total, project) => total + project.activeTasks, 0);
    if (running) throw new Error(`该目录下还有 ${running} 项任务在运行，请等待结束或取消后再移除。`);
    if (!(await dialogs.confirm({ title: `移除"${root.nickname}"？`, message: "只从目录清单中移除，磁盘上的文件保持原样。GPT 之后将无法选择这个目录。", confirmText: "移除", danger: true }))) return false;
    const latest = await api<NodeSettings>("fleet/settings/get", { nodeId: root.node.id });
    await api("fleet/settings/update", { nodeId: root.node.id, settings: { roots: latest.roots.filter((entry) => entry.id !== root.id) } });
    await data.refresh();
    onClose();
  }, "已移除目录");

  return (
    <Dialog title={root ? "编辑根目录" : "添加根目录"} onClose={onClose} locked={busy} footer={<>
      {root && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>移除目录</button>}
      <span className="spacer" />
      <button type="button" onClick={onClose} disabled={busy}>取消</button>
      <button type="button" className="primary" disabled={busy || problems.length > 0} onClick={() => void save()}>{busy ? "正在保存…" : "保存目录"}</button>
    </>}>
      <fieldset className="form" disabled={busy}>
        <div className="form-grid">
          <label className="span2">所在机器
            <select value={nodeId} disabled={Boolean(root)} onChange={(event) => setNodeId(event.target.value)}>
              <option value="">请选择机器…</option>
              {(data.fleet?.nodes ?? []).map((node) => <option key={node.id} value={node.id} disabled={!node.online}>{node.nickname}{node.online ? "" : "（离线，不可选）"}</option>)}
            </select>
          </label>
          <label>目录昵称<input value={form.nickname} maxLength={120} placeholder="VLA 主代码" onChange={(event) => set({ nickname: event.target.value })} /></label>
          <label>稳定 ID<input value={form.id} readOnly={Boolean(root)} placeholder="vla-main" onChange={(event) => set({ id: event.target.value })} /></label>
          <label className="span2">该机器上的绝对路径<input value={form.path} placeholder="/data/projects/vla 或 D:\Projects\Game" onChange={(event) => set({ path: event.target.value })} /></label>
          <label className="span2">用途说明<textarea rows={3} value={form.description} placeholder="代码、Todo 和当前实验入口；便于 GPT 根据任务选择" onChange={(event) => set({ description: event.target.value })} /></label>
          <label className="span2">标签（逗号分隔）<input value={form.tags} placeholder="vla, code, gpu" onChange={(event) => set({ tags: event.target.value })} /></label>
          <label className="check span2"><input type="checkbox" checked={form.enabled} onChange={(event) => set({ enabled: event.target.checked })} />向 GPT 提供这个根目录</label>
        </div>
        <p className="fine">路径是否存在、是否可写、是否为 git 仓库需要所在机器校验；后端提供校验接口前，保存时只检查格式。</p>
        {problems.length > 0 && (form.nickname || form.id || form.path) && <Notice tone="warn"><ul className="impact-list">{problems.map((item) => <li key={item}>{item}</li>)}</ul></Notice>}
      </fieldset>
    </Dialog>
  );
}
