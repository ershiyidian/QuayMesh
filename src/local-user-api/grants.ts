import {createHash, randomBytes, randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import type Database from "better-sqlite3";
import {runSqliteWrite} from "../db/async-write.js";
import {TaskAccessResolver, taskPrincipalFromAuthInfo, requireTaskPrincipal, type TaskPrincipal} from "../tasks/task-access.js";
import {currentInvocation} from "../session/invocations.js";
import type {TrustedInvocationEnvelope} from "../federation/session-types.js";
import type {TaskPeerCapability, TaskPeerGrant} from "../messaging/task-peer-mailbox.js";
import {LOCAL_USER_API_PROTOCOL, identifier, localApiError as failure} from "./protocol.js";

export const DEFAULT_LOCAL_CAPABILITIES = ["status:read", "tasks:read", "events:read"] as const;
export type LocalCapability = typeof DEFAULT_LOCAL_CAPABILITIES[number] | TaskPeerCapability;
const capabilities = new Set<string>([...DEFAULT_LOCAL_CAPABILITIES, "peer:send", "peer:read", "peer:ack"]);
const verified = Symbol("verified-local-user-grant");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const localCredentialHash = (credential: string) => digest(`${LOCAL_USER_API_PROTOCOL}\0${credential}`);
const newCredential = () => `qml1_${randomBytes(32).toString("base64url")}`;
interface GrantRow {
  id: string; client_id: string; client_name: string; owner_id: string; node_id: string; revision: number;
  credential_hash: string; capabilities_json: string; task_ids_json: string | null; peer_task_ids_json: string | null;
  source_task_id: string | null; kind: "user" | "model"; created_at: number; expires_at: number; revoked_at: number | null;
}
interface DispatchRow {invocation_id: string; operation_id: string; owner_id: string; task_id: string; node_id: string; expires_at: number; grant_id: string | null}
export interface LocalVerifier {grantId: string; credentialHash: string; nodeId: string; revision: number; expiresAt: number}
export interface LocalAuthentication {grantId: string; revision: number}
export interface VerifiedLocalGrant extends TaskPeerGrant {
  readonly [verified]: true; readonly nodeId: string; readonly revision: number;
  readonly taskIds: readonly string[] | null; readonly expiresAt: number; readonly kind: "user" | "model";
  readonly peerTaskIds: readonly string[] | null;
  assertCurrent(capability: LocalCapability, taskIds: readonly string[]): void;
}
export interface LocalGrantInput {
  nodeId: string; clientName: string; capabilities?: readonly LocalCapability[];
  taskIds?: readonly string[] | null; peerTaskIds?: readonly string[] | null; sourceTaskId?: string | null; expiresAt: number;
}
function ids(value: readonly string[] | null | undefined): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 256 || value.some(id => !identifier(id))) throw failure("LOCAL_API_INVALID_GRANT");
  return [...new Set(value)];
}
const parseIds = (value: string | null): readonly string[] | null => value === null ? null : Object.freeze(JSON.parse(value) as string[]);

/** Central authority. The actual transport peer supplies nodeId; JSON does
 * not supply an owner, source Task, principal, or arbitrary request path. */
