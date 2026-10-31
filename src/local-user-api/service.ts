import type Database from "better-sqlite3";
import type {ServerConfig} from "../config.js";
import type {FederationRuntime} from "../federation/runtime.js";
import type {TrustedInvocationEnvelope} from "../federation/session-types.js";
import {isTaskBindingAuthority} from "../tasks/task-binding.js";
import type {TaskPrincipal} from "../tasks/task-access.js";
import {currentInvocation} from "../session/invocations.js";
import {logEvent} from "../logger.js";
import {WorkbenchFeed} from "../console-workbench/feed.js";
import {TaskPeerMailboxStore} from "../messaging/task-peer-mailbox.js";
import {LocalUserGrantStore, LocalCredentialVerifier, type LocalGrantInput, type LocalVerifier} from "./grants.js";
import {LocalObservationStore} from "./observations.js";
import {LocalUserDispatcher} from "./dispatcher.js";
import {LocalApiSessions, startLocalUnixApi} from "./ipc.js";
import {connectNativeUserChannel} from "./native-channel.js";
import {LOCAL_USER_API_PROTOCOL, localApiError, localApiParams, object, identifier} from "./protocol.js";

export interface LocalApiPeerHooks {
  receive(peerId: string, method: "call" | "terminal" | "install" | "describe", params: unknown, signal?: AbortSignal): Promise<unknown>;
  beforeExec(nodeId: string, trusted: TrustedInvocationEnvelope): Promise<void>;
}
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).every(key => keys.includes(key));
export class LocalUserApiService implements LocalApiPeerHooks {
  readonly localId: string;
  readonly authorityId: string;
  readonly authority: boolean;
  readonly sessions: LocalApiSessions;
  private readonly grants?: LocalUserGrantStore;
  private readonly dispatcher?: LocalUserDispatcher;
  private readonly verifier: LocalCredentialVerifier;
  private listener?: Awaited<ReturnType<typeof startLocalUnixApi>>;
  private endpoint: string | null = null;
  private readonly apiDirectory: string;
  private readonly nativeBridgeKey: Buffer;
  private nativeChannel?: ReturnType<typeof connectNativeUserChannel>;
  startupError: string | null = null;
  constructor(private readonly config: ServerConfig, private readonly db: Database.Database, private readonly runtime?: FederationRuntime) {
    this.apiDirectory = process.env.QUAYMESH_LOCAL_API_CONFIG_DIR || config.configDir;
    const key = process.env.QUAYMESH_LOCAL_API_BRIDGE_KEY;
    this.nativeBridgeKey = Buffer.from(process.platform === "win32" && typeof key === "string" && /^[a-f0-9]{64}$/.test(key) ? key : "");
    delete process.env.QUAYMESH_LOCAL_API_BRIDGE_KEY;
    this.localId = config.federation?.nodeId ?? "local";
    this.authorityId = config.federation?.enabled ? config.federation.coordinatorId ?? this.localId : this.localId;
    this.authority = isTaskBindingAuthority(config);
    this.verifier = new LocalCredentialVerifier(db, this.localId);
    if (this.authority) {
      this.grants = new LocalUserGrantStore(db);
      const feed = new WorkbenchFeed(config, runtime), activityResolver = (ids: readonly string[]) => feed.taskActivities(ids);
      this.dispatcher = new LocalUserDispatcher(this.grants, new LocalObservationStore(db, this.localId, activityResolver),
        new TaskPeerMailboxStore(db, {ownerSource: "legacy-session", activityResolver}));
    }
    this.sessions = new LocalApiSessions(this.verifier, (identity, method, params, signal) =>
      this.toAuthority("call", {...identity, method, params}, signal));
  }
  async start(): Promise<void> {
    if (process.platform === "win32") {
      const endpoint = process.env.QUAYMESH_LOCAL_API_ENDPOINT;
      const internal = process.env.QUAYMESH_LOCAL_API_INTERNAL_PIPE;
      if (this.nativeBridgeKey.length && typeof endpoint === "string" && /^\\\\\.\\pipe\\QuayMesh\.LocalUser\.[A-Za-z0-9._-]+$/.test(endpoint)
        && typeof internal === "string") {
        try {this.nativeChannel = connectNativeUserChannel({endpoint: internal, key: this.nativeBridgeKey.toString(), nodeId: this.localId,
          configDir: this.apiDirectory, sessions: this.sessions, ready: connected => {this.endpoint = connected ? endpoint : null;}});}
        catch (error) {this.noteUnavailable(error);}
      }
      return;
    }
    try {
      this.listener = await startLocalUnixApi({configDir: this.apiDirectory, nodeId: this.localId, sessions: this.sessions});
      this.endpoint = this.listener.endpoint;
    } catch (error) {this.startupError = this.failureCode(error); this.noteUnavailable(error);}
  }
  async close() {this.sessions.close(); await this.nativeChannel?.close(); await this.listener?.close(); this.endpoint = null; this.nativeBridgeKey.fill(0);}
  async beforeExec(nodeId: string, trusted: TrustedInvocationEnvelope): Promise<void> {
    if (this.authority) {
      try {await this.grants!.recordCurrentDispatch(nodeId, trusted);} catch (error) {this.noteUnavailable(error);}
    }
  }
  async terminalEnvironment(): Promise<NodeJS.ProcessEnv> {
    const current = currentInvocation();
    if (!current || current.tool_name !== "exec_command" || !current.task_id || !current.operation_id || !this.endpoint) return {};
    // Standalone/local authority execution may bypass federation.routeTool.
    try {
      if (this.authority) await this.grants!.recordCurrentDispatch(this.localId, {...current, request_id: String(current.request_id)});
      const result = await this.toAuthority("terminal", {invocationId: current.invocation_id}) as {enrollment: {credential: string}; verifier: LocalVerifier};
      await this.verifier.install(result.verifier);
      return {QUAYMESH_LOCAL_API_ENDPOINT: this.endpoint, QUAYMESH_LOCAL_API_CREDENTIAL: result.enrollment.credential};
    } catch (error) {this.noteUnavailable(error); return {};}
  }
  async receive(peerId: string, method: "call" | "terminal" | "install" | "describe", input: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (method === "install") {
      if (peerId !== this.authorityId || !exact(input, ["verifier"])) throw localApiError("LOCAL_API_UNAUTHORIZED");
      await this.verifier.install(input.verifier as LocalVerifier); return {installed: true};
    }
    if (method === "describe") {
      if (peerId !== this.authorityId || !exact(input, []) || !this.endpoint) throw localApiError("LOCAL_API_UNAVAILABLE");
      return {protocol: LOCAL_USER_API_PROTOCOL, nodeId: this.localId, endpoint: this.endpoint};
    }
    if (!this.authority) throw localApiError("LOCAL_API_AUTHORITY_REQUIRED");
    if (method === "terminal") {
      if (!exact(input, ["invocationId"]) || !identifier(input.invocationId)) throw localApiError("LOCAL_API_INVALID_REQUEST");
      const enrollment = await this.grants!.issueModel(peerId, input.invocationId);
      return {enrollment, verifier: this.grants!.verifier(enrollment.grantId)};
    }
    if (!exact(input, ["grantId", "revision", "method", "params"]) || !identifier(input.grantId) || !Number.isSafeInteger(input.revision))
      throw localApiError("LOCAL_API_INVALID_REQUEST");
    const {method: name, params} = localApiParams(input.method, input.params);
    return this.dispatcher!.dispatch(peerId, {grantId: input.grantId, revision: Number(input.revision)}, name, params);
  }
  list(principal: TaskPrincipal) {return this.requireAuthority().list(principal);}
  async register(principal: TaskPrincipal, input: LocalGrantInput) {
    const grants = this.requireAuthority(), destination = await this.destination(input.nodeId);
    const enrollment = await grants.issueUser(principal, input);
    try {await this.install(enrollment.nodeId, grants.verifier(enrollment.grantId));}
    catch (error) {await grants.revoke(principal, enrollment.grantId); throw error;}
    return {...enrollment, endpoint: destination.endpoint};
  }
  async rotate(principal: TaskPrincipal, grantId: string) {
    const grants = this.requireAuthority(), prior = grants.list(principal).find(grant => grant.grantId === grantId);
    if (!prior) throw localApiError("LOCAL_API_GRANT_NOT_FOUND");
    const destination = await this.destination(prior.nodeId), enrollment = await grants.rotate(principal, grantId);
    await this.install(enrollment.nodeId, grants.verifier(enrollment.grantId));
    return {...enrollment, endpoint: destination.endpoint};
  }
  async revoke(principal: TaskPrincipal, grantId: string) {await this.requireAuthority().revoke(principal, grantId); return {revoked: true};}
  private requireAuthority() {if (!this.grants) throw localApiError("LOCAL_API_AUTHORITY_REQUIRED"); return this.grants;}
  private failureCode(error: unknown) {
    const code = (error as {code?: unknown} | null)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "LOCAL_API_UNAVAILABLE";
  }
  private noteUnavailable(error: unknown) {
    logEvent(this.config.logging, "warn", "local_user_api_unavailable", {nodeId: this.localId, code: this.failureCode(error)});
  }
  private toAuthority(method: "call" | "terminal", params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.authority ? this.receive(this.localId, method, params, signal)
      : this.runtime ? this.runtime.request(this.authorityId, `local-user.${method}`, params, 5_000, undefined, signal)
      : Promise.reject(localApiError("LOCAL_API_UNAVAILABLE"));
  }
  private async destination(nodeId: string) {
    if (!identifier(nodeId)) throw localApiError("LOCAL_API_INVALID_GRANT");
    const value = nodeId === this.localId ? await this.receive(this.localId, "describe", {})
      : await this.runtime?.request(nodeId, "local-user.describe", {}, 5_000);
    if (!object(value) || value.protocol !== LOCAL_USER_API_PROTOCOL || value.nodeId !== nodeId || typeof value.endpoint !== "string")
      throw localApiError("LOCAL_API_UNAVAILABLE");
    return {endpoint: value.endpoint};
  }
  private async install(nodeId: string, verifier: LocalVerifier) {
    if (nodeId === this.localId) await this.verifier.install(verifier);
    else if (this.runtime) await this.runtime.request(nodeId, "local-user.install", {verifier}, 5_000);
    else throw localApiError("LOCAL_API_UNAVAILABLE");
  }
}
