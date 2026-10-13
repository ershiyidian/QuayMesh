import { useMemo, useSyncExternalStore } from "react";

export const VIEWS = ["overview", "tasks", "changes", "sessions", "machines", "workspaces", "activity", "usage", "settings"] as const;
export type View = (typeof VIEWS)[number];

export interface Route {
  view: View;
  params: URLSearchParams;
  get: (key: string) => string;
}

export type Patch = Record<string, string | number | null | undefined | false>;

const EVENT = "quaymesh:navigate";

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(EVENT, callback);
  };
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const raw = params.get("view");
  const view = (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as View) : "overview";
  return { view, params, get: (key) => params.get(key) ?? "" };
}

export function useRoute(): Route {
  const search = useSyncExternalStore(subscribe, () => location.search);
  return useMemo(() => parseRoute(search), [search]);
}

/** 生成站内地址。所有状态都放在查询参数里，服务端无需额外的回退路由。 */
export function routeHref(patch: Patch, reset = false): string {
  const params = reset ? new URLSearchParams() : new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "" || value === false) params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}`;
}

export function navigate(patch: Patch, options: { replace?: boolean; reset?: boolean } = {}): void {
  const href = routeHref(patch, options.reset);
  if (href === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  window.dispatchEvent(new Event(EVENT));
}

export function execParam(node: string, project: string, run: string): string {
  return [node, project, run].map(encodeURIComponent).join("/");
}

export function parseExecParam(value: string): { node: string; project: string; run: string } | null {
  if (!value) return null;
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  try {
    const [node, project, run] = parts.map(decodeURIComponent);
    return project && run ? { node, project, run } : null;
  } catch {
    return null;
  }
}

/** 旧版 console 链接（?node=&project=&run=）迁移到统一路由。 */
export function migrateLegacyLocation(): void {
  const params = new URLSearchParams(location.search);
  if (params.has("view")) return;
  const run = params.get("run");
  const project = params.get("project");
  const node = params.get("node");
  if (!run && !project && !node) return;
  const next = new URLSearchParams();
  next.set("view", run || project ? "tasks" : "machines");
  if (node) next.set(run || project ? "node" : "machine", node);
  if (node && !(run || project)) next.set("node", node);
  if (project) next.set("project", project);
  if (run && project) next.set("exec", execParam(node ?? "", project, run));
  history.replaceState(null, "", `${location.pathname}?${next}`);
}
