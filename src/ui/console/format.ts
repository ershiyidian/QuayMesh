export const LOCAL = "local";

export const sourceLabels: Record<string, string> = {
  chatgpt_mcp: "ChatGPT → QuayMesh",
  other_mcp: "MCP 主控 → QuayMesh",
  qm_cli: "命令行",
  console: "控制台",
  legacy_unknown: "历史来源待确认",
};

export const stateLabels: Record<string, string> = {
  running: "执行中", queued: "排队中", starting: "启动中", completed: "执行完成", succeeded: "成功",
  failed: "失败", cancelled: "已取消", reconciliation_required: "待核对", needs_attention: "待处理",
  passed: "验收通过", pending: "待验收", not_applicable: "无需验收", active: "未归档", archived: "已归档",
  unknown: "状态未知", archiving: "归档中", restoring: "恢复中", planned: "待确认", executing: "处理中",
  partial: "部分完成", ready: "可执行", skipped: "已跳过", qm_active: "QuayMesh 控制中",
  interrupting: "正在中断", desktop_pending: "等待 Desktop 接管", desktop_owned: "Desktop 已接管",
  terminal: "当前无活动轮次", interrupted: "执行中断，可恢复", expired: "已过期",
};

export const qualities: Record<string, string> = {
  complete: "统计完整", partial: "部分已记录", unavailable: "用量未知", not_used: "未调用 Codex",
};

export const qualityHelp: Record<string, string> = {
  complete: "受管执行与用量边界齐全。",
  partial: "有已记录值，但仍有执行缺少完整用量。",
  unavailable: "没有足够证据，不能写成零。",
  not_used: "确认没有发起 Codex 推理。",
};

export const reasons: Record<string, string> = {
  preview_budget_exhausted: "本次预览时间预算已用完，请缩小所选批次后重新预览",
  unproven_creation: "无法证明由 QuayMesh 创建", unverified_provider_instance: "提供方实例未确认", external_turns_detected: "存在外部续写",
  user_protected: "已设为保留", archive_state_ineligible: "当前归档状态不符合条件", managed_agent_active: "代理仍在执行或排队",
  open_or_unaccepted_work: "关联任务未关闭或未验收", usage_incomplete: "用量尚有缺口", active_execution_claim: "还有执行占用",
  not_archived_by_quaymesh: "没有本系统归档成功的回执", provider_instance_changed: "Codex 账号或实例已变化",
  incomplete_descendant_inventory: "无法完整核查后代会话", provider_project_mismatch: "提供方项目不匹配", provider_thread_active_or_unknown: "提供方仍活动或状态未知",
  unarchived_descendants_require_review: "存在未归档后代，需单独核查", external_or_unmapped_turns: "发现未纳管执行，已保护",
  provider_archive_state_changed: "Codex 中的状态已变化", provider_state_unavailable: "无法读取提供方状态", managed_state_changed_since_preview: "预览后的任务状态已变化",
  provider_state_changed_since_preview: "预览后的会话内容或状态已变化", provider_acknowledgement_or_verification_missing: "请求结果待核对，不会盲目重发",
  unknown_prior_side_effect_not_replayed: "此前操作结果不确定，需要继续核对", externally_changed_or_protected: "外部修改或用户保护", unproven_creation_or_instance: "创建或实例归属不足",
};

export const roles: Record<string, string> = { controller: "主控 / 备用发信", gateway: "首选发信 / 执行", worker: "执行节点" };

export type Tone = "ok" | "info" | "warn" | "bad" | "muted" | "violet";

const TONES: Record<string, Tone> = {
  passed: "ok", succeeded: "ok", completed: "ok",
  running: "info", executing: "info", starting: "info", archiving: "info", restoring: "info", interrupting: "info", qm_active: "info", active: "info",
  pending: "warn", queued: "warn", planned: "warn", partial: "warn", desktop_pending: "warn", ready: "warn",
  failed: "bad", reconciliation_required: "bad", needs_attention: "bad", unknown: "bad",
  interrupted: "warn", skipped: "muted", cancelled: "muted", not_applicable: "muted", terminal: "muted", expired: "muted",
  archived: "violet", desktop_owned: "violet",
};

export const label = (value: string): string => stateLabels[value] ?? value;
export const tone = (value: string): Tone => TONES[value] ?? "muted";

const ACTIVE = new Set(["running", "queued", "starting", "executing"]);
const ATTENTION = new Set(["reconciliation_required", "interrupted", "needs_attention", "unknown"]);
const DONE = new Set(["completed", "succeeded"]);
export const isActive = (status: string): boolean => ACTIVE.has(status);
export const needsAttention = (status: string): boolean => ATTENTION.has(status);
export const isDone = (status: string): boolean => DONE.has(status);

/**
 * 统一时间解析：秒/毫秒时间戳、数字字符串、ISO、SQLite "YYYY-MM-DD HH:MM:SS"（按 UTC）。
 */
export function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
  if (typeof value !== "string") return null;
  if (/^\d+(\.\d+)?$/.test(value)) return parseTime(Number(value));
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function fmtTime(value: unknown, seconds = true): string {
  const t = parseTime(value);
  if (t === null) return "—";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
}

/** 列表内的紧凑格式：今天只显示时分秒，今年显示月日时分，其余显示完整日期。 */
export function fmtCompact(value: unknown): string {
  const t = parseTime(value);
  if (t === null) return "—";
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return fmtTime(t, false);
}

export function tzLabel(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    zone = "";
  }
  return `${zone ? `${zone} · ` : ""}UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function relative(t: number, now = Date.now()): string {
  const diff = now - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (abs < 10_000) return "刚刚";
  if (abs < 60_000) return `${Math.round(abs / 1000)} 秒${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} 小时${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.round(abs / 86_400_000)} 天${suffix}`;
  return fmtTime(t, false);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${pad(s % 60)} 秒`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${pad(m % 60)} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

export const num = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("zh-CN").format(value);

export const compactNum = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function hashIndex(value: string, buckets = 8): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash % buckets;
}

export function providerLabel(provider: unknown): string {
  if (provider && typeof provider === "object") {
    const record = provider as Record<string, unknown>;
    const name = String(record.id ?? record.name ?? "Agent");
    return record.model ? `${name} · ${String(record.model)}` : name;
  }
  return String(provider);
}
