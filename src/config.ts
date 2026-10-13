import { resolve } from "node:path";
import { proxyEnvironment } from "./federation/egress.js";
import type { FederationConfig } from "./federation/types.js";
import type { ToolMode } from "./config-schema.js";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { quaymeshAgentsDir, quaymeshSkillsDir, loadQuayMeshFiles } from "./user-config.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import type { CommandProfile } from "./command-profiles.js";

export type { ToolMode } from "./config-schema.js";

export interface ServerConfig {
  federation?: FederationConfig;
  network?: {externalAccess:boolean};
  configDir: string;
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  commandProfiles?:Record<string,CommandProfile>;
  dangerouslySkipCommandReview: boolean;
  uiEnabled: boolean;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  quaymeshSkillsDir: string;
  quaymeshAgentsDir: string;
  subagents: SubagentsConfig;
  agentDir: string;
  logging: LoggingConfig;
  console?: { enabled: boolean; mcpIngress?: { nodeId: string; url?: string; label?: string }; allowRemote: boolean; sessionTtlSeconds: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadQuayMeshFiles(env);
  const stored = files.config;
  const host = stored.server.host;
  const port = stored.server.port;
  const publicBaseUrl = parsePublicBaseUrl(
    stored.server.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...stored.server.allowedHosts,
  ];

  return {
    configDir: files.dir,
    federation: stored.federation,
    network:stored.network,
    host,
    port,
    oauth: {
      resourceAliases: stored.oauth.resourceAliases,
      ownerToken: parseRequiredSecret(
        env.QUAYMESH_OAUTH_OWNER_TOKEN ?? files.auth.ownerToken,
      ),
      accessTokenTtlSeconds: stored.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: stored.oauth.refreshTokenTtlSeconds,
      scopes: stored.oauth.scopes,
      allowedResourceUrls: stored.oauth.allowedResourceUrls,
      allowedRedirectHosts: stored.oauth.allowedRedirectHosts,
    },
    allowedRoots: stored.federation.enabled
      ? normalizePaths(stored.federation.roots.filter((root) => root.enabled).map((root) => root.path))
      : normalizePaths(stored.workspaces.allowedRoots, [process.cwd()]),
    allowedHosts: normalizeAllowedHosts(derivedAllowedHosts),
    publicBaseUrl,
    toolMode: stored.tools.mode,
    commandProfiles:stored.tools.commandProfiles,
    dangerouslySkipCommandReview: stored.tools.dangerouslySkipCommandReview,
    uiEnabled: stored.ui.enabled,
    console: stored.console,
    stateDir: normalizePath(stored.storage.stateDir),
    worktreeRoot: normalizePath(stored.workspaces.worktreeRoot),
    artifactsEnabled: stored.artifacts.enabled,
    artifactMaxFileBytes: stored.artifacts.maxFileBytes,
    skillsEnabled: stored.skills.enabled,
    skillPaths: stored.skills.paths,
    quaymeshSkillsDir: quaymeshSkillsDir(env),
    quaymeshAgentsDir: quaymeshAgentsDir(env),
    subagents: stored.network.externalAccess
      ? federationSubagents(stored.subagents, stored.federation, env)
      : {...stored.subagents, enabled:false, providers:[]},
    agentDir: normalizePath(stored.skills.agentDir),
    logging: {
      ...stored.logging,
      trustProxy: stored.server.trustProxy,
    },
  };
}

function normalizePaths(paths: string[], fallback: string[] = []): string[] {
  return (paths.length > 0 ? paths : fallback).map(normalizePath);
}

function normalizePath(path: string): string {
  return resolve(expandHomePath(path));
}

function normalizeAllowedHosts(hosts: string[]): string[] {
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseRequiredSecret(value: string | undefined): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error("OAuth owner token is required. Run: quaymesh init");
  }
  if (secret.length < 16) {
    throw new Error("OAuth owner token must be at least 16 characters long.");
  }
  return secret;
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}

/** Only runtime network environment changes; model/provider/account selection remains in CC Switch. */
function federationSubagents(subagents: SubagentsConfig, federation: FederationConfig, env: NodeJS.ProcessEnv): SubagentsConfig {
  if (!federation.enabled || !federation.egress.enabled || !federation.egress.inheritProxy) return subagents;
  const hosts = federation.peers.filter((p) => p.url).map((p) => new URL(p.url).hostname);
  return { ...subagents, providers: subagents.providers.map((provider) => {
    const exclusions = [env.NO_PROXY ?? env.no_proxy, provider.env?.NO_PROXY ?? provider.env?.no_proxy].filter(Boolean).join(",");
    const proxy = proxyEnvironment(federation.egress.listenPort, { NO_PROXY: exclusions }, hosts);
    return { ...provider, env: { ...provider.env, ...proxy } as Record<string, string> };
  }) };
}