export class LocalUserGrantStore {
  private readonly access: TaskAccessResolver;
  private readonly changes = new EventEmitter();
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    this.access = new TaskAccessResolver(db, {ownerSource: "legacy-session"});
  }
  async issueUser(principal: TaskPrincipal, input: LocalGrantInput) {
    requireTaskPrincipal(principal);
    return runSqliteWrite(this.db, () => this.create(principal, input, "user"));
  }
  /** Called at real exec dispatch under the invocation recorder, never from
   * the local API request body. The durable invocation and member must agree. */
  async recordCurrentDispatch(nodeId: string, trusted: TrustedInvocationEnvelope): Promise<void> {
    const current = currentInvocation();
    if (!identifier(nodeId) || !current || current.tool_name !== "exec_command" || !current.operation_id
      || !current.task_id || current.invocation_id !== trusted.invocation_id || current.operation_id !== trusted.operation_id
      || current.owner_id !== trusted.owner_id || current.task_id !== trusted.task_id
      || current.session_id !== trusted.session_id || current.member_id !== trusted.member_id)
      throw failure("LOCAL_API_EXECUTION_BINDING_REQUIRED");
    await runSqliteWrite(this.db, () => {
      const row = this.db.prepare(`SELECT i.id FROM qm_invocations i JOIN qm_tasks t ON t.id=i.task_id
        JOIN qm_sessions s ON s.id=t.session_id JOIN qm_session_members m ON m.id=i.member_id
        JOIN qm_task_members tm ON tm.task_id=t.id AND tm.member_id=m.id
        WHERE i.id=? AND i.operation_id=? AND i.owner_id=? AND i.task_id=? AND i.session_id=? AND i.member_id=?
          AND i.tool_name='exec_command' AND i.state='running' AND s.owner_id=i.owner_id AND t.state='active' AND m.node_id=?`)
        .get(current.invocation_id, current.operation_id, current.owner_id, current.task_id, current.session_id, current.member_id, nodeId);
      if (!row) throw failure("LOCAL_API_EXECUTION_BINDING_REQUIRED");
      const saved = this.db.prepare("SELECT * FROM qm_local_api_dispatches WHERE invocation_id=?").get(current.invocation_id) as DispatchRow | undefined;
      if (saved && (saved.operation_id !== current.operation_id || saved.owner_id !== current.owner_id
        || saved.task_id !== current.task_id || saved.node_id !== nodeId)) throw failure("LOCAL_API_EXECUTION_BINDING_REQUIRED");
      this.db.prepare(`INSERT OR IGNORE INTO qm_local_api_dispatches(invocation_id,operation_id,owner_id,task_id,node_id,expires_at)
        VALUES(?,?,?,?,?,?)`).run(current.invocation_id, current.operation_id, current.owner_id, current.task_id, nodeId, this.now() + 15 * 60_000);
    });
  }
  /** peerId comes from PeerTransport. No owner/source identity is accepted. */
  async issueModel(peerId: string, invocationId: string) {
    if (!identifier(peerId) || !identifier(invocationId)) throw failure("LOCAL_API_UNAUTHORIZED");
    return runSqliteWrite(this.db, () => {
      const route = this.db.prepare("SELECT * FROM qm_local_api_dispatches WHERE invocation_id=? AND node_id=?")
        .get(invocationId, peerId) as DispatchRow | undefined;
      if (!route || route.expires_at <= this.now()) throw failure("LOCAL_API_EXECUTION_BINDING_REQUIRED");
      const invocation = this.db.prepare(`SELECT 1 FROM qm_invocations WHERE id=? AND operation_id=? AND owner_id=?
        AND task_id=? AND tool_name='exec_command' AND state='running'`).get(invocationId, route.operation_id, route.owner_id, route.task_id);
      if (!invocation) throw failure("LOCAL_API_EXECUTION_BINDING_REQUIRED");
      const principal = taskPrincipalFromAuthInfo({extra: {owner_id: route.owner_id}});
      if (this.access.resolveInTransaction(principal, route.task_id).state !== "active") throw failure("LOCAL_API_EXECUTION_BINDING_REQUIRED");
      if (route.grant_id) {
        const prior = this.db.prepare("SELECT * FROM qm_local_api_grants WHERE id=? AND kind='model'").get(route.grant_id) as GrantRow | undefined;
        if (!prior || prior.revoked_at !== null || prior.expires_at <= this.now()) throw failure("LOCAL_API_UNAUTHORIZED");
        const credential = newCredential();
        this.db.prepare("UPDATE qm_local_api_grants SET credential_hash=?,revision=revision+1 WHERE id=?").run(localCredentialHash(credential), prior.id);
        return {...this.publicRow({...prior, revision: prior.revision + 1}), credential, audience: LOCAL_USER_API_PROTOCOL};
      }
      const result = this.create(principal, {nodeId: peerId, clientName: "Task terminal", sourceTaskId: route.task_id,
        taskIds: [route.task_id], peerTaskIds: null, expiresAt: route.expires_at,
        capabilities: [...DEFAULT_LOCAL_CAPABILITIES, "peer:send", "peer:read", "peer:ack"]}, "model");
      this.db.prepare("UPDATE qm_local_api_dispatches SET grant_id=? WHERE invocation_id=?").run(result.grantId, invocationId);
      return result;
    });
  }
  authenticateForwarded(peerId: string, identity: LocalAuthentication): VerifiedLocalGrant {
    if (!identifier(peerId) || !identifier(identity?.grantId) || !Number.isSafeInteger(identity?.revision)) throw failure("LOCAL_API_UNAUTHORIZED");
    const row = this.current(identity.grantId, peerId, identity.revision);
    const principal = taskPrincipalFromAuthInfo({extra: {owner_id: row.owner_id}});
    const grant: VerifiedLocalGrant = Object.freeze({[verified]: true as const, principal, clientId: row.client_id, grantId: row.id,
      nodeId: row.node_id, revision: row.revision, sourceTaskId: row.source_task_id, taskIds: parseIds(row.task_ids_json), peerTaskIds: parseIds(row.peer_task_ids_json),
      expiresAt: row.expires_at, kind: row.kind,
      assertCurrent: (capability: LocalCapability, taskIds: readonly string[]) => {
        const latest = this.current(row.id, peerId, row.revision);
        if (latest.owner_id !== row.owner_id || latest.client_id !== row.client_id || latest.source_task_id !== row.source_task_id)
          throw failure("LOCAL_API_UNAUTHORIZED");
        if (!(JSON.parse(latest.capabilities_json) as string[]).includes(capability)) throw failure("LOCAL_API_CAPABILITY_DENIED");
        const scope = parseIds(capability.startsWith("peer:") ? latest.peer_task_ids_json : latest.task_ids_json);
        for (const taskId of taskIds) {
          if (!identifier(taskId) || scope && !scope.includes(taskId)) throw failure("LOCAL_API_TASK_SCOPE_DENIED");
          this.access.resolve(principal, taskId);
        }
      }});
    return grant;
  }
  verifier(grantId: string): LocalVerifier {
    const row = this.db.prepare("SELECT * FROM qm_local_api_grants WHERE id=?").get(grantId) as GrantRow | undefined;
    if (!row || row.revoked_at !== null || row.expires_at <= this.now()) throw failure("LOCAL_API_UNAUTHORIZED");
    return {grantId: row.id, credentialHash: row.credential_hash, nodeId: row.node_id, revision: row.revision, expiresAt: row.expires_at};
  }
  list(principal: TaskPrincipal) {
    requireTaskPrincipal(principal);
    return (this.db.prepare("SELECT * FROM qm_local_api_grants WHERE owner_id=? AND kind='user' ORDER BY created_at DESC,id LIMIT 100")
      .all(principal.ownerId) as GrantRow[]).map(row => this.publicRow(row));
  }
  async revoke(principal: TaskPrincipal, grantId: string): Promise<void> {
    requireTaskPrincipal(principal);
    await runSqliteWrite(this.db, () => {
      const result = this.db.prepare("UPDATE qm_local_api_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id=? AND owner_id=?")
        .run(this.now(), grantId, principal.ownerId);
      if (!result.changes) throw failure("LOCAL_API_GRANT_NOT_FOUND");
    });
    this.changes.emit("invalidated", grantId);
  }
  async rotate(principal: TaskPrincipal, grantId: string) {
    requireTaskPrincipal(principal);
    const credential = newCredential();
    const result = await runSqliteWrite(this.db, () => {
      const row = this.db.prepare("SELECT * FROM qm_local_api_grants WHERE id=? AND owner_id=? AND kind='user'")
        .get(grantId, principal.ownerId) as GrantRow | undefined;
      if (!row || row.revoked_at !== null || row.expires_at <= this.now()) throw failure("LOCAL_API_GRANT_NOT_FOUND");
      this.db.prepare("UPDATE qm_local_api_grants SET credential_hash=?,revision=revision+1 WHERE id=?").run(localCredentialHash(credential), grantId);
      return {...this.publicRow({...row, revision: row.revision + 1}), credential, audience: LOCAL_USER_API_PROTOCOL};
    });
    this.changes.emit("invalidated", grantId);
    return result;
  }
  onInvalidated(listener: (grantId: string) => void) {this.changes.on("invalidated", listener); return () => this.changes.off("invalidated", listener);}
  private current(id: string, nodeId: string, revision: number): GrantRow {
    const row = this.db.prepare("SELECT * FROM qm_local_api_grants WHERE id=? AND node_id=? AND revision=?").get(id, nodeId, revision) as GrantRow | undefined;
    if (!row || row.revoked_at !== null || row.expires_at <= this.now()) throw failure("LOCAL_API_UNAUTHORIZED");
    return row;
  }
  private publicRow(row: GrantRow) {
    return {grantId: row.id, clientId: row.client_id, clientName: row.client_name, nodeId: row.node_id, revision: row.revision,
      capabilities: JSON.parse(row.capabilities_json) as LocalCapability[], taskIds: parseIds(row.task_ids_json),
      peerTaskIds: parseIds(row.peer_task_ids_json), sourceTaskId: row.source_task_id, expiresAt: row.expires_at,
      createdAt: row.created_at, revokedAt: row.revoked_at};
  }
  private create(principal: TaskPrincipal, input: LocalGrantInput, kind: "user" | "model") {
    requireTaskPrincipal(principal);
    if (!identifier(input.nodeId) || typeof input.clientName !== "string" || !input.clientName.trim() || input.clientName.length > 128
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.now()
      || input.expiresAt > this.now() + (kind === "model" ? 15 * 60_000 : 90 * 86_400_000)) throw failure("LOCAL_API_INVALID_GRANT");
    const scopes = [...new Set(input.capabilities ?? DEFAULT_LOCAL_CAPABILITIES)], tasks = ids(input.taskIds), peerTasks = ids(input.peerTaskIds);
    if (!scopes.length || scopes.some(scope => !capabilities.has(scope))) throw failure("LOCAL_API_INVALID_GRANT");
    const source = input.sourceTaskId ?? null;
    if (scopes.some(scope => scope.startsWith("peer:")) && !identifier(source)) throw failure("LOCAL_API_TASK_BINDING_REQUIRED");
    for (const taskId of [...(tasks ?? []), ...(peerTasks ?? []), ...(source ? [source] : [])]) this.access.resolveInTransaction(principal, taskId);
    if (source && (tasks && !tasks.includes(source) || peerTasks && !peerTasks.includes(source))) throw failure("LOCAL_API_TASK_SCOPE_DENIED");
    const credential = newCredential(), id = `localgrant_${randomUUID()}`;
    const row: GrantRow = {id, client_id: kind === "model" ? `localclient_task_${digest(`${principal.ownerId}\0${source}`).slice(0, 32)}` : `localclient_${randomUUID()}`,
      client_name: input.clientName, owner_id: principal.ownerId, node_id: input.nodeId, revision: 1,
      credential_hash: localCredentialHash(credential), capabilities_json: JSON.stringify(scopes),
      task_ids_json: tasks ? JSON.stringify(tasks) : null, peer_task_ids_json: peerTasks ? JSON.stringify(peerTasks) : null,
      source_task_id: source, kind, created_at: this.now(), expires_at: input.expiresAt, revoked_at: null};
    this.db.prepare(`INSERT INTO qm_local_api_grants(id,client_id,client_name,owner_id,node_id,revision,credential_hash,
      capabilities_json,task_ids_json,peer_task_ids_json,source_task_id,kind,created_at,expires_at,revoked_at)
      VALUES(@id,@client_id,@client_name,@owner_id,@node_id,@revision,@credential_hash,@capabilities_json,
      @task_ids_json,@peer_task_ids_json,@source_task_id,@kind,@created_at,@expires_at,@revoked_at)`).run(row);
    return {...this.publicRow(row), credential, audience: LOCAL_USER_API_PROTOCOL};
  }
}

