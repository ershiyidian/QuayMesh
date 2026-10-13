import { needsAttention } from "./format.js";
import { execParam, navigate } from "./router.js";
import type { useData } from "./store.js";

interface AttentionItem {
  key: string;
  tone: "bad" | "warn";
  title: string;
  detail: string;
  action: () => void;
  actionText: string;
}

export function getAttentionItems(data: ReturnType<typeof useData>): AttentionItem[] {
  const dayAgo = Date.now() - 86_400_000;
  const items: AttentionItem[] = [];
  for (const run of data.runs) {
    const open = () => navigate({ exec: execParam(run.nodeId, run.projectId, run.workRunId), dtab: null });
    if (needsAttention(run.executionStatus)) {
      items.push({ key: `a:${run.key}`, tone: "bad", title: `待核对：${run.title}`,
        detail: `${data.nodeName(run.nodeId)} · ${run.projectName}${run.attentionReason ? ` · ${run.attentionReason}` : ""}`, action: open, actionText: "查看" });
    } else if (run.executionStatus === "failed" && (run.startMs ?? 0) > dayAgo) {
      items.push({ key: `f:${run.key}`, tone: "bad", title: `近期失败：${run.title}`,
        detail: `${data.nodeName(run.nodeId)} · ${run.projectName}`, action: open, actionText: "查看" });
    }
  }
  for (const node of data.fleet?.nodes ?? []) {
    const open = () => navigate({ view: "machines", machine: node.id }, { reset: true });
    if (!node.online) {
      items.push({ key: `n:${node.id}`, tone: "warn", title: `机器离线：${node.nickname}`,
        detail: "该机器的任务与目录暂不可用，显示的是最后已知数据。", action: open, actionText: "查看机器" });
    } else if (node.egress.enabled && node.egress.healthy === false) {
      items.push({ key: `e:${node.id}`, tone: "warn", title: `外网连接异常：${node.nickname}`,
        detail: node.role === "worker" ? "该节点通过统一出口访问外网的检查失败，请查看节点连接。" : "主控的代理出口检查失败，请查看代理服务。", action: open, actionText: "查看连接" });
    }
  }
  for (const [nodeId, entry] of Object.entries(data.projects)) {
    if (entry.error) items.push({ key: `p:${nodeId}`, tone: "warn", title: `项目列表读取失败：${data.nodeName(nodeId)}`,
      detail: entry.error, action: () => void data.refresh(), actionText: "重试" });
  }
  if (data.fleet?.proxyUrl && !data.fleet.gatewayId) {
    items.push({ key: "gw", tone: "bad", title: "统一代理出口不可用",
      detail: "使用统一出网代理的请求暂时无法发送，请检查候选节点和代理连接。",
      action: () => navigate({ view: "machines" }, { reset: true }), actionText: "查看机器" });
  }
  return items;
}
