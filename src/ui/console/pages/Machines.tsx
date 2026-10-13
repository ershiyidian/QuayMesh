import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, isAuthError } from "../api.js";
import { bytes, duration, isActive, providerLabel, roles } from "../format.js";
import { navigate, useRoute } from "../router.js";
import { useData } from "../store.js";
import { Badge, CopyButton, Dialog, Empty, Meter, NodeTag, Notice, TimeText, useAct, useDialogs } from "../ui.js";
import { openRun } from "./Tasks.js";
import type { Egress, FleetNode, FleetStatus, NodeSettings, Peer, RunRow } from "../types.js";

export function memoryUse(node: FleetNode): { pct: number | null; note: string } {
  const h = node.health;
  if (!h.memoryTotal) return { pct: null, note: "" };
  if (h.memoryAvailable != null) return { pct: (1 - h.memoryAvailable / h.memoryTotal) * 100, note: "按可用内存（available）计算" };
  if (h.memoryFree != null) return { pct: (1 - h.memoryFree / h.memoryTotal) * 100, note: "按空闲内存（free）计算，含系统缓存，数值可能偏高" };
  return { pct: null, note: "" };
}

function Res({ label, value, title, stale }: { label: string; value: number | null | undefined; title?: string; stale: boolean }) {
  const shown = stale || value == null ? null : value;
  return (
    <div className="res-item" title={title}>
      <span>{label}{title?.includes("偏高") && <sup>*</sup>}</span>
      <strong>{shown == null ? "—" : `${Math.round(shown)}%`}</strong>
      <Meter value={shown} />
    </div>
  );
}

export function MachineCard({ node, gateway, running }: { node: FleetNode; gateway: boolean; running: RunRow[] }) {
  const mem = memoryUse(node);
  const stale = !node.online;
  const disk = node.health.disks?.[0];
  return (
    <article className={`machine ${gateway ? "is-gateway" : ""} ${stale ? "is-offline" : ""}`}>
      <button type="button" className="machine-head" onClick={() => navigate({ view: "machines", machine: node.id }, { reset: true })}>
        <NodeTag id={node.id} name={node.nickname} online={node.online} />
        <span className="muted role">{roles[node.role] ?? node.role}</span>
        {gateway ? <Badge tone="ok">当前发信</Badge> : <Badge tone={node.online ? "info" : "muted"}>{node.online ? "在线" : "离线"}</Badge>}
      </button>
      {stale && <p className="stale">离线 · 数据截至 <TimeText value={node.lastSeen} compact rel /></p>}
      <div className="res">
        <Res label="CPU" value={node.health.cpu} stale={stale} />
        <Res label="内存" value={mem.pct} title={mem.note} stale={stale} />
        {disk && disk.totalBytes > 0 && <Res label="磁盘" value={(1 - disk.freeBytes / disk.totalBytes) * 100} title={`${disk.mount} 剩余 ${bytes(disk.freeBytes)}`} stale={stale} />}
      </div>
      {node.health.gpus.map((gpu, index) => (
        <div className="gpu" key={index}>
          <div className="gpu-line">
            <span>{gpu.name}</span>
            <span>{stale ? "—" : `${gpu.utilization}%`}{!stale && gpu.temperature != null ? ` · ${gpu.temperature}°C` : ""}</span>
          </div>
          <Meter value={stale ? null : gpu.memoryUsedMiB} max={gpu.memoryTotalMiB} />
          <small className={stale ? "stale-text" : ""}>{stale ? "显存数据已过期" : `显存 ${(gpu.memoryUsedMiB / 1024).toFixed(1)} / ${(gpu.memoryTotalMiB / 1024).toFixed(1)} GB`}</small>
        </div>
      ))}
      <div className="machine-foot">
        <span>{node.roots.filter((root) => root.enabled).length} 个根目录</span>
        <span>{node.online ? `${node.health.activeCalls} 个工具调用` : "—"}</span>
        <span className={running.length ? "info" : "muted"}>{running.length} 项运行中</span>
      </div>
      {running.slice(0, 2).map((run) => (
        <button type="button" key={run.key} className="machine-run" onClick={() => openRun(run)} title={run.title}><i className="pulse" />{run.title || run.workRunId}</button>
      ))}
    </article>
  );
}

