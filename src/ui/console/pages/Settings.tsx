import { useState } from "react";
import { api, session } from "../api.js";
import { getNotifyPrefs, notificationSupported, setNotifyPrefs, type NotifyPrefs } from "../notify.js";
import { useData } from "../store.js";
import { setThemePref, useTheme, type ThemePref } from "../theme.js";
import { Badge, CopyButton, Notice, Segmented, useAct, useDialogs, useToast } from "../ui.js";

export function SettingsPage() {
  const data = useData();
  return (
    <div className="stack settings">
      <Appearance />
      <OverviewPreferences />
      <Notifications />
      <DeviceSessions />
      {data.mode === "fleet" && <MihomoSync />}
      <section className="panel">
        <h2>连接与账号</h2>
        <dl className="kv">
          <div><dt>运行模式</dt><dd>{data.mode === "fleet" ? `多机 · ${data.nodes.length} 台机器` : "单机"}</dd></div>
          <div><dt>主控连接</dt><dd>{data.nodeName(data.localNodeId)}</dd></div>
          {data.fleet?.publicMcpUrl && <div><dt>唯一 MCP 地址</dt><dd><code>{data.fleet.publicMcpUrl}</code> <CopyButton text={data.fleet.publicMcpUrl} /></dd></div>}
          <div><dt>登录方式</dt><dd>共享 owner 口令 · 会话仅存于浏览器 Cookie</dd></div>
        </dl>
        <p className="fine">登录会话列表、让其他设备下线、节点凭据轮换需要后端提供接口后在这里开放。</p>
      </section>
    </div>
  );
}

function OverviewPreferences() {
  const [limit, setLimit] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("qm_overview_attention_limit");
      if (raw === "all") return 999;
      const num = Number(raw);
      if (!isNaN(num) && num > 0) return num;
    } catch {}
    return 3;
  });

  const onChange = (newLimit: number) => {
    setLimit(newLimit);
    try {
      localStorage.setItem("qm_overview_attention_limit", newLimit >= 999 ? "all" : String(newLimit));
    } catch {}
  };

  return (
    <section className="panel">
      <h2>总览偏好</h2>
      <div className="form-grid">
        <label>
          状态提醒与近期失败默认显示条数
          <select value={limit >= 999 ? "all" : limit} onChange={(e) => onChange(e.target.value === "all" ? 999 : Number(e.target.value))}>
            <option value={3}>最近 3 条（默认推荐）</option>
            <option value={5}>最近 5 条</option>
            <option value={10}>最近 10 条</option>
            <option value="all">显示全部</option>
          </select>
        </label>
      </div>
      <p className="fine">设置保存于本机浏览器中。也可以直接在总览面板右上角快速切换。</p>
    </section>
  );
}
function Appearance() {
  const { pref } = useTheme();
  return (
    <section className="panel">
      <h2>外观</h2>
      <Segmented<ThemePref> ariaLabel="主题" value={pref} onChange={setThemePref} options={[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]} />
      <p className="fine">仅保存在这台设备的浏览器中。</p>
    </section>
  );
}

function Notifications() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<NotifyPrefs>(getNotifyPrefs);
  const [permission, setPermission] = useState(notificationSupported() ? Notification.permission : "denied");
  const update = (patch: Partial<NotifyPrefs>) => { const next = { ...prefs, ...patch }; setPrefs(next); setNotifyPrefs(next); };
  const enable = async () => {
    if (!notificationSupported()) return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") { update({ enabled: true }); toast("浏览器通知已开启"); }
    else toast("浏览器拒绝了通知权限，请在站点设置中允许。", "bad");
  };
  return (
    <section className="panel">
      <h2>通知</h2>
      {!notificationSupported() ? <Notice tone="warn">当前浏览器不支持桌面通知。</Notice> : !window.isSecureContext ? <Notice tone="warn">浏览器只在 HTTPS 或 localhost 下允许通知。通过内网 IP 访问时无法开启。</Notice> : null}
      <div className="button-row">
        <label className="check"><input type="checkbox" checked={prefs.enabled && permission === "granted"} disabled={permission !== "granted"} onChange={(event) => update({ enabled: event.target.checked })} />开启浏览器通知</label>
        {permission !== "granted" && notificationSupported() && <button type="button" className="sm primary" onClick={() => void enable()}>请求通知权限</button>}
        <Badge tone={permission === "granted" ? "ok" : "muted"}>{permission === "granted" ? "已授权" : permission === "denied" ? "已拒绝" : "未授权"}</Badge>
      </div>
      <div className="check-grid">
        <label className="check"><input type="checkbox" checked={prefs.failed} onChange={(event) => update({ failed: event.target.checked })} />任务失败</label>
        <label className="check"><input type="checkbox" checked={prefs.completed} onChange={(event) => update({ completed: event.target.checked })} />任务执行完成</label>
        <label className="check"><input type="checkbox" checked={prefs.offline} onChange={(event) => update({ offline: event.target.checked })} />机器离线</label>
        <label className="check"><input type="checkbox" checked={prefs.gateway} onChange={(event) => update({ gateway: event.target.checked })} />发信端切换</label>
      </div>
      <p className="fine">通知在控制台前台刷新时生效；后台标签页恢复可见后检查变化。Webhook / Telegram / ntfy 推送需要后端支持。</p>
    </section>
  );
}

const SECRET = /^(\s*[-\w.]*(password|secret|uuid|token|private-key|psk|auth)[-\w.]*\s*:\s*)(.+)$/i;
const mask = (text: string) => text.split("\n").map((line) => line.replace(SECRET, (_, key: string) => `${key}••••••`)).join("\n");

