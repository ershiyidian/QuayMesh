import type { NodeCapabilities } from "./capabilities.js";
export interface ExportedRoot {
  id: string;
  nickname: string;
  path: string;
  description: string;
  tags: string[];
  enabled: boolean;
}
export interface PeerConfig { id: string; url: string; nickname?: string }
export interface FederationConfig {
  enabled: boolean;
  nodeId: string;
  nickname: string;
  capabilities: NodeCapabilities;
  coordinatorId: string;
  membershipFile?: string;
  statusFile?: string;
  socksProxy?: string;
  priority: number;
  host: string;
  port: number;
  ingressPort?: number;
  tokenEnv: string;
  tokenFile?: string;
  tls?: { cert: string; key: string; ca?: string };
  peers: PeerConfig[];
  roots: ExportedRoot[];
  heartbeatMs: number;
  rpcTimeoutMs: number;
  egress: {
    enabled: boolean;
    listenPort: number;
    mihomoConfig?: string;
    proxyUrl: string;
    controllerUrl?: string;
    controllerSecretEnv: string;
    probeUrl: string;
    probeIntervalMs: number;
    recoveryDelayMs: number;
    inheritProxy: boolean;
  };
}
export interface NodeManifest {
  id: string;
  nickname: string;
  capabilities: NodeCapabilities;
  discovery?: { ready: boolean; lastSuccessAt?: number | null; lastError?: string | null };
  components?: { id: string; state: string; pid?: number | null; restarts?: number; error?: string | null;
    startedAt?: number | null; stableSince?: number | null; crashLoop?: boolean; observedAt?: number | null;
    lastExitCode?: number | null; lastExitSignal?: string | null; lastExitAt?: number | null }[];
  priority: number;
  roots: ExportedRoot[];
  platform: string;
  version?: string;
  runtime?: { nodeVersion: string; nodeAbi: string; sqlitePackageVersion: string; sqliteNativeSha256: string;
    nodeSha256: string; packageLockSha256: string };
  tools: string[];
  providers: unknown[];
  egress: { enabled: boolean; healthy: boolean; healthySince?: number; error?: string; checkedAt?: number; latencyMs?: number;
    draining?: boolean; activeConnections?: number };
  health: {
    cpuCount: number;
    cpu?: number | null;
    load: number[];
    memoryTotal: number;
    memoryFree: number;
    uptime: number;
    uptimeSec?: number;
    disks?: { mount: string; total: number; free: number }[];
    gpus: { name: string; utilization: number; memoryUsedMiB: number; memoryTotalMiB: number; temperature?: number }[];
    gpuSampled?: boolean;
    activeCalls: number;
  };
  updatedAt: number;
}
export interface NodeView extends NodeManifest {
  online: boolean;
  connectedVia?: string;
  latencyMs?: number;
  lastSeen?: number;
  onlineSince?: number;
  /** Last successful control-plane RPC or hello. A single failure does not clear this. */
  lastSuccessAt?: number;
  lastError?: string;
  consecutiveFailures?: number;
}
export type JsonRecord = Record<string, unknown>;
export type ToolHandler = (input: JsonRecord, extra: JsonRecord) => Promise<unknown> | unknown;
export interface ConsoleReply { status: number; body: unknown; headers?: Record<string, string> }

export type { SessionFeedRequest, SessionFeedUpdate, TrustedInvocationEnvelope } from "./session-types.js";
