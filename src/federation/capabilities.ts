export const capabilityNames = ["coordinator", "worker", "discovery", "egress", "meshRelay", "desktopUi", "consoleRelay"] as const;
export type Capability = typeof capabilityNames[number];
export type NodeCapabilities = Record<Capability, boolean>;
export function capabilities(enabled: Partial<NodeCapabilities> = {}): NodeCapabilities {
  return { coordinator:false, worker:false, discovery:false, egress:false, meshRelay:false, desktopUi:false, consoleRelay:false, ...enabled };
}
export function capabilityLabels(value: NodeCapabilities): string[] {
  const labels: Record<Capability,string> = {
    coordinator:"协调端", worker:"执行端", discovery:"发现端", egress:"出口", meshRelay:"网络中继", desktopUi:"桌面窗口", consoleRelay:"管理台中继",
  };
  return capabilityNames.filter(name => value[name]).map(name => labels[name]);
}
