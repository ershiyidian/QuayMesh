import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, AUTHENTICATED, errorText, isAuthError, session } from "./api.js";
import { isActive, isDone, LOCAL, parseTime } from "./format.js";
import { rangeDays } from "./validation.js";
import { notify } from "./notify.js";
import { useRoute } from "./router.js";
import type { FleetNode, FleetStatus, NodeProjects, Project, Receipt, RunBucket, RunRow, ScopedProject } from "./types.js";

export interface ScopeNode { id: string; name: string; online: boolean; local: boolean; fleet?: FleetNode }
export interface RunError { key: string; nodeId: string; projectId: string; message: string }

interface DataValue {
  mode: "unknown" | "fleet" | "single";
  fleet: FleetStatus | null;
  fleetError: string | null;
  fleetAt: number | null;
  localNodeId: string;
  nodes: ScopeNode[];
  nodeName: (id: string) => string;
  projects: Record<string, NodeProjects>;
  allProjects: ScopedProject[];
  scopedProjects: ScopedProject[];
  scopeNode: string;
  scopeProject: string;
  runs: RunRow[];
  runErrors: RunError[];
  runsLoading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

const DataContext = createContext<DataValue | null>(null);

export function useData(): DataValue {
  const value = useContext(DataContext);
  if (!value) throw new Error("DataProvider 缺失");
  return value;
}

function normalizeStatus(status: FleetStatus): FleetStatus {
  return {
    ...status,
    events: Array.isArray(status.events) ? status.events : [],
    nodes: (status.nodes ?? []).map((node) => ({
      ...node,
      nickname: node.nickname || node.id,
      roots: (node.roots ?? []).map((root) => ({ ...root, tags: root.tags ?? [] })),
      providers: node.providers ?? [],
      health: { ...(node.health ?? {}), activeCalls: node.health?.activeCalls ?? 0, gpus: node.health?.gpus ?? [] },
      egress: { ...(node.egress ?? {}), enabled: node.egress?.enabled ?? false },
    })),
  };
}

function runQuery(source: string, status: string, range: string, offset?: number): string {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (status) params.set("status", status);
  const days = rangeDays(range);
  if (days) params.set("after", new Date(Date.now() - days * 86_400_000).toISOString());
  if (offset !== undefined) params.set("offset", String(offset));
  return params.toString();
}

interface RunsResponse { entries?: Receipt[]; nextOffset?: number | null; stats?: Project | null }

export function DataProvider({ children }: { children: ReactNode }) {
  const route = useRoute();
  const [mode, setMode] = useState<DataValue["mode"]>("unknown");
  const [fleet, setFleet] = useState<FleetStatus | null>(null);
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [fleetAt, setFleetAt] = useState<number | null>(null);
  const [projects, setProjects] = useState<Record<string, NodeProjects>>({});
  const [buckets, setBuckets] = useState<Record<string, RunBucket>>({});
  const [runsLoading, setRunsLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const nodes = useMemo<ScopeNode[]>(() => (mode === "fleet" && fleet
    ? fleet.nodes.map((node) => ({ id: node.id, name: node.nickname, online: node.online, local: node.id === fleet.localNodeId, fleet: node }))
    : [{ id: LOCAL, name: "本机", online: true, local: true }]), [mode, fleet]);
  const localNodeId = mode === "fleet" && fleet?.localNodeId ? fleet.localNodeId : LOCAL;
  const nodeName = useCallback((id: string) => nodes.find((node) => node.id === id)?.name ?? (!id || id === LOCAL ? "本机" : id), [nodes]);

  const allProjects = useMemo<ScopedProject[]>(() => nodes.flatMap((node) =>
    (projects[node.id]?.projects ?? []).map((project) => ({ ...project, nodeId: node.id, nodeName: node.name }))), [nodes, projects]);
  const scopeNode = nodes.some((node) => node.id === route.get("node")) ? route.get("node") : "";
  const scopeProject = route.get("project");
  const scopedProjects = useMemo(() => allProjects.filter((project) =>
    (!scopeNode || project.nodeId === scopeNode) && (!scopeProject || project.id === scopeProject)), [allProjects, scopeNode, scopeProject]);

  const source = route.get("source");
  const status = route.get("status");
  const range = rangeDays(route.get("range"))?.toString() ?? "all";
  const queryKey = `${source}|${status}|${range}`;
  const filterVersion = useRef({ key: queryKey, value: 0 });
  if (filterVersion.current.key !== queryKey) filterVersion.current = { key: queryKey, value: filterVersion.current.value + 1 };
  const targetsKey = scopedProjects.map((project) => `${project.nodeId}/${project.id}`).join(",");

  const live = useRef({ nodes, scopedProjects, source, status, range, queryKey });
  live.current = { nodes, scopedProjects, source, status, range, queryKey };
  const bucketsRef = useRef(buckets);
  bucketsRef.current = buckets;

  // 按请求键去重：慢节点只阻塞自己，不拖累其他节点和手动刷新。
  const inflight = useRef(new Set<string>());
  const guarded = useCallback(async (key: string, operation: () => Promise<void>) => {
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    try {
      await operation();
    } finally {
      inflight.current.delete(key);
    }
  }, []);

  const refreshFleet = useCallback(() => guarded("fleet", async () => {
    try {
      const result = await api<FleetStatus>("fleet/status");
      if (result?.enabled) {
        const normalized = normalizeStatus(result);
        session.setLocalNode(normalized.localNodeId ?? null);
        setFleet(normalized);
        setMode("fleet");
      } else {
        session.setLocalNode(null);
        setFleet(null);
        setMode("single");
      }
      setFleetError(null);
      setFleetAt(Date.now());
    } catch (error) {
      if (isAuthError(error)) return;
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        setFleet(null);
        setMode("single");
        return;
      }
      setFleetError(errorText(error, "读取机器状态失败"));
      setMode((current) => (current === "unknown" ? "single" : current));
    }
  }), [guarded]);

  const refreshProjects = useCallback(async () => {
    await Promise.all(live.current.nodes.filter((node) => node.online).map((node) => guarded(`p:${node.id}`, async () => {
      try {
        const result = await api<{ projects?: Project[] }>("projects", undefined, node.id);
        setProjects((prev) => ({ ...prev, [node.id]: { nodeId: node.id, projects: result.projects ?? [], fetchedAt: Date.now() } }));
      } catch (error) {
        if (isAuthError(error)) return;
        setProjects((prev) => ({
          ...prev,
          [node.id]: { nodeId: node.id, projects: prev[node.id]?.projects ?? [], fetchedAt: prev[node.id]?.fetchedAt, error: errorText(error, "读取项目失败") },
        }));
      }
    })));
  }, [guarded]);

  const refreshRuns = useCallback(async () => {
    const version = filterVersion.current.value;
    const { scopedProjects: targets, source: s, status: st, range: r, queryKey: qk } = live.current;
    if (!targets.length) {
      setUpdatedAt(Date.now());
      return;
    }
    setRunsLoading(true);
    await Promise.all(targets.map((project) => {
      const key = `${project.nodeId}/${project.id}`;
      return guarded(`r:${version}:${key}`, async () => {
        if (!live.current.nodes.find((node) => node.id === project.nodeId)?.online) return;
        try {
          const pages = bucketsRef.current[key]?.pages ?? 1;
          let offset: number | undefined;
          let nextOffset: number | null = null;
          let stats: Project | null = null;
          const entries = new Map<string, Receipt>();
          for (let page = 0; page < pages; page += 1) {
            const result = await api<RunsResponse>(`projects/${encodeURIComponent(project.id)}/runs?${runQuery(s, st, r, offset)}`, undefined, project.nodeId);
            if (live.current.queryKey !== qk || filterVersion.current.value !== version) return;
            for (const entry of result.entries ?? []) entries.set(entry.workRunId, entry);
            stats = result.stats ?? stats;
            nextOffset = result.nextOffset ?? null;
            if (nextOffset === null || nextOffset === offset) break;
            offset = nextOffset;
          }
          setBuckets((prev) => ({ ...prev, [key]: { nodeId: project.nodeId, projectId: project.id,
            entries: [...entries.values()], nextOffset, stats, pages, fetchedAt: Date.now() } }));
        } catch (error) {
          if (isAuthError(error) || live.current.queryKey !== qk || filterVersion.current.value !== version) return;
          setBuckets((prev) => ({
            ...prev,
            [key]: { ...(prev[key] ?? { nodeId: project.nodeId, projectId: project.id, entries: [], nextOffset: null, stats: null, pages: 1 }), error: errorText(error, "读取任务失败") },
          }));
        }
      });
    }));
    if (filterVersion.current.value === version) { setRunsLoading(false); setUpdatedAt(Date.now()); }
  }, [guarded]);

  const loadMore = useCallback(() => guarded(`more:${filterVersion.current.value}`, async () => {
    const version = filterVersion.current.value;
    const { scopedProjects: targets, source: s, status: st, range: r, queryKey: qk } = live.current;
    await Promise.all(targets.map(async (project) => {
      const key = `${project.nodeId}/${project.id}`;
      const bucket = bucketsRef.current[key];
      if (!bucket || bucket.nextOffset === null || !live.current.nodes.find((node) => node.id === project.nodeId)?.online) return;
      try {
        const result = await api<RunsResponse>(`projects/${encodeURIComponent(project.id)}/runs?${runQuery(s, st, r, bucket.nextOffset)}`, undefined, project.nodeId);
        if (live.current.queryKey !== qk || filterVersion.current.value !== version) return;
        setBuckets((prev) => {
          const old = prev[key];
          if (!old) return prev;
          const ids = new Set(old.entries.map((entry) => entry.workRunId));
          return { ...prev, [key]: { ...old, entries: [...old.entries, ...(result.entries ?? []).filter((entry) => !ids.has(entry.workRunId))], nextOffset: result.nextOffset === bucket.nextOffset ? null : result.nextOffset ?? null, pages: old.pages + 1, error: undefined } };
        });
      } catch (error) {
        if (!isAuthError(error) && filterVersion.current.value === version) setBuckets((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], error: errorText(error) } } : prev));
      }
    }));
  }), [guarded]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshFleet(), refreshProjects(), refreshRuns()]);
  }, [refreshFleet, refreshProjects, refreshRuns]);

  const nodesKey = nodes.map((node) => `${node.id}:${node.online}`).join(",");
  useEffect(() => { void refreshFleet(); }, [refreshFleet]);
  useEffect(() => { if (mode !== "unknown") void refreshProjects(); }, [mode, nodesKey, refreshProjects]);
  useEffect(() => { setBuckets({}); }, [queryKey]);
  useEffect(() => { if (mode !== "unknown") void refreshRuns(); }, [mode, queryKey, targetsKey, refreshRuns]);
  useEffect(() => {
    const last = { fleet: 0, projects: 0, runs: 0 };
    const tick = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - last.fleet >= 10_000) { last.fleet = now; void refreshFleet(); }
      if (now - last.projects >= 60_000) { last.projects = now; void refreshProjects(); }
      const active = Object.values(bucketsRef.current).some((bucket) => bucket.entries.some((entry) => isActive(entry.executionStatus)));
      const runsInterval = active || route.view === "tasks" ? 10_000 : 60_000;
      if (now - last.runs >= runsInterval) { last.runs = now; void refreshRuns(); }
    };
    const timer = window.setInterval(tick, 1000);
    const onVisible = () => { if (!document.hidden) { last.fleet = 0; last.projects = 0; last.runs = 0; tick(); } };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(AUTHENTICATED, tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(AUTHENTICATED, tick);
    };
  }, [refreshFleet, refreshProjects, refreshRuns, route.view]);

  const runs = useMemo<RunRow[]>(() => {
    const rows: RunRow[] = [];
    for (const project of scopedProjects) {
      const bucket = buckets[`${project.nodeId}/${project.id}`];
      if (!bucket) continue;
      for (const entry of bucket.entries) {
        rows.push({
          ...entry,
          nodeId: project.nodeId,
          projectName: project.name,
          key: `${project.nodeId}/${project.id}/${entry.workRunId}`,
          startMs: parseTime(entry.startedAt ?? entry.createdAt),
          endMs: parseTime(entry.finishedAt),
        });
      }
    }
    return rows.sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0));
  }, [scopedProjects, buckets]);

  const runErrors = useMemo<RunError[]>(() => Object.entries(buckets)
    .filter(([, bucket]) => bucket.error && scopedProjects.some((project) => project.id === bucket.projectId && project.nodeId === bucket.nodeId))
    .map(([key, bucket]) => ({ key, nodeId: bucket.nodeId, projectId: bucket.projectId, message: bucket.error ?? "" })), [buckets, scopedProjects]);
  const hasMore = scopedProjects.some((project) => (buckets[`${project.nodeId}/${project.id}`]?.nextOffset ?? null) !== null);

  // 浏览器通知：任务状态变化、节点掉线、发信端切换。
  const previousRuns = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const current = new Map(runs.map((run) => [run.key, run.executionStatus]));
    const previous = previousRuns.current;
    previousRuns.current = current;
    if (!previous) return;
    for (const run of runs) {
      const before = previous.get(run.key);
      if (!before || before === run.executionStatus) continue;
      if (run.executionStatus === "failed") notify("failed", `任务失败 · ${nodeName(run.nodeId)}`, run.title);
      else if (isDone(run.executionStatus) && isActive(before)) notify("completed", `任务完成 · ${nodeName(run.nodeId)}`, run.title);
    }
  }, [runs, nodeName]);
  const previousFleet = useRef<FleetStatus | null>(null);
  useEffect(() => {
    const previous = previousFleet.current;
    previousFleet.current = fleet;
    if (!previous || !fleet) return;
    for (const node of fleet.nodes) {
      if (previous.nodes.find((entry) => entry.id === node.id)?.online && !node.online) notify("offline", "节点离线", node.nickname);
    }
    if (previous.gatewayId !== fleet.gatewayId) {
      notify("gateway", "发信端已切换", fleet.gatewayId ? `当前：${nodeName(fleet.gatewayId)}` : "暂无可用发信端");
    }
  }, [fleet, nodeName]);

  const value: DataValue = {
    mode, fleet, fleetError, fleetAt, localNodeId, nodes, nodeName, projects, allProjects, scopedProjects,
    scopeNode, scopeProject, runs, runErrors, runsLoading, hasMore, loadMore, updatedAt, refresh,
  };
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
