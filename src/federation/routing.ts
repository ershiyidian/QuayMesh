import type { JsonRecord, NodeView, ExportedRoot } from "./types.js";

const PREFIX = "qm:";
/** A workspace handle carries its node; a gateway can recover routing without a database. */
export function workspaceHandle(node: string, local: string): string {
  return `${PREFIX}${encodeURIComponent(node)}:${encodeURIComponent(local)}`;
}
export function parseWorkspaceHandle(value: string): { node: string; local: string } | undefined {
  if (!value.startsWith(PREFIX)) return undefined;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("工作区标识格式错误");
  return { node: decodeURIComponent(parts[0]), local: decodeURIComponent(parts[1]) };
}
export function rootHandle(node: string, root: string): string { return `${node}/${root}`; }
export function selectRoot(nodes: NodeView[], id: string): { node: NodeView; root: ExportedRoot } {
  const exact = nodes.flatMap((node) => node.roots.filter((root) => root.enabled && rootHandle(node.id, root.id) === id).map((root) => ({ node, root })));
  if (exact.length === 1) return exact[0];
  const aliases = nodes.flatMap((node) => node.roots.filter((root) => root.enabled && (root.id === id || root.nickname === id)).map((root) => ({ node, root })));
  if (aliases.length === 1) return aliases[0];
  if (aliases.length > 1) throw new Error(`目录昵称 ${id} 对应多个节点，请使用 workspace_catalog 返回的 root_id。`);
  throw new Error(`目录 ${id} 尚未导出。请使用 workspace_catalog 选择根目录。`);
}
export function catalog(nodes: NodeView[], query = "", includeOffline = true): JsonRecord {
  // 常见的“列出全部”语句不应被当作项目名称关键词过滤。
  const raw = query.toLocaleLowerCase().trim();
  const listAll = /^(?:all|all (?:available )?(?:workspaces|roots|nodes)|全部|所有|所有工作区|全部工作区)$/u.test(raw);
  const words = (listAll ? "" : raw).split(/\s+/).filter(Boolean);
  const roots = nodes.flatMap((node) => node.roots.filter((root) => root.enabled).map((root) => ({
    root_id: rootHandle(node.id, root.id), nickname: root.nickname, description: root.description,
    tags: root.tags, node_id: node.id, node_nickname: node.nickname, online: node.online,
    platform: node.platform, tools: node.tools, providers: node.providers,
  }))).filter((root) => (includeOffline || root.online) && words.every((word) => JSON.stringify(root).toLocaleLowerCase().includes(word)));

  const offlineNodes = nodes.filter((node) => !node.online).map((node) => ({
    node_id: node.id,
    nickname: node.nickname,
    online: false,
    status: "offline",
    lastSeen: node.lastSeen ?? null,
  }));

  return {
    workspaces: roots,
    offline_nodes: offlineNodes,
    instruction: "按任务语义选择 root_id，调用 open_workspace({root_id})，后续复用 workspace_id。数据在所属节点分析。",
  };
}