function MihomoSync() {
  const data = useData();
  const dialogs = useDialogs();
  const { busy, act } = useAct();
  const nodes = data.fleet?.nodes ?? [];
  const online = nodes.filter((node) => node.online);
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [source, setSource] = useState(online[0]?.id ?? "");
  const [targets, setTargets] = useState<Set<string>>(() => new Set(online.map((node) => node.id)));
  const [reload, setReload] = useState(true);
  const [results, setResults] = useState<{ nodeId: string; saved?: boolean; reloaded?: boolean; error?: string; note?: string }[] | null>(null);
  const offline = nodes.filter((node) => !node.online);
  const lines = text?.split("\n").length ?? 0;

  const sync = () => act(async () => {
    const chosen = online.filter((node) => targets.has(node.id));
    if (!chosen.length) throw new Error("请选择至少一台在线目标机器。");
    if (text === null && !online.some((node) => node.id === source)) throw new Error("来源机器已离线，请重新选择。");
    const ok = await dialogs.confirm({
      title: "确认同步 config.yaml？",
      message: <div>
        <p>来源：{text !== null ? `上传文件 ${fileName}（${lines} 行）` : `${data.nodeName(source)} 当前的配置`}</p>
        <p>将覆盖以下机器上的文件：</p>
        <ul className="impact-list">{chosen.map((node) => <li key={node.id}>{node.nickname}：<code>{node.egress.mihomoConfig ?? "未配置路径"}</code></li>)}</ul>
        {offline.length > 0 && <p className="warn">以下机器离线，不会同步：{offline.map((node) => node.nickname).join("、")}</p>}
        <p className="fine">目标机器上没有自动备份与 mihomo -t 校验（需后端支持），请确认内容无误。</p>
      </div>,
      confirmText: "同步", danger: true,
    });
    if (!ok) return false;
    const result = await api<{ results?: typeof results }>("fleet/mihomo/sync", { ...(text !== null ? { text } : { sourceNodeId: source }), nodeIds: chosen.map((node) => node.id), reload });
    setResults(result.results ?? []);
    await data.refresh();
  }, "同步请求已完成");

  return (
    <section className="panel">
      <h2>统一 mihomo 配置</h2>
      <p className="fine">将同一份 config.yaml 分发到各机器设置中的配置路径。发信端按优先级与出口连通性选择。配置内容只通过节点连接传输，不出现在工具目录和任务输出中。</p>
      <div className="form-grid">
        <label>从文件导入
          <input type="file" accept=".yaml,.yml,text/yaml" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) { setText(null); setFileName(""); return; }
            setText(await file.text());
            setFileName(file.name);
          }} />
        </label>
        <label>或使用某台机器当前的配置
          <select value={source} disabled={text !== null} onChange={(event) => setSource(event.target.value)}>
            {online.map((node) => <option key={node.id} value={node.id}>{node.nickname}</option>)}
          </select>
        </label>
      </div>
      {text !== null && (
        <details className="yaml-preview" open>
          <summary>预览 {fileName} · {lines} 行（敏感字段已遮盖）<button type="button" className="sm ghost" onClick={() => { setText(null); setFileName(""); }}>清除文件</button></summary>
          <pre>{mask(text).split("\n").slice(0, 400).join("\n")}{lines > 400 ? `\n… 其余 ${lines - 400} 行未显示` : ""}</pre>
        </details>
      )}
      <h3>目标机器</h3>
      <ul className="target-list">
        {nodes.map((node) => (
          <li key={node.id}>
            <label className="check">
              <input type="checkbox" disabled={!node.online} checked={node.online && targets.has(node.id)}
                onChange={(event) => setTargets((current) => { const next = new Set(current); if (event.target.checked) next.add(node.id); else next.delete(node.id); return next; })} />
              {node.nickname}
            </label>
            <code>{node.egress.mihomoConfig ?? "未配置路径"}</code>
            {!node.online && <Badge tone="muted">离线 · 未同步</Badge>}
          </li>
        ))}
      </ul>
      <label className="check"><input type="checkbox" checked={reload} onChange={(event) => setReload(event.target.checked)} />同步后通过本机控制接口加载配置</label>
      <div className="button-row"><button type="button" className="primary" disabled={busy || !online.some((node) => targets.has(node.id)) || (text === null && !online.some((node) => node.id === source))} onClick={() => void sync()}>{busy ? "正在同步…" : "同步配置"}</button></div>
      {results && (
        <ul className="row-list sync-results">
          {results.map((entry) => (
            <li key={entry.nodeId}>
              <strong>{data.nodeName(entry.nodeId)}</strong>
              {entry.saved ? <Badge tone="ok">{entry.reloaded ? "已保存并加载" : "已保存"}</Badge> : <Badge tone="bad">保存失败</Badge>}
              {(entry.error || entry.note) && <span className="muted">{entry.error || entry.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceSessions() {
  const dialogs = useDialogs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    const accepted = await dialogs.confirm({
      title: "撤销所有 Console 设备会话",
      message: "这会立刻退出每一台已登录的浏览器、PWA 和桌面客户端。只有明确确认才会执行，不能由刷新或重试触发。",
      confirmText: "撤销全部会话",
      danger: true,
    });
    if (!accepted) return;
    setBusy(true);
    try {
      await api("sessions/revoke-all", {});
      session.setCsrf(null);
      window.location.assign(window.location.pathname);
    } catch (error) {
      toast(error instanceof Error ? error.message : "撤销失败", "bad");
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>登录设备</h2>
      <p className="fine">会话保存在服务器数据库中，只存令牌哈希和独立 CSRF。管理口令不会写入浏览器存储、注册表或日志。</p>
      <button type="button" className="danger" disabled={busy} onClick={() => void revoke()}>撤销所有 Console 设备会话</button>
    </section>
  );
}