function gatewayReason(fleet: FleetStatus): string {
  if (!fleet.proxyUrl) return "统一出网代理未启用。工具通过主控连接各台机器。";
  if (fleet.gatewayReason) return fleet.gatewayReason;
  const candidates = fleet.nodes.filter((node) => node.role !== "worker" && node.priority > 0).sort((a, b) => b.priority - a.priority);
  const gateway = fleet.nodes.find((node) => node.id === fleet.gatewayId);
  if (!gateway) return candidates.length ? "所有候选节点都离线或出口不可用。" : "没有配置发信候选节点（优先级大于 0 且角色不是执行节点）。";
  const skipped = candidates.filter((node) => node.priority > gateway.priority)
    .map((node) => `${node.nickname}${!node.online ? "离线" : node.egress.enabled && node.egress.healthy === false ? "出口不可用" : "正在回切等待"}`);
  return `${gateway.nickname} 是在线且出口可用的候选中优先级最高的（${gateway.priority}）${skipped.length ? `；更高优先级的 ${skipped.join("、")}` : ""}。此说明由前端根据状态推断，后端提供 gatewayReason 后以后端为准。`;
}

export function MachinesPage() {
  const data = useData();
  const route = useRoute();
  if (data.mode !== "fleet" || !data.fleet) {
    return (
      <div className="stack">
        <Notice tone="info">当前是单机模式：这台机器既是主控也是执行节点。使用 <code>quaymesh init --node desktop --role controller</code> 开启多机模式后，可以在这里添加服务器、统一出口并查看每台机器的健康状况。</Notice>
        <div className="panel"><Empty title="单机模式下没有机器列表">任务、会话与用量页面照常可用。</Empty></div>
      </div>
    );
  }
  const fleet = data.fleet;
  const proxyEnabled = Boolean(fleet.proxyUrl);
  const controller = fleet.nodes.find((node) => node.role === "controller");
  const online = fleet.nodes.filter((node) => node.online);
  const versions = [...new Set(online.map((node) => node.versions?.quaymesh).filter((value): value is string => Boolean(value)))];
  const skew = online.filter((node) => Math.abs(node.clockOffsetMs ?? 0) > 2000);
  const candidates = fleet.nodes.filter((node) => node.role !== "worker" && node.priority > 0).sort((a, b) => b.priority - a.priority);
  const selected = fleet.nodes.find((node) => node.id === route.get("machine"));

  return (
    <div className="stack">
      {versions.length > 1 && <Notice tone="warn">在线机器的 QuayMesh 版本不一致（{versions.join(" / ")}）。每台服务器加载各自的 dist/，请在版本较旧的机器上重新编译或同步。</Notice>}
      {skew.length > 0 && <Notice tone="warn">时钟偏差超过 2 秒：{skew.map((node) => `${node.nickname}（${Math.round((node.clockOffsetMs ?? 0) / 1000)} 秒）`).join("、")}。任务排序和耗时可能不准，请检查 NTP。</Notice>}

      <section className="panel gateway-panel">
        <div className="panel-head"><h2>{proxyEnabled ? "统一出网代理" : "MCP 主控"}</h2><span className="muted">{proxyEnabled ? "节点失联或代理出口不可用时按配置切换" : "任务在各自的机器上执行"}</span></div>
        <div className="gw-grid">
          <div>
            <p className="gw-current">{proxyEnabled ? (fleet.gatewayId ? <NodeTag id={fleet.gatewayId} name={data.nodeName(fleet.gatewayId)} online /> : <Badge tone="bad">代理出口不可用</Badge>) : (controller ? <NodeTag id={controller.id} name={controller.nickname} online={controller.online} /> : <Badge tone="info">当前节点连接</Badge>)}</p>
            <p className="fine">{gatewayReason(fleet)}</p>
            {fleet.publicMcpUrl && <p className="mcp-line"><code>{fleet.publicMcpUrl}</code><CopyButton text={fleet.publicMcpUrl} label="复制地址" /></p>}
          </div>
          <ol className="gw-order">
            {candidates.map((node, index) => (
              <li key={node.id}>
                <span className="gw-index">{index + 1}</span>
                <NodeTag id={node.id} name={node.nickname} online={node.online} />
                <span className="muted">优先级 {node.priority}</span>
                {!proxyEnabled ? <Badge tone={node.online ? "ok" : "muted"}>{node.online ? "在线" : "离线"}</Badge> : node.id === fleet.gatewayId ? <Badge tone="ok">当前</Badge>
                  : !node.online ? <Badge tone="muted">离线</Badge>
                  : node.egress.enabled && node.egress.healthy === false ? <Badge tone="warn">出口不可用</Badge>
                  : <Badge tone="info">待命</Badge>}
              </li>
            ))}
            {!candidates.length && <li className="muted">没有发信候选节点。</li>}
          </ol>
        </div>
        <p className="fine">固定节点、排空节点与立即切换需要后端提供对应接口后开放。</p>
      </section>

      <div className="machine-layout">
        <div className="machine-grid overview-four-col">
          {fleet.nodes.map((node) => (
            <MachineCard key={node.id} node={node} gateway={node.id === fleet.gatewayId} running={data.runs.filter((run) => run.nodeId === node.id && isActive(run.executionStatus))} />
          ))}
        </div>
      </div>

      {selected && <MachineDetail node={selected} gateway={selected.id === fleet.gatewayId} onClose={() => navigate({ machine: null })} />}
    </div>
  );
}

