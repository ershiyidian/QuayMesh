import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

interface Bootstrap {
  resourceUri: string;
  resourceHtml: string;
  openResult: Record<string, unknown>;
  openArguments: Record<string, unknown>;
  workspaceId: string;
  sessionId: string;
  memberId: string;
  secondRoot: string;
  processWorker: string;
  nodeExecutable: string;
  root: string;
}

interface HostStatus {
  initialized: boolean;
  lastTool: string | null;
  lastError: string | null;
  connected: boolean;
  iframeMounted: boolean;
  sessionId: string;
  memberId: string;
  workspaceId: string;
}

const frame = document.querySelector<HTMLIFrameElement>("#app-frame");
const status = document.querySelector<HTMLElement>("#status");
const log = document.querySelector<HTMLElement>("#log");
const runCommand = document.querySelector<HTMLButtonElement>("#run-command");
const runPatch = document.querySelector<HTMLButtonElement>("#run-patch");
const attachWorkspace = document.querySelector<HTMLButtonElement>("#attach-workspace");
const disconnect = document.querySelector<HTMLButtonElement>("#disconnect");
const reconnect = document.querySelector<HTMLButtonElement>("#reconnect");
const teardown = document.querySelector<HTMLButtonElement>("#teardown");
if (!frame || !status || !log || !runCommand || !runPatch || !attachWorkspace || !disconnect || !reconnect || !teardown) {
  throw new Error("HOST_DOM_INCOMPLETE");
}

const bootstrap = await fetchJson<Bootstrap>("/api/bootstrap");
let bridge: AppBridge | null = null;
let currentMemberId = bootstrap.memberId;
let currentWorkspaceId = bootstrap.workspaceId;

attachWorkspace.addEventListener("click", () => { void attachRealWorkspace(); });
disconnect.addEventListener("click", () => { void postJson("/api/client-control", { action: "disconnect" }); });
reconnect.addEventListener("click", () => { void postJson("/api/client-control", { action: "reconnect" }); });
teardown.addEventListener("click", () => { void teardownFrame(); });
runCommand.addEventListener("click", () => {
  void requestTool("exec_command", { workspace_id: currentWorkspaceId, cmd: processCommand("echo host-command") });
});
runPatch.addEventListener("click", () => {
  void requestTool("apply_patch", {
    workspace_id: currentWorkspaceId,
    patch: ["*** Begin Patch", "*** Add File: host-patch.txt", "+host patch", "*** End Patch"].join("\n"),
  });
});
await mountFrame();
status.textContent = "ready";
window.__quaymeshHost = {
  mountedFrames: () => document.querySelectorAll("iframe").length,
  followupMessages: async () => (await fetchJson<{ followupMessages: string[] }>("/api/state")).followupMessages,
  state: async () => fetchJson<HostStatus>("/api/state"),
  requestTool,
  attachRealWorkspace,
  teardownFrame,
  mountFrame,
  processWorker: bootstrap.processWorker,
  nodeExecutable: bootstrap.nodeExecutable,
  runCommand: (cmd: string, yieldTimeMs?: number) => requestTool("exec_command", {
    workspace_id: currentWorkspaceId,
    cmd,
    ...(yieldTimeMs !== undefined ? { yield_time_ms: yieldTimeMs } : {}),
  }),
  runPatch: (patch: string) => requestTool("apply_patch", { workspace_id: currentWorkspaceId, patch }),
};
await reportClientState({ initialized: true, lastTool: null, lastError: null });

