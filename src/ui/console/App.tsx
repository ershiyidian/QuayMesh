import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity, FileDiff, FolderTree, Gauge, LayoutDashboard, ListChecks, LogOut, Menu, MessagesSquare,
  Moon, RefreshCw, Search, Server, Settings, Sun,
} from "lucide";
import { api, ApiError, errorText, session } from "./api.js";
import { fmtTime, isActive, LOCAL, parseTime } from "./format.js";
import { getAttentionItems } from "./attention.js";
import { ActivityPage } from "./pages/Activity.js";
import { ChangesPage } from "./pages/Changes.js";
import { ExecutionDrawer } from "./pages/ExecutionDrawer.js";
import { MachinesPage } from "./pages/Machines.js";
import { OverviewPage } from "./pages/Overview.js";
import { SessionsPage } from "./pages/Sessions.js";
import { SettingsPage } from "./pages/Settings.js";
import { TasksPage } from "./pages/Tasks.js";
import { UsagePage } from "./pages/Usage.js";
import { WorkspacesPage } from "./pages/Workspaces.js";
import { execParam, navigate, parseExecParam, routeHref, useRoute, type Patch, type View } from "./router.js";
import { DataProvider, useData } from "./store.js";
import { setThemePref, useTheme } from "./theme.js";
import { Dialog, DialogsProvider, Icon, NodeTag, ToastProvider, useToast } from "./ui.js";

export const VIEW_META: Record<View, { title: string; desc: string; icon: Parameters<typeof Icon>[0]["icon"] }> = {
  overview: { title: "总览", desc: "现在整体怎么样，有什么需要处理", icon: LayoutDashboard },
  tasks: { title: "任务", desc: "在跑什么、跑完了什么、结果如何", icon: ListChecks },
  changes: { title: "改动", desc: "所有机器上改了哪些代码", icon: FileDiff },
  sessions: { title: "会话", desc: "受管 Codex 会话、实时控制与归档", icon: MessagesSquare },
  machines: { title: "机器", desc: "健康、负载、版本与统一出口", icon: Server },
  workspaces: { title: "工作空间", desc: "GPT 可用的根目录与项目", icon: FolderTree },
  activity: { title: "活动", desc: "系统事件、文件传输与调用审计", icon: Activity },
  usage: { title: "用量", desc: "Codex Token 花在了哪里", icon: Gauge },
  settings: { title: "设置", desc: "外观、通知、出口配置与账号", icon: Settings },
};
const NAV: View[] = ["overview", "tasks", "changes", "sessions", "machines", "workspaces", "activity", "usage", "settings"];

