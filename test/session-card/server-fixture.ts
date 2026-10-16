import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { defaultQuayMeshConfig } from "../../src/config-schema.js";
import { writeQuayMeshConfig } from "../../src/user-config.js";

const execFileAsync = promisify(execFile);
const ownerToken = "test-owner-token-that-is-long-enough";

export interface RealTestServerOptions {
  prefix?: string;
  uiEnabled?: boolean;
  git?: boolean;
  files?: Record<string, string>;
  subagents?: ServerConfig["subagents"];
  federation?: {
    nodeId: string;
    nickname: string;
    capabilities: {
      coordinator: boolean;
      worker: boolean;
      discovery: boolean;
      egress: boolean;
      meshRelay: boolean;
      desktopUi: boolean;
      consoleRelay: boolean;
    };
    priority: number;
    port: number;
    ingressPort: number;
    peers: Array<{ id: string; nickname?: string; url: string }>;
  };

  configure?: (config: ServerConfig) => Promise<ServerConfig>;
}

export interface RealTestServer {
  root: string;
  project: string;
  secondRoot: string;
  config: ServerConfig;
  baseUrl: string;
  accessToken: string;
  client: Client;
  running: ReturnType<typeof createServer>;
  dispose(): Promise<void>;
}

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587,
  601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const server = createNetServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (port !== 0 && !FETCH_FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("FREE_PORT_EXHAUSTED");
}

export async function createRealTestServer(options: RealTestServerOptions = {}): Promise<RealTestServer> {
  const root = await mkdtemp(join(tmpdir(), options.prefix ?? "quaymesh-session-card-"));
  const project = join(root, "project");
  const secondRoot = join(root, "second");
  const stateDir = join(root, "state");
  const configDir = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(project, "README.md"), "session card test fixture\n", "utf8");
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const target = join(project, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  const httpPort = await freePort();

  if (options.git !== false) {
    await execFileAsync("git", ["init"], { cwd: project });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    await execFileAsync("git", ["config", "user.name", "QuayMesh Test"], { cwd: project });
    await execFileAsync("git", ["add", "."], { cwd: project });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: project });
  }

  const env = {
    ...process.env,
    QUAYMESH_CONFIG_DIR: configDir,
    QUAYMESH_OAUTH_OWNER_TOKEN: ownerToken,
  };
  const defaults = defaultQuayMeshConfig();
  const configured = options.federation
    ? {
        ...defaults,
        federation: {
          ...defaults.federation,
          enabled: true,
          nodeId: options.federation.nodeId,
          nickname: options.federation.nickname,
          capabilities: options.federation.capabilities,
          priority: options.federation.priority,
          host: "127.0.0.1",
          port: options.federation.port,
          ingressPort: options.federation.ingressPort,
          tokenEnv: "QUAYMESH_CLUSTER_TOKEN",
          peers: options.federation.peers,
          roots: [{ id: "main", nickname: options.federation.nickname, path: project, description: "session-card federation fixture", tags: ["test"], enabled: true }],
          heartbeatMs: 1000,
          rpcTimeoutMs: 5000,
          egress: { ...defaults.federation.egress, enabled: false },
        },
      }
    : defaults;
  writeQuayMeshConfig({
    ...configured,
    server: { ...defaults.server, host: "127.0.0.1", port: httpPort, publicBaseUrl: `http://127.0.0.1:${httpPort}` },
    storage: { ...defaults.storage, stateDir },
    workspaces: { ...defaults.workspaces, allowedRoots: [project, secondRoot], worktreeRoot: join(root, "worktrees") },
    ui: { ...defaults.ui, enabled: options.uiEnabled ?? true },
    subagents: options.subagents ?? { ...configured.subagents, enabled:false, providers:[] },
    logging: { ...defaults.logging, level: "silent", requests: false, assets: false, toolCalls: false },
  }, env);
  const loaded = loadConfig(env);
  const config = options.configure ? await options.configure(loaded) : loaded;

  const running = createServer(config, { incomingArtifactAdapters: [] });
  await running.ready;
  const httpServer = running.app.listen(httpPort, "127.0.0.1");
  const client = new Client({ name: "session-card-test-client", version: "1.0.0" });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await client.close();
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  };

  try {
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = "http://127.0.0.1:" + address.port;
    const accessToken = await issueAccessToken(baseUrl, config.publicBaseUrl, ownerToken);
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), {
      requestInit: { headers: { authorization: "Bearer " + accessToken } },
    });
    await client.connect(transport);
    // 与宿主一致，先发现工具并注册输出校验器，再开始任何工具调用。
    await client.listTools();
    return { root, project, secondRoot, config, baseUrl, accessToken, client, running, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function issueAccessToken(localBaseUrl: string, publicBaseUrl: string, token: string): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const resource = new URL("/mcp", publicBaseUrl).href;
  const verifier = "session-card-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(localBaseUrl + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Session Card Test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(localBaseUrl + "/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "quaymesh",
      resource,
      state: "session-card",
      owner_token: token,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(localBaseUrl + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

export async function callOpen(
  client: Client,
  path: string,
  conversationId: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return client.callTool({
    name: "open_workspace",
    arguments: { path },
    _meta: { "openai/session": conversationId },
  });
}

export async function openConversation(
  client: Client,
  path: string,
  conversationId: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  return callOpen(client, path, conversationId);
}

export function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent, "expected structuredContent");
  return result.structuredContent as Record<string, unknown>;
}