async function mountFrame(): Promise<void> {
  const next = new AppBridge(
    null,
    { name: "quaymesh-local-host", version: "1.0.0" },
    {
      serverTools: { listChanged: true },
      serverResources: { listChanged: true },
      openLinks: {},
      logging: {},
      ...(new URLSearchParams(location.search).get("host_messages") === "off" ? {} : { message: {} }),
    },
    {
      hostContext: {
        theme: new URLSearchParams(location.search).get("theme")==="light" ? "light" : "dark",
        platform: "web",
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        availableDisplayModes: ["inline", "fullscreen"],
        containerDimensions: { width: 980, maxHeight: 900 },
        deviceCapabilities: { touch: false, hover: true },
      },
    },
  );
  next.onsizechange = ({ width, height }) => {
    if (typeof width === "number") frame.style.width = `${Math.max(320, width)}px`;
    if (typeof height === "number") frame.style.height = `${Math.max(1, height)}px`;
  };
  next.onmessage = async ({ content }) => {
    const text = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    await postJson("/api/followup", { message: text });
    appendLog(`followup: ${text}`);
    return {};
  };
  next.onloggingmessage = ({ level, data }) => appendLog(`view ${level}: ${String(data)}`);
  next.onopenlink = async ({ url }) => {
    window.open(url, "_blank", "noopener,noreferrer");
    return {};
  };
  next.oncalltool = async (params) => {
    const response = await fetch("/api/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toolRequest(params.name, params.arguments ?? {})),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  };
  next.onlistresources = async () => {
    const response = await fetch("/api/list-resources", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  };
  next.onreadresource = async (params) => {
    const response = await fetch("/api/read-resource", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  };
  next.onlistresourcetemplates = async () => {
    const response = await fetch("/api/list-resource-templates", { method: "POST" });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  };
  frame.removeAttribute("srcdoc");
  const initialized = new Promise<void>((resolve) => { next.oninitialized = () => resolve(); });
  await next.connect(new PostMessageTransport(frame.contentWindow ?? undefined, frame.contentWindow!));
  frame.srcdoc = bootstrap.resourceHtml;
  await waitForFrameLoad(frame);
  await initialized;
  await next.sendToolInput({ arguments: bootstrap.openArguments });
  const delivery = new URLSearchParams(location.search).get("delivery");
  if (delivery === "delayed") await new Promise(resolve => setTimeout(resolve, 1000));
  if (delivery === "structured") {
    const { _meta, ...result } = bootstrap.openResult;
    await next.sendToolResult(result as never);
  } else {
    await next.sendToolResult(bootstrap.openResult as never);
  }
  bridge = next;
}

async function teardownFrame(): Promise<void> {
  const previous = bridge;
  bridge = null;
  if (previous) {
    try {
      await previous.teardownResource({});
    } finally {
      // Resource teardown releases the view; closing removes the host transport's listener.
      await previous.close();
    }
  }
  frame.srcdoc = "<!doctype html><meta charset=utf-8><title>torn down</title>";
  await new Promise((resolve) => setTimeout(resolve, 0));
  await postJson("/api/client-state", {
    mountedFrames: 0,
    connected: true,
    sessionId: bootstrap.sessionId,
    memberId: currentMemberId,
    workspaceId: currentWorkspaceId,
    initialized: false,
    lastTool: null,
    lastError: null,
  });
}

async function attachRealWorkspace(): Promise<void> {
  const result = await requestTool("attach_workspace", {
    session_id: bootstrap.sessionId,
    path: bootstrap.secondRoot,
  });
  const structured = recordField(result.structuredContent);
  currentMemberId = stringField(structured.member_id) ?? currentMemberId;
  currentWorkspaceId = stringField(structured.workspace_id) ?? currentWorkspaceId;
  appendLog(`attach_workspace member=${currentMemberId}`);
}

async function requestTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const result = await fetchJson<Record<string, unknown>>("/api/tool", toolRequest(name, args));
    appendLog(`${name}: ${JSON.stringify(result).slice(0, 500)}`);
    await reportClientState({ initialized: true, lastTool: name, lastError: null });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`${name} failed: ${message}`);
    await reportClientState({ initialized: true, lastTool: name, lastError: message });
    throw error;
  }
}

async function reportClientState(state: { initialized: boolean; lastTool: string | null; lastError: string | null }): Promise<void> {
  await postJson("/api/client-state", {
    mountedFrames: document.querySelectorAll("iframe").length,
    connected: (await fetchJson<{ connected: boolean }>("/api/state")).connected,
    sessionId: bootstrap.sessionId,
    memberId: currentMemberId,
    workspaceId: currentWorkspaceId,
    ...state,
  });
}

async function fetchJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return await response.json() as T;
}

function toolRequest(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const entry = new URLSearchParams(location.search).get("entry");
  return { name, arguments: args, ...(entry === null ? {} : { entry: entry === "unavailable" ? null : entry }) };
}

async function postJson(url: string, body: unknown): Promise<void> {
  await fetchJson(url, body);
}

function processCommand(command: string): string {
  if (navigator.platform.startsWith("Win")) return `cmd /c ${command}`;
  return command;
}

function appendLog(value: string): void {
  log.textContent += `${new Date().toISOString()} ${value}\n`;
}

function waitForFrameLoad(target: HTMLIFrameElement): Promise<void> {
  if (target.contentDocument?.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => target.addEventListener("load", () => resolve(), { once: true }));
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

declare global {
  interface Window {
    __quaymeshHost: {
      mountedFrames: () => number;
      followupMessages: () => Promise<string[]>;
      state: () => Promise<HostStatus>;
      requestTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      attachRealWorkspace: () => Promise<void>;
      teardownFrame: () => Promise<void>;
      mountFrame: () => Promise<void>;
      processWorker: string;
      nodeExecutable: string;
      runCommand: (cmd: string, yieldTimeMs?: number) => Promise<Record<string, unknown>>;
      runPatch: (patch: string) => Promise<Record<string, unknown>>;
    };
  }
}