/** Node-local verifier, not an authority. A stale mirror cannot defeat the
 * center's revision. Credentials and hashes never enter forwarded requests. */
export class LocalCredentialVerifier {
  constructor(private readonly db: Database.Database, readonly nodeId: string, private readonly now: () => number = Date.now) {}
  async install(value: LocalVerifier): Promise<void> {
    if (!value || value.nodeId !== this.nodeId || !identifier(value.grantId) || !/^[a-f0-9]{64}$/.test(value.credentialHash)
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now())
      throw failure("LOCAL_API_INVALID_GRANT");
    await runSqliteWrite(this.db, () => this.db.prepare(`INSERT INTO qm_local_api_verifiers(grant_id,credential_hash,node_id,revision,expires_at)
      VALUES(?,?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET credential_hash=excluded.credential_hash,revision=excluded.revision,expires_at=excluded.expires_at
      WHERE excluded.revision>=qm_local_api_verifiers.revision`).run(value.grantId, value.credentialHash, value.nodeId, value.revision, value.expiresAt));
  }
  authenticate(credential: unknown): LocalAuthentication {
    if (typeof credential !== "string" || !/^qml1_[A-Za-z0-9_-]{43}$/.test(credential)) throw failure("LOCAL_API_UNAUTHORIZED");
    const row = this.db.prepare("SELECT grant_id,revision FROM qm_local_api_verifiers WHERE credential_hash=? AND node_id=? AND expires_at>?")
      .get(localCredentialHash(credential), this.nodeId, this.now()) as {grant_id: string; revision: number} | undefined;
    if (!row) throw failure("LOCAL_API_UNAUTHORIZED");
    return {grantId: row.grant_id, revision: row.revision};
  }
}
export function requireVerifiedLocalGrant(grant: VerifiedLocalGrant): void {
  if (!grant || grant[verified] !== true) throw failure("LOCAL_API_UNAUTHORIZED");
}
