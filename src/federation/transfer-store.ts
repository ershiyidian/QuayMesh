import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { TrustedInvocationEnvelope } from "./session-types.js";

export interface TransferRequest {
  requestKey: string;
  sourceNode: string;
  sourceWorkspace: string;
  sourcePath: string;
  destinationWorkspace: string;
  destinationPath: string;
  overwrite: boolean;
  context?: TrustedInvocationEnvelope;
}

export interface TransferView {
  id: string;
  operationId: string;
  nodeId: string;
  taskId?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  source: string;
  destination: string;
  bytes: number;
  totalBytes: number | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface TransferRow {
  id: string; operation_id: string; request_key: string; owner_id: string;
  session_id: string | null; task_id: string | null; member_id: string | null;
  source_node: string; source_workspace: string; source_path: string;
  destination_workspace: string; destination_path: string; overwrite: number;
  status: TransferView["status"]; bytes: number; total_bytes: number | null; temporary_path: string | null;
  error: string | null; started_at: string; finished_at: string | null;
}

export class TransferStore {
  private readonly database: DatabaseHandle;
  constructor(stateDir: string, private readonly nodeId: string) { this.database = openDatabase(stateDir); }

  reserve(request: TransferRequest): { view: TransferView; created: boolean } {
    return this.database.sqlite.transaction(() => {
      const owner = request.context?.owner_id ?? `node:${this.nodeId}`;
      const existing = this.database.sqlite.prepare("SELECT * FROM qm_transfers WHERE owner_id=? AND request_key=?")
        .get(owner, request.requestKey) as TransferRow | undefined;
      if (existing) {
        if (existing.source_node !== request.sourceNode || existing.source_workspace !== request.sourceWorkspace ||
          existing.source_path !== request.sourcePath || existing.destination_workspace !== request.destinationWorkspace ||
          existing.destination_path !== request.destinationPath || Boolean(existing.overwrite) !== request.overwrite ||
          existing.task_id !== (request.context?.task_id ?? null)) throw new Error("COPY_REQUEST_KEY_REUSED");
        return { view: this.view(existing), created: false };
      }
      const uuid = randomUUID();
      const id = `qm:${encodeURIComponent(this.nodeId)}:copy_${uuid}`;
      this.database.sqlite.prepare(`INSERT INTO qm_transfers
        (id,operation_id,request_key,owner_id,session_id,task_id,member_id,source_node,source_workspace,source_path,
        destination_workspace,destination_path,overwrite,status,bytes,total_bytes,started_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'running',0,NULL,?)`).run(id, `op_copy_${uuid}`, request.requestKey, owner,
          request.context?.session_id ?? null, request.context?.task_id ?? null, request.context?.member_id ?? null,
          request.sourceNode, request.sourceWorkspace, request.sourcePath, request.destinationWorkspace,
          request.destinationPath, request.overwrite ? 1 : 0, new Date().toISOString());
      return { view: this.get(id)!, created: true };
    }).immediate();
  }

  get(id: string): TransferView | null {
    const row = this.database.sqlite.prepare("SELECT * FROM qm_transfers WHERE id=?").get(id) as TransferRow | undefined;
    return row ? this.view(row) : null;
  }

  list(limit = 40): TransferView[] {
    return (this.database.sqlite.prepare("SELECT * FROM qm_transfers ORDER BY started_at DESC,id DESC LIMIT ?")
      .all(limit) as TransferRow[]).map(row => this.view(row));
  }

  active(): TransferRow[] {
    return this.database.sqlite.prepare("SELECT * FROM qm_transfers WHERE status='running'").all() as TransferRow[];
  }

  prepared(id: string, temporaryPath: string, totalBytes: number): void {
    this.database.sqlite.prepare("UPDATE qm_transfers SET temporary_path=?,total_bytes=? WHERE id=? AND status='running'")
      .run(temporaryPath, totalBytes, id);
  }

  progress(id: string, bytes: number): void {
    this.database.sqlite.prepare("UPDATE qm_transfers SET bytes=? WHERE id=? AND status='running'").run(bytes, id);
  }

  finish(id: string, status: Exclude<TransferView["status"], "running">, bytes: number, error?: string, cleanupComplete = true): void {
    this.database.sqlite.prepare("UPDATE qm_transfers SET status=?,bytes=?,error=?,finished_at=?,temporary_path=CASE WHEN ?=1 THEN NULL ELSE temporary_path END WHERE id=? AND status='running'")
      .run(status, bytes, error ?? null, new Date().toISOString(), cleanupComplete ? 1 : 0, id);
  }

  recoveryRequest(row: TransferRow): { workspace_id: string; path: string; temporary_path: string | null; operation_id: string } {
    return { workspace_id: row.destination_workspace, path: row.destination_path, temporary_path: row.temporary_path, operation_id: row.operation_id };
  }

  close(): void { this.database.close(); }

  private view(row: TransferRow): TransferView {
    return { id: row.id, operationId: row.operation_id, nodeId: this.nodeId, ...(row.task_id ? { taskId: row.task_id } : {}),
      status: row.status, source: `${row.source_node}:${row.source_path}`, destination: row.destination_path,
      bytes: row.bytes, totalBytes: row.total_bytes, startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}), ...(row.error ? { error: row.error } : {}) };
  }
}
