import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createRealTestServer, type RealTestServer } from "./server-fixture.js";
import { WORKSPACE_APP_URI } from "../../src/tool-surfaces/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../..");
const processWorker = join(here, "process-worker.mjs");
const hostPort = 4179;
const hostUrl = `http://127.0.0.1:${hostPort}`;
const resourceUri = WORKSPACE_APP_URI;
const conversationId = "session-card-local-host";

type JsonRecord = Record<string, unknown>;

interface BrowserState {
  mountedFrames: number;
  iframeMounted: boolean;
  initialized: boolean;
  lastTool: string | null;
  lastError: string | null;
}

interface HostState {
  fixture: RealTestServer;
  browserClient: Client | null;
  vite: ViteDevServer;
  http: ReturnType<typeof createHttpServer>;
  workspaceId: string;
  sessionId: string;
  memberId: string;
  resourceHtml: string;
  openResult: JsonRecord;
  followupMessages: string[];
  callLog: string[];
  browserState: BrowserState;
  disposed: boolean;
  servedTaskPages: number;
}

const state = await startLocalHost();

async function startLocalHost(): Promise<HostState> {
  const fixture = await createRealTestServer({
    prefix: "quaymesh-session-host-",
    uiEnabled: true,
    files: {
      "AGENTS.md": "# Browser acceptance instructions\n\nUse the real MCP tool surface during this acceptance run.\n",
      ".agents/skills/browser-check/SKILL.md": [
        "---",
        "name: browser-check",
        "description: Real skill discovered by the production workspace loader.",
        "---",
        "",
        "# Browser check",
        "",
        "Confirm the session card renders real QuayMesh data.",
        "",
      ].join("\n"),
    },
  });
  let browserClient: Client | null = null;
  let vite: ViteDevServer | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;

  try {
    const started=await fixture.client.callTool({name:"start_session",
      arguments:{title:"验证任务卡片与后台命令",request_key:"browser-acceptance"},
      _meta:{"openai/session":conversationId}});
    if(started.isError)throw new Error("HOST_START_TASK_FAILED");
    const opened = await fixture.client.callTool({
      name: "open_workspace",
      arguments: { path: fixture.project },
      _meta: { "openai/session": conversationId },
    });
    if (opened.isError) throw new Error("HOST_OPEN_WORKSPACE_FAILED");
    const openResult = recordField(opened);
    const structured = recordField(openResult.structuredContent);
    const meta = recordField(openResult._meta);
    const quaymesh = recordField(meta.quaymesh);
    const workspaceId = stringField(structured.workspace_id) ?? stringField(quaymesh.workspace_id);
    const sessionId = stringField(structured.session_id) ?? stringField(quaymesh.session_id);
    const memberId = stringField(structured.member_id) ?? stringField(quaymesh.member_id);
    if (!workspaceId || !sessionId || !memberId) throw new Error("HOST_SESSION_BOOTSTRAP_MISSING");

    const resource = await fixture.client.readResource({ uri: resourceUri });
    const resourceHtml = resource.contents.find((entry): entry is { uri: string; text: string; mimeType?: string } =>
      typeof (entry as { text?: unknown }).text === "string"
    )?.text;
    if (!resourceHtml) throw new Error("HOST_CARD_RESOURCE_MISSING");

    vite = await createViteServer({
      root: repositoryRoot,
      configFile: false,
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
    });

    let hostState: HostState;
    http = createHttpServer((request, response) => void handleRequest(hostState, request, response));
    http.listen(hostPort, "127.0.0.1");
    await once(http, "listening");

    hostState = {
      fixture,
      browserClient: null,
      vite,
      http,
      workspaceId,
      sessionId,
      memberId,
      resourceHtml,
      openResult,
      followupMessages: [],
      callLog: [],
      browserState: {
        mountedFrames: 0,
        iframeMounted: false,
        initialized: false,
        lastTool: null,
        lastError: null,
      },
      disposed: false,
      servedTaskPages: 0,
    };
    await connectBrowserClient(hostState);

    const dispose = async () => {
      if (hostState.disposed) return;
      hostState.disposed = true;
      hostState.http.closeAllConnections?.();
      await new Promise<void>((resolveClose) => hostState.http.close(() => resolveClose()));
      await hostState.vite.close();
      await hostState.browserClient?.close();
      await hostState.fixture.dispose();
    };
    Object.assign(hostState, { dispose });

    const onSignal = () => void dispose().then(() => process.exit(0));
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    return hostState;
  } catch (error) {
    await browserClient?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
    if (http?.listening) await new Promise<void>((resolveClose) => http!.close(() => resolveClose()));
    await fixture.dispose();
    throw error;
  }
}

async function connectBrowserClient(hostState: HostState): Promise<void> {
  if (hostState.browserClient) return;
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", hostState.fixture.baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${hostState.fixture.accessToken}` } },
  });
  const client = new Client({ name: "quaymesh-local-host", version: "1.0.0" });
  await client.connect(transport);
  await client.listTools();
  hostState.browserClient = client;
}

