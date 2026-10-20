import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, rename, link, unlink, open } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerConfig } from "../config.js";
import { loadConfig } from "../config.js";
import { setQuayMeshConfigValues } from "../user-config.js";
import { assertAllowedPath, expandHomePath, resolvePathInsideCanonicalRoot } from "../roots.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { federationConfigSchema } from "./schema.js";
import { FederationRuntime } from "./runtime.js";
import { SessionFeed } from "./session-feed.js";
import type { SessionRuntime } from "../session/runtime.js";
import { resolveMihomoProxy, importMihomoConfig } from "./mihomo.js";
import type { ConsoleReply, JsonRecord } from "./types.js";
import type { ExecutionCoordinator } from "../execution-coordinator.js";
import { OperationState } from "../session/types.js";
import { stableJson } from "../session/invocations.js";

export function createFederation(config: ServerConfig, workspaces: WorkspaceRegistry, providers: () => unknown[],
  consoleOperation: (method: string, path: string, body?: unknown) => Promise<ConsoleReply>,
  sessionRuntime?: SessionRuntime, execution?: ExecutionCoordinator): FederationRuntime | undefined {
  const federation = config.federation;
  if (!federation?.enabled) return undefined;
  const token = (process.env[federation.tokenEnv] ?? (federation.tokenFile ? readFileSync(resolve(expandHomePath(federation.tokenFile)), "utf8") : "")).trim();
  if (token.length < 24) throw new Error(`请设置 ${federation.tokenEnv} 或 federation.tokenFile 中的集群连接密钥。`);
  for (const peer of federation.peers) if (peer.url) {
    const url = new URL(peer.url);
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && federation.tls)
      throw new Error(`已启用 TLS，请使用 ${peer.id} 的 https:// 节点地址。`);
  }
  const env = { ...process.env, QUAYMESH_CONFIG_DIR: config.configDir,
    QUAYMESH_OAUTH_OWNER_TOKEN: config.oauth.ownerToken };
  const workspacePath = async (input: JsonRecord): Promise<string> => {
    if (typeof input.workspace_id !== "string" || typeof input.path !== "string" || !input.path || isAbsolute(input.path)) throw new Error("文件路径使用工作区内的相对路径");
    const workspace = await workspaces.getWorkspace(input.workspace_id);
    assertAllowedPath(workspace.sourceRoot ?? workspace.root, config.allowedRoots);
    return resolvePathInsideCanonicalRoot(input.path, workspace.root, workspace.root, workspace.canonicalRoot);
  };
  const nodeAdminUrl = (): URL => {
    const value = process.env.QUAYMESH_NODE_ADMIN_URL;
    if (!value) throw new Error("节点管理服务地址未配置，设置未保存。");
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("节点管理服务地址必须是本机 http:// 地址，设置未保存。");
    }
    return new URL("/settings", url);
  };
  const nodeSettings = async (body?:{settings:JsonRecord;expectedRevision:number}):Promise<JsonRecord> => {
    const response=await fetch(nodeAdminUrl(),{method:body?"POST":"GET",headers:{Authorization:`Bearer ${token}`,
      ...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    const payload=await response.json() as JsonRecord;
    if(!response.ok){const error=new Error(typeof payload.error==="string"?payload.error:`NODE_SETTINGS_HTTP_${response.status}`);
      Object.assign(error,{status:response.status});throw error;}
    return payload;
  };
  const settings = (): Promise<JsonRecord> => nodeSettings();
  const runtime: FederationRuntime = new FederationRuntime(federation, token, {
    stateDir: config.stateDir, httpPort: config.port, ingressPort: federation.ingressPort ?? 7677, publicBaseUrl: config.publicBaseUrl, providers, execution,
    console: consoleOperation, settings,
    prepareOpen: async (input) => {
      const { root_id, subdirectory, ...rest } = input;
      if (input.workspace_id !== undefined) {
        if (typeof input.workspace_id !== "string" || !input.workspace_id ||
            [root_id, subdirectory, input.path].some(value => value !== undefined)) {
          throw Object.assign(new Error("INVALID_ARGUMENT: restore workspace_id without path, root_id, or subdirectory."),
            { code: "INVALID_ARGUMENT", effect: "not_started" });
        }
        return rest;
      }
      if (root_id !== undefined) {
        const root = federation.roots.find((entry) => entry.id === root_id && entry.enabled);
        if (!root) throw new Error(`根目录 ${root_id} 当前未启用`);
        if (typeof subdirectory === "string" && isAbsolute(subdirectory)) throw new Error("subdirectory 使用相对路径");
        const rootPath = resolve(expandHomePath(root.path));
        const path = resolve(rootPath, typeof subdirectory === "string" ? subdirectory : ".");
        assertAllowedPath(path, [rootPath]);
        return { ...rest, path };
      }
      if (typeof input.path !== "string" || !input.path) throw new Error("请选择 workspace_catalog 中的 root_id");
      return rest;
    },
    checkWorkspace: async (id) => { const workspace = await workspaces.getWorkspace(id); assertAllowedPath(workspace.sourceRoot ?? workspace.root, config.allowedRoots); },
    updateSettings: async (input) => {
      const editable = ["nickname", "priority", "roots", "egress"] as const;
      const settings = Object.fromEntries(editable.filter((key) => key in input).map((key) => [key, input[key]]));
      if(!Number.isInteger(input.expectedRevision))throw new Error("需要明确的设置修订号；请先刷新设置");
      await nodeSettings({settings,expectedRevision:Number(input.expectedRevision)});
    },
    mihomoImport: (text, reload) => importMihomoConfig(federation, text, reload),
    mihomoRead: () => {
      if (!federation.egress.mihomoConfig) throw new Error("请先设置 mihomo 配置路径");
      return readFile(resolve(expandHomePath(federation.egress.mihomoConfig)), "utf8");
    },
    resolveProxy: () => federation.egress.enabled ? resolveMihomoProxy(federation) : Promise.resolve(federation.egress.proxyUrl),
    artifactStat: async (input) => { const file = await stat(await workspacePath(input));
      if (!file.isFile()) throw new Error("请选择单个文件");
      if (file.size > config.artifactMaxFileBytes) throw new Error(`文件超过当前传输上限 ${config.artifactMaxFileBytes} 字节；可在 artifacts.maxFileBytes 调整。`);
      return { size: file.size }; },
    artifactRead: async (input) => {
      const path = await workspacePath(input);
      const workspace = await workspaces.getWorkspace(String(input.workspace_id));
      const owned = typeof input.owned_write_claim === "string" && runtime.execution.ownsWriteClaim(input.owned_write_claim, path, typeof input.operation_id==="string"?input.operation_id:undefined);
      const claim = owned ? undefined : runtime.execution.acquire({ workspaceRoot: workspace.root, kind: "read", access: "read",
        scopes:[{kind:"file",path,access:"read"}],operationId:typeof input.operation_id==="string"?input.operation_id:undefined });
      try {
        const fd = await open(path, "r");
        try {
          const info = await fd.stat();
          if (!info.isFile() || info.size > config.artifactMaxFileBytes) throw new Error("文件类型或大小不适合传输");
          const stream = fd.createReadStream({ autoClose: true });
          stream.once("close", () => claim?.release());
          return stream;
        } catch (error) { await fd.close(); throw error; }
      } catch (error) { claim?.release(); throw error; }
    },
    artifactPrepare: async (input, envelope) => {
      const destination = await workspacePath(input);
      const workspace = await workspaces.getWorkspace(String(input.workspace_id));
      const operationId = String(input.operation_id);
      if (!/^op_copy_[0-9a-f-]+$/.test(operationId)) throw new Error("COPY_OPERATION_ID_INVALID");
      const claim = runtime.execution.acquire({ workspaceRoot: workspace.root,kind:"mutation",operationId,
        taskId:envelope?.task_id,scopes:[{kind:"file",path:destination,access:"write"}],title:"文件复制" });
      let ticket: Awaited<ReturnType<SessionRuntime["service"]["beforeOperation"]>> | undefined;
      let evidence: Awaited<ReturnType<SessionRuntime["changes"]["prepareWrite"]>> = [];
      let finished = false;
      try {
        if (sessionRuntime && envelope?.session_id && envelope.member_id && envelope.task_id) {
          const identity = { owner_id: envelope.owner_id, conversation_id: envelope.conversation_id,
            transport_instance_id: `copy:${federation.nodeId}`, request_id: String(input.request_key),
            invocation_id: operationId, task_id: envelope.task_id };
          const context = sessionRuntime.recorder.contextForSession(identity, envelope.session_id, envelope.member_id, workspace.id, "copy_artifact");
          context.operation_id = operationId;
          sessionRuntime.store.reserveInvocation({ id: context.invocation_id, ownerId: context.owner_id,
            transportInstanceId: context.transport_instance_id, requestId: String(context.request_id),
            sessionId: context.session_id, memberId: context.member_id, toolName: "copy_artifact",
            argumentsJson: stableJson({ source_node: input.source_node, source_workspace: input.source_workspace,
              source_path: input.source_path, destination_workspace: workspace.id, destination_path: input.path, overwrite: input.overwrite }) });
          ticket = await sessionRuntime.service.beforeOperation(context, "copy", `复制文件到 ${String(input.path)}`);
          sessionRuntime.store.updateInvocation({ ownerId: context.owner_id, transportInstanceId: context.transport_instance_id,
            requestId: String(context.request_id), operationId, state: OperationState.running, effect: "started" });
          const member = sessionRuntime.store.getMember(context.session_id, context.member_id);
          evidence = await sessionRuntime.changes.prepareWrite(member, [String(input.path)], member.root, context.task_id);
        }
      } catch (error) {
        if (ticket && sessionRuntime) await sessionRuntime.service.finishOperationById(operationId, {
          status: OperationState.failed, effect: "not_started", error_message: error instanceof Error ? error.message : String(error),
        });
        claim.release(); throw error;
      }
      return {
        temporaryPath: `${destination}.quaymesh-${operationId}.part`, claimId: claim.id,
        finish: async (status, error) => {
          if (finished) return;
          finished = true;
          if (ticket && sessionRuntime) {
            await sessionRuntime.service.finishOperationById(operationId, {
              status: status === "completed" ? OperationState.succeeded : status === "cancelled" ? OperationState.cancelled : OperationState.failed,
              effect: status === "completed" ? "completed" : "not_started", result_ref: operationId,
              error_message: error ?? null, known_paths: status === "completed" ? [String(input.path)] : [],
            });
            // File-change summaries are derived metadata. They cannot hold the
            // destination write lease after an atomically committed transfer.
            if (status === "completed" && evidence.length) {
              void sessionRuntime.changes.recordWrite(
                sessionRuntime.store.getMember(ticket.session_id, ticket.member_id), evidence, ticket.task_id,
              ).catch(captureError => {
                console.error("QuayMesh transfer change capture:", captureError);
              });
            }
          }
        },
        release: () => claim.release(),
      };
    },
    artifactRecover: async (input) => {
      const destination = await workspacePath(input);
      const expected = `${destination}.quaymesh-${String(input.operation_id)}.part`;
      if (typeof input.temporary_path === "string" && input.temporary_path) {
        if (input.temporary_path !== expected) throw new Error("COPY_TEMPORARY_PATH_MISMATCH");
        await unlink(expected).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
      if (sessionRuntime?.store.findOperationEvent(String(input.operation_id))) await sessionRuntime.service.finishOperationById(String(input.operation_id), {
        status: OperationState.unknown, effect: "unknown", error_code: "COPY_PROCESS_INTERRUPTED",
        error_message: "文件传输进程中断，请检查目标文件；操作不会自动重复。",
      });
    },
    artifactWrite: async (input, source: Readable, signal, progress) => {
      const destination = await workspacePath(input); await mkdir(dirname(destination), { recursive: true });
      const temporary = typeof input.temporary_path === "string" ? input.temporary_path : `${destination}.quaymesh-${randomUUID()}.part`;
      if (dirname(temporary) !== dirname(destination)) throw new Error("COPY_TEMPORARY_PATH_MISMATCH");
      let bytes = 0;
      try {
        const fd = await open(temporary, "wx", 0o600);
        const counter = new Transform({ transform(chunk: Buffer, _encoding, done) {
          try {
            bytes += chunk.length; progress(bytes);
            if (bytes > config.artifactMaxFileBytes) done(new Error("文件超过传输上限")); else done(null, chunk);
          } catch (error) { done(error as Error); }
        } });
        await pipeline(source, counter, fd.createWriteStream({ autoClose: true }), { signal });
        if (typeof input.expectedBytes === "number" && bytes !== input.expectedBytes) throw new Error("源文件在传输期间改变，请重新复制。");
        if (input.overwrite === true) await rename(temporary, destination);
        else { await link(temporary, destination); await unlink(temporary); }
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    },
  });
  if (sessionRuntime) new SessionFeed(runtime, sessionRuntime.store, sessionRuntime.projector, sessionRuntime.service);
  return runtime;
}