function MachineDetail({ node, gateway, onClose }: { node: FleetNode; gateway: boolean; onClose: () => void }) {
  const data = useData();
  const [settings, setSettings] = useState<"edit" | "readonly" | null>(null);
  const mem = memoryUse(node);
  const running = data.runs.filter((run) => run.nodeId === node.id && isActive(run.executionStatus));
  const egress = node.egress;
  return (
    <Dialog title={`机器 · ${node.nickname}`} size="lg" onClose={onClose} footer={<>
      <button type="button" onClick={onClose}>关闭</button>
      {node.online ? <button type="button" className="primary" onClick={() => setSettings("edit")}>节点设置</button>
        : <button type="button" onClick={() => setSettings("readonly")}>查看最后已知配置</button>}
    </>}>
      <div className="stack">
        <div className="button-row">
          <NodeTag id={node.id} name={node.nickname} online={node.online} />
          <code>{node.id}</code>
          <span className="muted">{roles[node.role] ?? node.role} · 优先级 {node.priority}</span>
          {gateway && <Badge tone="ok">当前发信</Badge>}
        </div>
        {!node.online && <Notice tone="warn">机器离线，最后在线于 <TimeText value={node.lastSeen} rel />。以下数值是最后一次上报的内容，已过期。</Notice>}
        <section>
          <h3>资源</h3>
          <dl className="kv">
            <div><dt>CPU</dt><dd>{node.health.cpu != null ? `${Math.round(node.health.cpu)}%` : "未上报"}{node.health.load?.length ? ` · 负载 ${node.health.load.map((value) => value.toFixed(2)).join(" / ")}` : ""}</dd></div>
            <div><dt>内存</dt><dd>{mem.pct != null ? `${Math.round(mem.pct)}% · 共 ${bytes(node.health.memoryTotal)}` : "未上报"}{mem.note && <small className="muted"> · {mem.note}</small>}</dd></div>
            <div><dt>运行时长</dt><dd>{node.health.uptimeSec ? duration(node.health.uptimeSec * 1000) : "未上报"}</dd></div>
            <div><dt>工具调用</dt><dd>{node.online ? node.health.activeCalls : "—"}</dd></div>
            {(node.health.disks ?? []).map((disk) => <div key={disk.mount}><dt>磁盘 {disk.mount}</dt><dd>剩余 {bytes(disk.freeBytes)} / {bytes(disk.totalBytes)}</dd></div>)}
          </dl>
          {node.health.gpus.map((gpu, index) => (
            <div className="gpu wide" key={index}>
              <div className="gpu-line"><strong>{gpu.name}</strong><span>利用率 {gpu.utilization}%{gpu.temperature != null ? ` · ${gpu.temperature}°C` : ""}</span></div>
              <Meter value={gpu.memoryUsedMiB} max={gpu.memoryTotalMiB} />
              <small>显存 {(gpu.memoryUsedMiB / 1024).toFixed(1)} / {(gpu.memoryTotalMiB / 1024).toFixed(1)} GB</small>
              {gpu.processes?.length ? <ul className="gpu-procs">{gpu.processes.map((proc) => <li key={proc.pid}>PID {proc.pid}{proc.name ? ` · ${proc.name}` : ""}{proc.executionId ? ` · ${proc.executionId}` : ""}</li>)}</ul> : null}
            </div>
          ))}
          <p className="fine">历史曲线需要后端保存资源采样后显示。</p>
        </section>
        <section>
          <h3>统一出口</h3>
          <dl className="kv">
            <div><dt>状态</dt><dd>{!egress.enabled ? <Badge tone="muted">未启用</Badge> : egress.healthy ? <Badge tone="ok">可用</Badge> : <Badge tone="warn">待连接</Badge>}</dd></div>
            <div><dt>出口 IP</dt><dd>{egress.exitIp ?? "未上报"}{egress.region ? ` · ${egress.region}` : ""}</dd></div>
            <div><dt>探测延迟</dt><dd>{egress.latencyMs != null ? `${Math.round(egress.latencyMs)} ms` : "—"}</dd></div>
            <div><dt>最后探测</dt><dd><TimeText value={egress.probedAt} rel /></dd></div>
            <div><dt>mihomo 配置</dt><dd><code>{egress.mihomoConfig ?? "未配置"}</code></dd></div>
            <div><dt>本地代理端口</dt><dd>{egress.listenPort ?? "—"}</dd></div>
          </dl>
        </section>
        <section>
          <h3>版本与连接</h3>
          <dl className="kv">
            <div><dt>QuayMesh</dt><dd>{node.versions?.quaymesh ?? "未上报"}</dd></div>
            <div><dt>Codex</dt><dd>{node.versions?.codex ?? "未上报"}</dd></div>
            <div><dt>连接延迟</dt><dd>{node.online ? (node.latencyMs == null ? "本地" : `${Math.round(node.latencyMs)} ms`) : "—"}</dd></div>
            <div><dt>时钟偏差</dt><dd>{node.clockOffsetMs != null ? `${(node.clockOffsetMs / 1000).toFixed(1)} 秒` : "未上报"}</dd></div>
          </dl>
          {node.providers.length > 0 && <p className="chips">{node.providers.map((provider, index) => <span className="chip" key={index}>{providerLabel(provider)}</span>)}</p>}
        </section>
        <section>
          <h3>正在运行 <span className="count">{running.length}</span></h3>
          {running.length ? <ul className="row-list">{running.map((run) => (
            <li key={run.key}><button type="button" className="row-button" onClick={() => openRun(run)}><span className="row-main"><strong>{run.title}</strong><small className="muted">{run.projectName}</small></span><TimeText value={run.startedAt ?? run.createdAt} compact rel /></button></li>
          ))}</ul> : <p className="muted">没有运行中的任务。</p>}
        </section>
        <section>
          <h3>根目录 <span className="count">{node.roots.length}</span></h3>
          <ul className="row-list">{node.roots.map((root) => (
            <li key={root.id} className="root-line"><strong>{root.nickname}</strong><code>{root.path}</code>{root.enabled ? <Badge tone="ok">启用</Badge> : <Badge tone="muted">停用</Badge>}</li>
          ))}</ul>
        </section>
      </div>
      {settings && <NodeSettingsDialog node={node} readOnly={settings === "readonly"} onClose={() => setSettings(null)} />}
    </Dialog>
  );
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
interface FormState { nickname: string; role: string; priority: number; peers: Peer[]; egress: Egress }

function NodeSettingsDialog({ node, readOnly, onClose }: { node: FleetNode; readOnly: boolean; onClose: () => void }) {
  const data = useData();
  const dialogs = useDialogs();
  const { busy, act } = useAct();
  const initialNode = useRef(node).current;
  const [original, setOriginal] = useState<NodeSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (readOnly) {
      const snapshot: NodeSettings = { nickname: node.nickname, role: node.role, priority: node.priority, peers: [], egress: node.egress, roots: node.roots };
      setOriginal(snapshot);
      setForm({ nickname: snapshot.nickname, role: snapshot.role, priority: snapshot.priority, peers: [], egress: snapshot.egress });
      return;
    }
    api<NodeSettings>("fleet/settings/get", { nodeId: node.id })
      .then((result) => {
        setOriginal(result);
        setForm({ nickname: result.nickname, role: result.role, priority: result.priority, peers: result.peers ?? [], egress: { ...result.egress } });
      })
      .catch((cause) => { if (!isAuthError(cause)) setError(errorText(cause, "读取节点设置失败")); });
  }, [initialNode.id, readOnly]);

  const problems = useMemo(() => {
    if (!form) return [];
    const list: string[] = [];
    if (!form.nickname.trim()) list.push("节点昵称不能为空。");
    if (!Number.isFinite(form.priority) || form.priority < 0 || form.priority > 1000) list.push("优先级需在 0–1000 之间。");
    const ids = form.peers.map((peer) => peer.id.trim());
    ids.forEach((id, index) => {
      if (!ID_PATTERN.test(id)) list.push(`第 ${index + 1} 个连接的节点 ID 格式不正确。`);
      if (id === node.id) list.push("连接列表不能包含本节点自己。");
    });
    if (new Set(ids).size !== ids.length) list.push("连接列表中存在重复的节点 ID。");
    const port = form.egress.listenPort ?? 0;
    if (form.egress.enabled && (port < 1 || port > 65535)) list.push("本地代理端口需在 1–65535 之间。");
    return list;
  }, [form, node.id]);

  if (!form || !original) {
    return <Dialog title={`节点设置 · ${node.nickname}`} onClose={onClose}>{error ? <Notice tone="bad">{error}</Notice> : <div className="loading"><span className="spinner" />正在读取…</div>}</Dialog>;
  }
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const setEgress = (patch: Partial<Egress>) => setForm({ ...form, egress: { ...form.egress, ...patch } });
  const setPeer = (index: number, patch: Partial<Peer>) => set({ peers: form.peers.map((peer, i) => (i === index ? { ...peer, ...patch } : peer)) });

  const save = () => act(async () => {
    const impacts: string[] = [];
    if (form.role !== original.role) impacts.push(`角色从"${roles[original.role] ?? original.role}"改为"${roles[form.role] ?? form.role}"，发信选择会随之变化。`);
    if (form.priority === 0 && original.priority > 0) impacts.push("优先级改为 0 后，这台机器不再参与发信。");
    if (node.id === data.fleet?.gatewayId && (form.priority === 0 || form.role === "worker")) impacts.push("这台机器是当前发信端，保存后会立即切换，ChatGPT 连接可能短暂中断。");
    const removed = (original.peers ?? []).filter((peer) => !form.peers.some((entry) => entry.id === peer.id));
    if (removed.length) impacts.push(`将断开与 ${removed.map((peer) => peer.nickname || peer.id).join("、")} 的连接；如果主控只能通过这些连接到达本机，保存后会失联。`);
    if (form.egress.listenPort !== original.egress.listenPort) impacts.push("本地代理端口变化后，已经在运行的 shell / Codex 进程仍使用旧端口。");
    if (original.egress.enabled && !form.egress.enabled) impacts.push("停用统一出口后，这台机器的出网请求不再经过 mihomo。");
    form.peers.filter((peer) => peer.url && !/^https:\/\//i.test(peer.url)).forEach((peer) => impacts.push(`连接 ${peer.id} 的地址不是 HTTPS，节点凭据会以明文传输。`));
    if (impacts.length && !(await dialogs.confirm({ title: "确认保存节点设置？", message: <ul className="impact-list">{impacts.map((item) => <li key={item}>{item}</li>)}</ul>, confirmText: "仍然保存", danger: true }))) return false;
    const latest = await api<NodeSettings>("fleet/settings/get", { nodeId: node.id });
    const pick = (value: NodeSettings) => JSON.stringify([value.nickname, value.role, value.priority, value.peers, value.egress]);
    if (pick(latest) !== pick(original) && !(await dialogs.confirm({ title: "设置已在别处被修改", message: "打开此窗口后，这台机器的设置被其他页面或设备修改过。继续保存会覆盖对方的修改。", confirmText: "覆盖保存", danger: true }))) return false;
    await api("fleet/settings/update", {
      nodeId: node.id,
      settings: {
        nickname: form.nickname.trim(), role: form.role, priority: form.priority,
        peers: form.peers.map((peer) => ({ id: peer.id.trim(), nickname: peer.nickname?.trim() ?? "", url: peer.url?.trim() ?? "" })),
        egress: { ...latest.egress, ...form.egress, mihomoConfig: form.egress.mihomoConfig?.trim() || null, controllerUrl: form.egress.controllerUrl?.trim() || null },
      },
    });
    await data.refresh();
    onClose();
  }, "节点设置已更新");

  const eg = form.egress;
  return (
    <Dialog title={`${readOnly ? "最后已知配置" : "节点设置"} · ${node.nickname}`} size="lg" onClose={onClose} locked={busy} footer={<>
      <button type="button" onClick={onClose} disabled={busy}>{readOnly ? "关闭" : "取消"}</button>
      {!readOnly && <button type="button" className="primary" disabled={busy || problems.length > 0} onClick={() => void save()}>{busy ? "正在保存…" : "保存设置"}</button>}
    </>}>
      <fieldset disabled={readOnly || busy} className="form">
        {readOnly && <Notice tone="warn">机器离线，只能查看状态中最后上报的配置；连接列表只有在线时才能读取。</Notice>}
        <div className="form-grid">
          <label>节点昵称<input value={form.nickname} maxLength={120} onChange={(event) => set({ nickname: event.target.value })} /></label>
          <label>节点角色<select value={form.role} onChange={(event) => set({ role: event.target.value })}>{Object.entries(roles).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
          <label>发信优先级（0 为不参选）<input type="number" min={0} max={1000} value={form.priority} onChange={(event) => set({ priority: Number(event.target.value) })} /></label>
          <label>固定节点 ID<input value={node.id} readOnly /></label>
        </div>
        {!readOnly && (
          <section>
            <h3>连接其他机器</h3>
            <p className="fine">服务器填可达的 HTTPS 地址。电脑由自己主动连接时，服务器上的电脑地址留空。</p>
            {form.peers.map((peer, index) => (
              <div className="peer-row" key={index}>
                <input placeholder="节点 ID" aria-label="节点 ID" value={peer.id} onChange={(event) => setPeer(index, { id: event.target.value })} />
                <input placeholder="昵称" aria-label="对端昵称" value={peer.nickname ?? ""} onChange={(event) => setPeer(index, { nickname: event.target.value })} />
                <input placeholder="https://server:7680（可留空）" aria-label="节点地址" value={peer.url ?? ""} onChange={(event) => setPeer(index, { url: event.target.value })} />
                <button type="button" className="icon-btn danger" aria-label="移除连接" onClick={() => set({ peers: form.peers.filter((_, i) => i !== index) })}>×</button>
              </div>
            ))}
            <button type="button" className="sm" onClick={() => set({ peers: [...form.peers, { id: "", nickname: "", url: "" }] })}>＋ 添加连接</button>
          </section>
        )}
        <section>
          <h3>mihomo 与统一出口</h3>
          <div className="form-grid">
            <label className="check span2"><input type="checkbox" checked={eg.enabled} onChange={(event) => setEgress({ enabled: event.target.checked })} />启用统一出口</label>
            <label>QuayMesh 本地代理端口<input type="number" min={1} max={65535} value={eg.listenPort ?? ""} onChange={(event) => setEgress({ listenPort: Number(event.target.value) })} /></label>
            <label>本机 mihomo HTTP/mixed 入口<input type="url" value={eg.proxyUrl ?? ""} onChange={(event) => setEgress({ proxyUrl: event.target.value })} /></label>
            <label>本机 config.yaml 完整路径<input value={eg.mihomoConfig ?? ""} onChange={(event) => setEgress({ mihomoConfig: event.target.value })} /></label>
            <label>mihomo 控制接口（可选）<input type="url" value={eg.controllerUrl ?? ""} onChange={(event) => setEgress({ controllerUrl: event.target.value })} /></label>
            <label>出网探测 URL<input type="url" value={eg.probeUrl ?? ""} onChange={(event) => setEgress({ probeUrl: event.target.value })} /></label>
            <label>恢复回切等待（秒）<input type="number" min={0} max={300} value={(eg.recoveryDelayMs ?? 0) / 1000} onChange={(event) => setEgress({ recoveryDelayMs: Number(event.target.value) * 1000 })} /></label>
            <label className="check span2"><input type="checkbox" checked={Boolean(eg.inheritProxy)} onChange={(event) => setEgress({ inheritProxy: event.target.checked })} />新建 shell / Codex 进程使用统一代理</label>
          </div>
          <p className="fine">CC Switch 的模型、provider 和凭据保持原样。独立运行的 CC Switch 需要把出网代理设为本机 QuayMesh 代理地址。</p>
        </section>
        {problems.length > 0 && !readOnly && <Notice tone="bad"><ul className="impact-list">{problems.map((item) => <li key={item}>{item}</li>)}</ul></Notice>}
      </fieldset>
    </Dialog>
  );
}