export function App() {
  const [state, setState] = useState<"boot" | "login" | "ready" | "unavailable">("boot");
  const [reauth, setReauth] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const restore = async () => {
    setState("boot");
    try {
      const result = await api<{ csrf: string }>("session");
      session.setCsrf(result.csrf);
      setState("ready");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setState("login");
      else { setConnectionError(errorText(error)); setState("unavailable"); }
    }
  };
  useEffect(() => {
    session.onUnauthorized(() => setReauth(true));
    void restore();
    return () => session.onUnauthorized(null);
  }, []);
  const logout = async () => {
    try { await api("logout", {}); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) { setConnectionError(errorText(error)); setState("unavailable"); return; }
    }
    session.setCsrf(null);
    setReauth(false);
    setState("login");
  };
  if (state === "boot") return <main className="boot" aria-busy="true"><span className="brand-mark">TQ</span>正在连接 QuayMesh…</main>;
  if (state === "unavailable") return <main className="login-page"><section className="login-card"><h1>连接暂时中断</h1><p>{connectionError}</p><p>原有会话仍保留在浏览器中。</p><button className="primary full" type="button" onClick={() => void restore()}>重新连接</button></section></main>;
  return (
    <ToastProvider>
      <DialogsProvider>
        {state === "login"
          ? <LoginPage onDone={() => setState("ready")} />
          : <DataProvider><Shell onLogout={logout} /></DataProvider>}
        {reauth && state === "ready" && (
          <Dialog title="会话已过期" size="sm" locked onClose={() => undefined}>
            <p className="muted">重新输入口令后回到当前页面，未保存的内容会保留。</p>
            <LoginForm onDone={() => setReauth(false)} />
            <button type="button" className="ghost full" onClick={() => void logout()}>改为退出登录</button>
          </Dialog>
        )}
      </DialogsProvider>
    </ToastProvider>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ csrf: string }>("login", { password });
      session.setCsrf(result.csrf);
      setPassword("");
      onDone();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="login-form" onSubmit={submit}>
      <label htmlFor="owner-password">管理口令</label>
      <input id="owner-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={2048} />
      {error && <p className="field-error" role="alert">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? "正在验证…" : "进入控制台"}</button>
    </form>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  return (
    <main className="login-page">
      <section className="login-card">
        <span className="brand-mark lg">TQ</span>
        <p className="eyebrow">QUAYMESH CONSOLE</p>
        <h1>QuayMesh</h1>
        <p className="lead">任务从哪里来、在哪台机器跑、改了什么、用了多少——一处看清。</p>
        <LoginForm onDone={onDone} />
        <p className="fine">使用现有 owner token 登录。口令不会写入网址或浏览器本地存储。浏览、统计和归档本身不调用 Codex 推理。</p>
      </section>
      <p className="login-caption">本机执行 · 来源可追溯 · 验收有依据</p>
    </main>
  );
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const route = useRoute();
  const data = useData();
  const { theme } = useTheme();
  const toast = useToast();
  const [palette, setPalette] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
      if (event.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { document.title = `${VIEW_META[route.view].title} · QuayMesh`; setNavOpen(false); }, [route.view]);

  const attentionCount = getAttentionItems(data).length;
  const runningCount = data.runs.filter((run) => isActive(run.executionStatus)).length;
  const counts: Partial<Record<View, number>> = { overview: attentionCount, tasks: runningCount };
  const gateway = data.fleet?.gatewayId ? data.nodeName(data.fleet.gatewayId) : null;
  const proxyEnabled = Boolean(data.fleet?.proxyUrl);
  const controller = data.fleet?.nodes.find((node) => node.role === "controller");
  const connectionLabel = proxyEnabled ? (gateway ? `代理 · ${gateway}` : "代理出口不可用") : (controller ? `主控 · ${controller.nickname}` : `连接 · ${data.nodeName(data.localNodeId)}`);
  const exec = parseExecParam(route.get("exec"));
  const nav = (view: View) => navigate({ view, node: route.get("node"), project: route.get("project") }, { reset: true });

  const Page = { overview: OverviewPage, tasks: TasksPage, changes: ChangesPage, sessions: SessionsPage, machines: MachinesPage, workspaces: WorkspacesPage, activity: ActivityPage, usage: UsagePage, settings: SettingsPage }[route.view];

  return (
    <div className="app">
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <a className="brand" href={routeHref({ view: "overview" }, true)} onClick={(event) => { event.preventDefault(); nav("overview"); }}>
          <span className="brand-mark">TQ</span><span>QuayMesh<small>{data.mode === "fleet" ? `${data.nodes.length} 台机器` : "单机模式"}</small></span>
        </a>
        <nav aria-label="主导航">
          {NAV.map((view) => (
            <a key={view} href={routeHref({ view, node: route.get("node"), project: route.get("project") }, true)} aria-current={route.view === view ? "page" : undefined}
              className={`nav-item ${route.view === view ? "on" : ""}`} onClick={(event) => { if (event.button === 0 && !event.ctrlKey && !event.metaKey) { event.preventDefault(); nav(view); } }}>
              <Icon icon={VIEW_META[view].icon} /><span>{VIEW_META[view].title}</span>
              {counts[view] ? <span className={`nav-count ${view === "overview" ? "bad" : ""}`}>{counts[view]}</span> : null}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="foot-line"><i className="dot on" />{data.mode === "fleet" ? `当前连接 · ${data.nodeName(data.localNodeId)}` : "已认证的管理会话"}</span>
          <button type="button" className="ghost sm" onClick={onLogout}><Icon icon={LogOut} size={14} />退出登录</button>
        </div>
      </aside>
      {navOpen && <div className="scrim" role="presentation" onClick={() => setNavOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" aria-label="打开导航" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Icon icon={Menu} size={18} /></button>
          <ScopeBar />
          <button type="button" className="search-btn" onClick={() => setPalette(true)} aria-label="全局搜索"><Icon icon={Search} size={15} /><span>搜索任务、机器、ID…</span><kbd>Ctrl K</kbd></button>
          <div className="top-actions">
            {data.mode === "fleet" && <span className={`pill ${proxyEnabled && !gateway ? "off" : ""}`} title={proxyEnabled ? data.fleet?.gatewayReason ?? "统一出网代理" : "工具通过主控连接各台机器；统一出网代理未启用"}><i className={`dot ${proxyEnabled && !gateway ? "off" : "on"}`} />{connectionLabel}</span>}
            <span className="updated" title={data.updatedAt ? fmtTime(data.updatedAt) : ""}>{data.updatedAt ? `${fmtTime(data.updatedAt).slice(11)} 更新` : "读取中"}</span>
            <button type="button" className="icon-btn" aria-label="立即刷新" disabled={spinning} onClick={async () => { setSpinning(true); await data.refresh(); setSpinning(false); toast("已刷新", "info"); }}>
              <span className={spinning ? "spin" : ""}><Icon icon={RefreshCw} size={16} /></span>
            </button>
            <button type="button" className="icon-btn" aria-label="切换深浅色" onClick={() => setThemePref(theme === "dark" ? "light" : "dark")}><Icon icon={theme === "dark" ? Sun : Moon} size={16} /></button>
          </div>
        </header>
        <main className="content" id="content" aria-busy={data.mode === "unknown" || data.runsLoading || data.nodes.some((node) => node.online && !data.projects[node.id])}>
          {data.fleetError && <div className="notice n-warn" role="status"><div>机器状态读取失败：{data.fleetError}。页面显示的是上次成功读取的数据。</div></div>}
          <div className="page-head">
            <div><p className="eyebrow">{VIEW_META[route.view].desc}</p><h1>{VIEW_META[route.view].title}</h1></div>
          </div>
          <Page />
          <footer className="page-foot"><span>QuayMesh · 执行与证据层</span><span>页面刷新、统计和归档控制均不启动模型推理 · 时间按 {Intl.DateTimeFormat().resolvedOptions().timeZone} 显示</span></footer>
        </main>
      </div>
      {exec && <ExecutionDrawer key={route.get("exec")} node={exec.node || data.localNodeId} project={exec.project} run={exec.run} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

function ScopeBar() {
  const data = useData();
  const route = useRoute();
  const projects = data.allProjects.filter((project) => !data.scopeNode || project.nodeId === data.scopeNode);
  const projectValue = data.scopeProject ? `${data.scopedProjects[0]?.nodeId ?? data.scopeNode}|${data.scopeProject}` : "";
  return (
    <div className="scope" aria-label="范围">
      {data.mode === "fleet" && (
        <label className="scope-field"><span>机器</span>
          <select value={data.scopeNode} onChange={(event) => navigate({ node: event.target.value, project: projects.some((p) => p.nodeId === event.target.value && p.id === route.get("project")) ? route.get("project") : null })}>
            <option value="">全部机器（{data.nodes.length}）</option>
            {data.nodes.map((node) => <option key={node.id} value={node.id}>{node.online ? "● " : "○ "}{node.name}{node.online ? "" : "（离线）"}</option>)}
          </select>
        </label>
      )}
      <label className="scope-field"><span>项目</span>
        <select value={projectValue} onChange={(event) => {
          const [node, project] = event.target.value.split("|");
          navigate(project ? { project, node: data.mode === "fleet" ? node : null } : { project: null });
        }}>
          <option value="">全部项目（{projects.length}）</option>
          {projects.map((project) => <option key={`${project.nodeId}|${project.id}`} value={`${project.nodeId}|${project.id}`}>{data.mode === "fleet" && !data.scopeNode ? `${project.nodeName} / ` : ""}{project.name}</option>)}
        </select>
      </label>
    </div>
  );
}

interface PaletteItem { key: string; group: string; title: string; hint?: string; go: Patch; reset?: boolean }

function CommandPalette({ onClose }: { onClose: () => void }) {
  const data = useData();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (...values: (string | undefined)[]) => !q || values.some((value) => value?.toLowerCase().includes(q));
    const result: PaletteItem[] = [];
    for (const view of NAV) if (match(VIEW_META[view].title, view)) result.push({ key: `v:${view}`, group: "页面", title: VIEW_META[view].title, hint: VIEW_META[view].desc, go: { view }, reset: true });
    // 引用格式：节点/exec/ID
    const ref = /^([^/\s]+)\/exec\/(\S+)$/.exec(query.trim());
    for (const run of data.runs) {
      if (result.length > 60) break;
      if (ref ? run.nodeId === ref[1] && run.workRunId === ref[2] : match(run.title, run.workRunId, run.projectName)) {
        result.push({ key: `r:${run.key}`, group: "任务", title: run.title || run.workRunId, hint: `${data.nodeName(run.nodeId)} · ${run.projectName} · ${run.workRunId}`, go: { exec: execParam(run.nodeId, run.projectId, run.workRunId), dtab: null } });
      }
    }
    for (const node of data.nodes) if (data.mode === "fleet" && match(node.name, node.id)) result.push({ key: `n:${node.id}`, group: "机器", title: node.name, hint: `${node.id} · ${node.online ? "在线" : "离线"}`, go: { view: "machines", machine: node.id }, reset: true });
    for (const project of data.allProjects) if (match(project.name, project.id, project.root)) result.push({ key: `p:${project.nodeId}/${project.id}`, group: "项目", title: project.name, hint: `${project.nodeName} · ${project.root}`, go: { view: "tasks", node: project.nodeId === LOCAL ? null : project.nodeId, project: project.id }, reset: true });
    for (const node of data.fleet?.nodes ?? []) for (const root of node.roots) if (match(root.nickname, root.id, root.path, ...root.tags)) result.push({ key: `w:${node.id}/${root.id}`, group: "工作空间", title: root.nickname, hint: `${node.nickname} · ${root.path}`, go: { view: "workspaces", q: root.id }, reset: true });
    return result.slice(0, 50);
  }, [query, data]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" }); }, [index]);
  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    navigate(item.go, { reset: item.reset });
    onClose();
  };
  let lastGroup = "";
  return (
    <Dialog title="全局搜索" onClose={onClose} size="md">
      <input autoFocus className="palette-input" placeholder="输入任务标题、ID、机器、项目、路径，或 节点/exec/ID" value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.max(0, Math.min(items.length - 1, i + 1))); }
          if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
          if (event.key === "Enter") go(items[index]);
        }} />
      <ul className="palette-list" ref={listRef} role="listbox">
        {items.map((item, i) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <li key={item.key}>
              {header && <div className="palette-group">{header}</div>}
              <button type="button" data-index={i} role="option" aria-selected={i === index} className={i === index ? "on" : ""} onMouseEnter={() => setIndex(i)} onClick={() => go(item)}>
                <strong>{item.title}</strong>{item.hint && <small>{item.hint}</small>}
              </button>
            </li>
          );
        })}
        {!items.length && <li className="muted palette-empty">没有匹配结果。只能搜索到已加载的任务；可在任务页调整时间范围后再试。</li>}
      </ul>
      <p className="fine">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
    </Dialog>
  );
}

export function RunRef({ nodeId, name }: { nodeId: string; name: string }) {
  return <NodeTag id={nodeId} name={name} />;
}

export const startOf = (run: { startedAt?: string | null; createdAt?: string }) => parseTime(run.startedAt ?? run.createdAt);
