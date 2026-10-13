import * as z from "zod/v4";
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const port = z.number().int().min(1).max(65535);
export const exportedRootSchema = z.object({
  id, nickname: z.string().trim().min(1).max(120), path: z.string().trim().min(1),
  description: z.string().max(2000).default(""), tags: z.array(z.string().trim().min(1).max(80)).max(32).default([]), enabled: z.boolean().default(true),
}).strict();
export const peerSchema = z.object({ id, nickname: z.string().trim().max(120).optional(),
  url: z.string().default("").refine((value) => !value || /^https?:\/\//.test(value), "使用 https://host:7680；由对方主动连接时留空"),
}).strict();
export const federationConfigSchema = z.object({
  enabled: z.boolean().default(false), nodeId: id.default("desktop"), nickname: z.string().trim().min(1).max(120).default("我的电脑"),
  capabilities: z.object({
    coordinator:z.boolean().default(false), worker:z.boolean().default(true),
    discovery:z.boolean().default(false), egress:z.boolean().default(false),
    meshRelay:z.boolean().default(false), desktopUi:z.boolean().default(false), consoleRelay:z.boolean().default(false),
  }).strict().prefault({}),
  coordinatorId:id.default("cloud"),
  membershipFile:z.string().optional(), statusFile:z.string().optional(),
  socksProxy:z.string().url().refine(value => new URL(value).protocol === "socks5:", "使用 socks5 地址").optional(),
  priority: z.number().int().min(0).max(1000).default(0),
  host: z.string().min(1).default("127.0.0.1"), port: port.default(7680), ingressPort: port.default(7677),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("QUAYMESH_CLUSTER_TOKEN"), tokenFile: z.string().optional(),
  tls: z.object({ cert: z.string().min(1), key: z.string().min(1), ca: z.string().optional() }).strict().optional(),
  peers: z.array(peerSchema).max(32).default([]), roots: z.array(exportedRootSchema).max(256).default([]),
  heartbeatMs: z.number().int().min(1000).max(60000).default(5000), rpcTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  egress: z.object({
    enabled: z.boolean().default(false), listenPort: port.default(17890),
    mihomoConfig: z.string().optional(), proxyUrl: z.string().url().default("http://127.0.0.1:7890"), controllerUrl: z.string().url().optional(),
    controllerSecretEnv: z.string().default("MIHOMO_SECRET"), probeUrl: z.string().url().default("https://www.gstatic.com/generate_204"),
    probeIntervalMs: z.number().int().min(3000).max(300000).default(15000), recoveryDelayMs: z.number().int().min(0).max(300000).default(30000),
    inheritProxy: z.boolean().default(true),
  }).strict().prefault({}),
}).strict().prefault({}).superRefine((value, context) => {
  for (const key of ["peers", "roots"] as const) {
    const seen = new Set<string>();
    value[key].forEach((entry, index) => { if (seen.has(entry.id)) context.addIssue({ code: "custom", path: [key, index, "id"], message: "ID 重复" }); seen.add(entry.id); });
  }
  if (value.peers.some((peer) => peer.id === value.nodeId)) context.addIssue({ code: "custom", path: ["peers"], message: "节点列表填写其他机器" });
});
