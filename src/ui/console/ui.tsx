import {
  createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore,
  type MouseEvent, type ReactNode,
} from "react";
import { createElement, type IconNode } from "lucide";
import { errorText, isAuthError } from "./api.js";
import {
  duration, fmtCompact, fmtTime, hashIndex, label, num, parseTime, qualities, relative, tone, tzLabel, type Tone,
} from "./format.js";
import { navigate, routeHref, type Patch } from "./router.js";
import type { DiffStat, Usage } from "./types.js";

/* ---------- 共享时钟：运行中的计时每秒刷新，相对时间每 30 秒刷新 ---------- */
function makeTicker(interval: number) {
  const listeners = new Set<() => void>();
  let now = Date.now();
  let timer: number | undefined;
  return (callback: () => void) => {
    listeners.add(callback);
    if (timer === undefined) {
      timer = window.setInterval(() => {
        now = Date.now();
        listeners.forEach((listener) => listener());
      }, interval);
    }
    return () => {
      listeners.delete(callback);
      if (!listeners.size && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  };
}
const fastTicker = makeTicker(1000);
const slowTicker = makeTicker(30_000);
export const useNow = (): number => useSyncExternalStore(fastTicker, () => Math.floor(Date.now() / 1000) * 1000);
export const useSlowNow = (): number => useSyncExternalStore(slowTicker, () => Math.floor(Date.now() / 30_000) * 30_000);

/* ---------- 图标 ---------- */
export function Icon({ icon, size = 16 }: { icon: IconNode; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.replaceChildren(createElement(icon, { width: size, height: size, "aria-hidden": "true", class: "ico" }));
  }, [icon, size]);
  return <span ref={ref} className="ico-wrap" aria-hidden="true" />;
}

/* ---------- 基础展示 ---------- */
export function Badge({ value = "", children, tone: forced }: { value?: string; children?: ReactNode; tone?: Tone }) {
  return <span className={`badge tone-${forced ?? tone(value)}`}>{children ?? label(value)}</span>;
}

function RelativeText({ t }: { t: number }) {
  const now = useSlowNow();
  return <small className="rel">{relative(t, Math.max(now, Date.now()))}</small>;
}

export function TimeText({ value, compact = false, rel = false }: { value: unknown; compact?: boolean; rel?: boolean }) {
  const t = parseTime(value);
  if (t === null) return <span className="muted">—</span>;
  return (
    <time className="time" dateTime={new Date(t).toISOString()} title={`${fmtTime(t)}（${tzLabel()}）\n${relative(t)}`}>
      <span>{compact ? fmtCompact(t) : fmtTime(t)}</span>
      {rel && <RelativeText t={t} />}
    </time>
  );
}

function LiveElapsed({ start }: { start: number }) {
  const now = useNow();
  return <span className="elapsed live" title="实时计时"><i className="pulse" />{duration(Math.max(now, Date.now()) - start)}</span>;
}

export function Elapsed({ start, end, active }: { start: number | null; end: number | null; active: boolean }) {
  if (start === null) return <span className="muted">—</span>;
  if (active && end === null) return <LiveElapsed start={start} />;
  if (end === null) return <span className="muted">—</span>;
  return <span className="elapsed">{duration(end - start)}</span>;
}

export function TokenValue({ usage, compact = false }: { usage: Usage; compact?: boolean }) {
  const reason = usage.usageQualityReason ?? (usage.missingExecutions ? `${usage.missingExecutions} 个执行缺少完整用量` : "");
  return (
    <span className={`token ${compact ? "compact" : ""}`} title={reason || qualities[usage.usageStatus]}>
      <strong>{num(usage.codexUsage?.totalTokens)}</strong>
      {!compact && <small>Token</small>}
      <span className={`quality q-${usage.usageStatus}`}>{qualities[usage.usageStatus] ?? usage.usageStatus}</span>
    </span>
  );
}

export function DiffStatText({ stat }: { stat?: DiffStat | null }) {
  if (!stat) return <span className="muted" title="后端尚未上报改动统计">—</span>;
  if (!stat.files) return <span className="muted">无改动</span>;
  return (
    <span className="diffstat">
      <span className="add">+{num(stat.additions)}</span>
      <span className="del">−{num(stat.deletions)}</span>
      <small>{stat.files} 个文件</small>
    </span>
  );
}

export function NodeTag({ id, name, online }: { id: string; name: string; online?: boolean }) {
  return (
    <span className={`node-tag c${hashIndex(id)}`} title={`节点 ${id}`}>
      {online !== undefined && <i className={`dot ${online ? "on" : "off"}`} />}
      {name}
    </span>
  );
}

export function Empty({ icon = "◇", title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone: t = "info", children, action }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; action?: ReactNode }) {
  return <div className={`notice n-${t}`} role={t === "bad" ? "alert" : "status"}><div>{children}</div>{action}</div>;
}

export function Meter({ value, max = 100, tone: t }: { value: number | null | undefined; max?: number; tone?: Tone }) {
  const pct = value === null || value === undefined || !max ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const auto: Tone = pct > 90 ? "bad" : pct > 75 ? "warn" : "ok";
  return <span className={`meter tone-${t ?? auto}`} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></span>;
}

