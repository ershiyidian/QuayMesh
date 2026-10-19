import * as z from "zod/v4";
import { federationConfigSchema } from "./federation/schema.js";
import { subagentsConfigSchema } from "./local-agent-config.js";
import { commandProfilesSchema } from "./command-profiles.js";

export const QUAYMESH_CONFIG_VERSION = 1 as const;
export const QUAYMESH_CONFIG_SCHEMA_URL =
  "urn:quaymesh:core-config:1";

const serverConfigSchema = z.object({
  host: z.string().trim().min(1).default("127.0.0.1"),
  port: z.number().int().min(1).max(65_535).default(7676),
  publicBaseUrl: z.string().url().nullable().default(null),
  allowedHosts: z.array(z.string().trim().min(1)).default([]),
  trustProxy: z.boolean().default(false),
}).strict().prefault({});

const workspacesConfigSchema = z.object({
  allowedRoots: z.array(z.string().trim().min(1)).default([]),
  worktreeRoot: z.string().trim().min(1).default("~/.quaymesh/worktrees"),
}).strict().prefault({});

const storageConfigSchema = z.object({
  stateDir: z.string().trim().min(1).default("~/.local/share/quaymesh"),
}).strict().prefault({});

const toolsConfigSchema = z.object({
  mode: z.enum(["claude", "codex"]).default("codex"),
  commandProfiles:commandProfilesSchema,
  dangerouslySkipCommandReview: z.boolean().default(false).describe(
    "Legacy configuration field; it does not change command execution, MCP risk annotations, or the host's independent review requirements.",
  ),
}).strict().prefault({});

const uiConfigSchema = z.object({
  // 默认返回普通 MCP 文本和结构化结果；只有明确开启时才加载交互卡片资源。
  enabled: z.boolean().default(false),
}).strict().prefault({});

const artifactsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxFileBytes: z.number().int().positive().default(1024 * 1024 * 1024),
}).strict().prefault({});

const skillsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string().trim().min(1)).default([]),
  agentDir: z.string().trim().min(1).default("~/.codex"),
}).strict().prefault({});

const loggingConfigSchema = z.object({
  level: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
  requests: z.boolean().default(true),
  assets: z.boolean().default(false),
  toolCalls: z.boolean().default(true),
  shellCommands: z.boolean().default(false),
}).strict().prefault({});

const oauthConfigSchema = z.object({
  resourceAliases: z.array(z.string().url()).default([]).describe("Exact additional OAuth resource URLs representing this MCP server, such as a user-owned tunnel endpoint."),
  accessTokenTtlSeconds: z.number().int().positive().default(60 * 60),
  refreshTokenTtlSeconds: z.number().int().positive().default(30 * 24 * 60 * 60),
  scopes: z.array(z.string().trim().min(1)).min(1).default(["quaymesh"]),
  allowedResourceUrls: z.array(z.string().trim().url().refine((value) => {
    const url = URL.parse(value);
    return url !== null && (url.protocol === "https:"
      || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  }, "Resource URLs must use HTTPS, or HTTP on localhost, 127.0.0.1, or [::1]")
    .describe("Exact resource URL: HTTPS, or HTTP on localhost, 127.0.0.1, or [::1]."))
    .default([]),
  allowedRedirectHosts: z.array(z.string().trim().min(1)).min(1).default([
    "chatgpt.com",
    "localhost",
    "127.0.0.1",
  ]),
}).strict().prefault({});

export const quaymeshConfigSchema = z.object({
  $schema: z.string().url().default(QUAYMESH_CONFIG_SCHEMA_URL),
  configVersion: z.literal(QUAYMESH_CONFIG_VERSION),
  server: serverConfigSchema,
  federation: federationConfigSchema,
  network:z.object({externalAccess:z.boolean().default(true)}).strict().prefault({}),
  workspaces: workspacesConfigSchema,
  storage: storageConfigSchema,
  tools: toolsConfigSchema,
  ui: uiConfigSchema,
  console: z.object({
    enabled: z.boolean().default(true),
    mcpIngress: z.object({
      nodeId: z.string().min(1),
      url: z.url().optional(),
      label: z.string().min(1).max(120).optional(),
    }).strict().optional(),
    allowRemote: z.boolean().default(false),
    sessionTtlSeconds: z.number().int().min(300).max(30 * 24 * 60 * 60).default(30 * 24 * 60 * 60),
  }).strict().prefault({}),
  artifacts: artifactsConfigSchema,
  skills: skillsConfigSchema,
  subagents: subagentsConfigSchema.default({
    enabled: false,
    instructions: "on-demand",
    providers: [],
  }),
  logging: loggingConfigSchema,
  oauth: oauthConfigSchema,
}).strict();

export type QuayMeshConfig = z.output<typeof quaymeshConfigSchema>;
export type QuayMeshConfigInput = z.input<typeof quaymeshConfigSchema>;
export type ToolMode = QuayMeshConfig["tools"]["mode"];

export function defaultQuayMeshConfig(): QuayMeshConfig {
  return quaymeshConfigSchema.parse({ configVersion: QUAYMESH_CONFIG_VERSION });
}

export function quaymeshConfigJsonSchema(): object {
  return {
    $id: QUAYMESH_CONFIG_SCHEMA_URL,
    title: "QuayMesh configuration",
    description: "Versioned configuration for a local QuayMesh MCP server.",
    ...z.toJSONSchema(quaymeshConfigSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}