async function disconnectBrowserClient(hostState: HostState): Promise<void> {
  const client = hostState.browserClient;
  hostState.browserClient = null;
  if (client) await client.close();
}
async function handleRequest(hostState: HostState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", hostUrl);
    if (request.method === "GET" && url.pathname === "/") {
      // Each Playwright page is a distinct user request. Keep the shared MCP
      // service alive, but never reuse a prior test's Task or member selection.
      if (hostState.servedTaskPages > 0) await beginNewTestTask(hostState);
      hostState.servedTaskPages += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(join(here, "host.html"), "utf8"));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      writeJson(response, 200, {
        resourceUri,
        resourceHtml: hostState.resourceHtml,
        openResult: hostState.openResult,
        openArguments: { path: hostState.fixture.project },
        workspaceId: hostState.workspaceId,
        sessionId: hostState.sessionId,
        memberId: hostState.memberId,
        secondRoot: hostState.fixture.secondRoot,
        processWorker,
        root: hostState.fixture.project,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      writeJson(response, 200, {
        ...hostState.browserState,
        connected: hostState.browserClient !== null,
        followupMessages: hostState.followupMessages,
        callLog: hostState.callLog,
        sessionId: hostState.sessionId,
        memberId: hostState.memberId,
        workspaceId: hostState.workspaceId,
        root: hostState.fixture.project,
        secondRoot: hostState.fixture.secondRoot,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/client-state") {
      const body = await readJsonBody(request);
      hostState.browserState = {
        mountedFrames: numberField(body.mountedFrames) ?? 0,
        iframeMounted: numberField(body.mountedFrames) === 1,
        initialized: body.initialized === true,
        lastTool: stringField(body.lastTool) ?? null,
        lastError: stringField(body.lastError) ?? null,
      };
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/snapshot") {
      const client = hostState.browserClient;
      if (!client) throw new Error("HOST_MCP_DISCONNECTED");
      const body = await readJsonBody(request);
      const result = await client.callTool({ name: "qm_session", arguments: { session_id: hostState.sessionId, since_rev: numberField(body.since_rev) ?? -1 }, _meta: { "openai/session": conversationId } });
      writeJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/client-control") {
      const body = await readJsonBody(request);
      const action = stringField(body.action);
      if (action === "disconnect") {
        await disconnectBrowserClient(hostState);
        writeJson(response, 200, { ok: true, connected: false });
        return;
      }
      if (action === "reconnect") {
        await connectBrowserClient(hostState);
        writeJson(response, 200, { ok: true, connected: true });
        return;
      }
      throw new Error("HOST_CONTROL_ACTION_REQUIRED");
    }
    if (request.method === "POST" && url.pathname === "/api/followup") {
      const body = await readJsonBody(request);
      const message = stringField(body.message);
      if (!message) throw new Error("HOST_FOLLOWUP_MESSAGE_REQUIRED");
      hostState.followupMessages.push(message);
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tool") {
      const body = await readJsonBody(request);
      const name = stringField(body.name);
      if (!name) throw new Error("HOST_TOOL_NAME_REQUIRED");
      const client = hostState.browserClient;
      if (!client) throw new Error("HOST_MCP_DISCONNECTED");
      const toolArgs = recordField(body.arguments);
      try {
        const result = await client.callTool({
          name,
          arguments: toolArgs,
          _meta: { "openai/session": conversationId },
        });
        hostState.callLog.push("OK " + name + " " + JSON.stringify(toolArgs).slice(0, 200));
        hostState.browserState.lastTool = name;
        writeJson(response, 200, result);
        return;
      } catch (error) {
        hostState.callLog.push("ERR " + name + " " + (error instanceof Error ? error.message : String(error)));
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/read-resource") {
      const body = await readJsonBody(request);
      const uri = stringField(body.uri);
      if (!uri) throw new Error("HOST_RESOURCE_URI_REQUIRED");
      if (!hostState.browserClient) throw new Error("HOST_MCP_DISCONNECTED");
      writeJson(response, 200, await hostState.browserClient.readResource({ uri }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/list-resources") {
      if (!hostState.browserClient) throw new Error("HOST_MCP_DISCONNECTED");
      writeJson(response, 200, await hostState.browserClient.listResources());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/list-resource-templates") {
      if (!hostState.browserClient) throw new Error("HOST_MCP_DISCONNECTED");
      writeJson(response, 200, await hostState.browserClient.listResourceTemplates());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/shutdown") {
      writeJson(response, 200, { ok: true });
      setTimeout(() => void disposeProcess(), 0);
      return;
    }
    hostState.vite.middlewares(request, response, (error?: unknown) => {
      if (error) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hostState.browserState.lastError = message;
    writeJson(response, 500, { error: message });
  }
}

async function beginNewTestTask(hostState:HostState):Promise<void> {
  const metadata={"openai/session":conversationId};
  const started=await hostState.fixture.client.callTool({name:"start_session",arguments:{
    title:"Browser acceptance task",request_key:randomUUID(),
  },_meta:metadata});
  if(started.isError)throw new Error("HOST_NEW_TASK_FAILED");
  const opened=await hostState.fixture.client.callTool({name:"open_workspace",arguments:{
    path:hostState.fixture.project,
  },_meta:metadata});
  if(opened.isError)throw new Error("HOST_NEW_WORKSPACE_FAILED");
  const record=recordField(opened),meta=recordField(recordField(record._meta).quaymesh);
  const structured=recordField(record.structuredContent);
  const workspaceId=stringField(structured.workspace_id)??stringField(meta.workspace_id);
  const sessionId=stringField(meta.session_id)??stringField(structured.session_id);
  const memberId=stringField(meta.member_id)??stringField(structured.member_id);
  if(!workspaceId||!sessionId||!memberId)throw new Error("HOST_NEW_TASK_IDENTITY_MISSING");
  hostState.openResult=record;
  hostState.workspaceId=workspaceId;
  hostState.sessionId=sessionId;
  hostState.memberId=memberId;
  hostState.callLog=[];
  hostState.browserState={mountedFrames:0,iframeMounted:false,initialized:false,lastTool:null,lastError:null};
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return recordField(parsed);
}

function recordField(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function disposeProcess(): Promise<void> {
  const dispose = (state as HostState & { dispose?: () => Promise<void> }).dispose;
  if (!dispose) throw new Error("HOST_DISPOSE_UNAVAILABLE");
  await dispose();
  process.exit(0);
}