/** 兼容只显示 MCP text content、忽略 structuredContent 的模型客户端。 */
export function catalogToolSummary(catalogResult: JsonRecord, allResult: JsonRecord): string {
  const selected = catalogResult.workspaces as Array<{
    root_id: string; nickname: string; node_id: string; online: boolean; platform: string;
  }>;
  const all = allResult.workspaces as typeof selected;
  const visible = selected.length ? selected : all;
  const intro = selected.length
    ? `Found ${selected.length} exported workspaces. Available root_id values:`
    : all.length
      ? `No roots match that search. The cluster still exports ${all.length} workspaces; select an existing root_id:`
      : "No exported workspaces are currently known to this Coordinator.";
  const lines = visible.map(root =>
    `- ${root.root_id}: ${root.nickname} (node=${root.node_id}, ${root.online ? "online" : "offline"}, ${root.platform})`);
  return [intro,...lines,
    "Call open_workspace({root_id:\"desktop/main\"}) or another listed root_id, not an invented absolute path.",
    "Cloud is the Coordinator; file access, shell commands, patches and agents must run on an exported worker workspace.",
  ].join("\n");
}
/** Route generated identities without changing file bytes, shell output or agent prose. */
export function routedResult(value: unknown, node: string, options: { textReferences?: boolean; jsonText?: boolean } = {}): unknown {
  const references = new Map<string, string>();
  function identity(id: string, targetNode: string): string { return id.startsWith(PREFIX) ? id : workspaceHandle(targetNode, id); }
  function rewrite(part: unknown, field = "", targetNode = node): unknown {
    if (typeof part === "string") {
      if (field === "workspace_id" || field === "workspaceId") {
        const routed = identity(part, targetNode); references.set(part, routed); return routed;
      }
      if (field === "consolePath" && part.startsWith("/console/")) {
        const url = new URL(part, "http://quaymesh.local"); url.searchParams.set("node", targetNode); return url.pathname + url.search + url.hash;
      }
      return part;
    }
    if (Array.isArray(part)) return part.map((item) => rewrite(item, "", targetNode));
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      const scopedNode = typeof record.node_id === "string" ? record.node_id
        : typeof record.nodeId === "string" ? record.nodeId : targetNode;
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, rewrite(item, key, scopedNode)]));
    }
    return part;
  }
  const result = rewrite(value);
  if (!result || typeof result !== "object") return result;
  const envelope = result as JsonRecord;
  if (options.jsonText && Array.isArray(envelope.content)) envelope.content = envelope.content.map((entry: JsonRecord) => {
    if (entry.type !== "text" || typeof entry.text !== "string") return entry;
    try { const data = JSON.parse(entry.text); return data && typeof data === "object" ? { ...entry, text: JSON.stringify(rewrite(data), null, 2) } : entry; }
    catch { return entry; }
  });
  if (options.textReferences) {
    const replace = (text: string): string => { for (const [from, to] of references) if (from !== to) text = text.replaceAll(from, to); return text; };
    if (Array.isArray(envelope.content)) envelope.content = envelope.content.map((entry: JsonRecord) => entry.type === "text" && typeof entry.text === "string" ? { ...entry, text: replace(entry.text) } : entry);
    const structured = envelope.structuredContent as JsonRecord | undefined;
    if (structured && typeof structured.instruction === "string") structured.instruction = replace(structured.instruction);
  }
  return result;
}
export function chooseGateway(nodes: NodeView[], now = Date.now(), recoveryDelayMs = 0, current?: string): NodeView | undefined {
  const candidates = nodes.filter((node) => node.online && node.priority > 0
    && node.capabilities.egress && node.egress.enabled && node.egress.healthy && !node.egress.draining
    && gatewayCoreStable(node, now, recoveryDelayMs))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const previous = candidates.find((node) => node.id === current);
  if (!previous) return candidates[0];
  const first = candidates[0];
  const availableSince = Math.max(first?.egress.healthySince ?? 0, first?.onlineSince ?? 0);
  if (first && first.id !== previous.id && availableSince && now - availableSince < recoveryDelayMs) return previous;
  return first;
}

function gatewayCoreStable(node: NodeView, now: number, recoveryDelayMs: number): boolean {
  const core = node.components?.find(component => component.id === "core");
  if (!core) return true;
  if (core.crashLoop || core.state === "backoff") return false;
  // Older managers report cumulative restarts without the new crashLoop and
  // stableSince fields. A briefly ready process must not immediately regain
  // gateway priority after thousands of native crashes. Historical restarts
  // stop affecting eligibility after one continuously stable five-minute run.
  if (core.crashLoop === undefined && (core.restarts ?? 0) >= 3) {
    if (core.state !== "ready") return false;
    const availableSince = Math.max(core.startedAt ?? 0, node.onlineSince ?? 0, node.egress.healthySince ?? 0);
    if (!availableSince || now - availableSince < Math.max(300_000, recoveryDelayMs)) return false;
    if (core.observedAt && now - core.observedAt > 45_000) return false;
  }
  return true;
}