export function Link({ to, reset = false, className, children, title }: { to: Patch; reset?: boolean; className?: string; children: ReactNode; title?: string }) {
  const href = routeHref(to, reset);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to, { reset });
  };
  return <a href={href} onClick={onClick} className={className} title={title}>{children}</a>;
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T; options: [T, string][]; onChange: (value: T) => void; ariaLabel: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map(([key, text]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "on" : ""} onClick={() => onChange(key)}>{text}</button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: [T, string, number?][]; onChange: (value: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([key, text, count]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} className={value === key ? "on" : ""} onClick={() => onChange(key)}>
          {text}{count ? <span className="count">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ---------- 复制：HTTPS 以外（内网 IP）自动降级 ---------- */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续降级 */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function CopyButton({ text, label: text2 = "复制", className = "sm ghost" }: { text: string; label?: string; className?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={className} title={text} onClick={async (event) => {
      event.stopPropagation();
      const ok = await copyText(text);
      toast(ok ? `已复制 ${text.length > 48 ? `${text.slice(0, 48)}…` : text}` : "复制失败，请手动选择文本", ok ? "ok" : "bad");
    }}>{text2}</button>
  );
}

/* ---------- 对话框与抽屉（原生 dialog，自带焦点圈定与 Esc） ---------- */
export function Dialog({ title, onClose, locked = false, size = "md", children, footer }: {
  title: string; onClose: () => void; locked?: boolean; size?: "sm" | "md" | "lg" | "drawer"; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog d-${size}`}
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); if (!locked) onClose(); }}
      onMouseDown={(event) => { if (event.target === ref.current && !locked) onClose(); }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose} disabled={locked}>×</button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

/* ---------- 提示条：同一消息合并计数，不刷屏 ---------- */
type ToastTone = "ok" | "bad" | "info";
interface ToastItem { id: number; message: string; tone: ToastTone; count: number }
const ToastContext = createContext<(message: string, tone?: ToastTone) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = layer.current;
    if (!node || !node.showPopover) return;
    if (node.matches(":popover-open")) node.hidePopover();
    if (items.length) node.showPopover();
  }, [items]);
  const timers = useRef(new Map<number, number>());
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);
  const schedule = useCallback((id: number, t: ToastTone) => {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(id, window.setTimeout(() => dismiss(id), t === "bad" ? 9000 : 4000));
  }, [dismiss]);
  const push = useCallback((message: string, t: ToastTone = "ok") => {
    setItems((prev) => {
      const same = prev.find((item) => item.message === message && item.tone === t);
      if (same) {
        schedule(same.id, t);
        return prev.map((item) => (item === same ? { ...item, count: item.count + 1 } : item));
      }
      const id = Date.now() + Math.random();
      schedule(id, t);
      return [...prev.slice(-3), { id, message, tone: t, count: 1 }];
    });
  }, [schedule]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" ref={layer} popover="manual" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast t-${item.tone}`} role={item.tone === "bad" ? "alert" : "status"}>
            <span>{item.message}{item.count > 1 && <b className="toast-count">×{item.count}</b>}</span>
            <button type="button" className="icon-btn" aria-label="关闭提示" onClick={() => dismiss(item.id)}>×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- 应用内确认/输入框，替代 window.confirm / prompt ---------- */
interface ConfirmOptions { title: string; message?: ReactNode; confirmText?: string; danger?: boolean }
interface PromptOptions extends ConfirmOptions { placeholder?: string; multiline?: boolean; initial?: string }
type Pending =
  | ({ kind: "confirm"; resolve: (value: boolean) => void } & ConfirmOptions)
  | ({ kind: "prompt"; resolve: (value: string | null) => void } & PromptOptions);

const DialogsContext = createContext<{
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}>({ confirm: async () => false, prompt: async () => null });
export const useDialogs = () => useContext(DialogsContext);

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ kind: "confirm", resolve, ...options })), []);
  const prompt = useCallback((options: PromptOptions) => new Promise<string | null>((resolve) => {
    setValue(options.initial ?? "");
    setPending({ kind: "prompt", resolve, ...options });
  }), []);
  const close = (accepted: boolean) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(accepted);
    else pending.resolve(accepted ? value.trim() || null : null);
    setPending(null);
  };
  return (
    <DialogsContext.Provider value={{ confirm, prompt }}>
      {children}
      {pending && (
        <Dialog title={pending.title} size="sm" onClose={() => close(false)} footer={<>
          <button type="button" onClick={() => close(false)}>取消</button>
          <button type="button" className={pending.danger ? "danger solid" : "primary"} onClick={() => close(true)} disabled={pending.kind === "prompt" && !value.trim()}>{pending.confirmText ?? "确认"}</button>
        </>}>
          {pending.message && <div className="confirm-message">{pending.message}</div>}
          {pending.kind === "prompt" && (pending.multiline
            ? <textarea autoFocus rows={5} value={value} placeholder={pending.placeholder} onChange={(event) => setValue(event.target.value)} />
            : <input autoFocus value={value} placeholder={pending.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && value.trim()) close(true); }} />)}
        </Dialog>
      )}
    </DialogsContext.Provider>
  );
}

/* ---------- 写操作封装：统一忙碌态与错误提示 ---------- */
export function useAct() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const act = useCallback(async (operation: () => Promise<unknown>, success?: string): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    try {
      const result = await operation();
      if (result === false) return false;
      if (success) toast(success);
      return true;
    } catch (error) {
      if (!isAuthError(error)) toast(errorText(error), "bad");
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, [toast]);
  return { busy, act };
}
