export type NotifyKind = "failed" | "completed" | "offline" | "gateway";

export interface NotifyPrefs {
  enabled: boolean;
  failed: boolean;
  completed: boolean;
  offline: boolean;
  gateway: boolean;
}

const KEY = "quaymesh.notify";
const DEFAULTS: NotifyPrefs = { enabled: false, failed: true, completed: false, offline: true, gateway: true };

export function getNotifyPrefs(): NotifyPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<NotifyPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export function setNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 无法持久化时忽略 */
  }
}

export function notificationSupported(): boolean {
  return typeof Notification !== "undefined";
}

export function notify(kind: NotifyKind, title: string, body: string): void {
  const prefs = getNotifyPrefs();
  if (!prefs.enabled || !prefs[kind] || !notificationSupported() || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: `${kind}:${title}:${body}` });
  } catch {
    /* 部分移动浏览器只允许 Service Worker 发通知 */
  }
}
