import { isDeepStrictEqual } from "node:util";
import { WorkLedger } from "../work-ledger.js";
import { receiptResponsePending } from "../console-receipt-state.js";
import { WorkbenchError } from "./types.js";

export type WriteEffect = "none" | "applied" | "partial" | "unknown";
export type ReceiptState = "started" | "completed" | "rejected" | "partial" | "unknown";
interface ReceiptRow {
  scope: string; request_key: string; method: string; path: string; arguments_json: string;
  state: ReceiptState; response_json: string | null; created_at: string; finished_at: string | null;
}
interface ReceiptError { message: string; status: number; code: string; effect: WriteEffect }
interface SavedResult { kind: "result"; value: unknown; effect: WriteEffect }
interface SavedError { kind: "error"; error: ReceiptError; effect: WriteEffect }
export interface WriteReceipt {
  scope: string; requestKey: string; path: string; state: ReceiptState; effect: WriteEffect;
  createdAt: string; finishedAt: string | null; response?: unknown; error?: ReceiptError;
}
export interface VerifiedReceipt {
  verified: boolean; effect?: WriteEffect; response?: unknown; error?: ReceiptError;
}

export function writeEffect(error: unknown): WriteEffect {
  const value = error && typeof error === "object" ? (error as { effect?: unknown }).effect : undefined;
  if (value === "none" || value === "not_started") return "none";
  if (value === "applied" || value === "completed") return "applied";
  if (value === "partial") return "partial";
  return "unknown";
}

function decode(row: ReceiptRow): WriteReceipt {
  const saved = row.response_json ? JSON.parse(row.response_json) : null;
  let response: unknown, error: ReceiptError | undefined;
  let effect: WriteEffect = "unknown";
  if (saved?.kind === "result") { response = saved.value; effect = saved.effect ?? "applied"; }
  else if (saved?.kind === "error") { error = saved.error; effect = saved.effect ?? "unknown"; }
  else if (row.state === "completed") { response = saved; effect = "applied"; }
  else if (saved) { error = { ...saved, effect: "unknown" }; }
  return { scope: row.scope, requestKey: row.request_key, path: row.path, state: row.state, effect,
    createdAt: row.created_at, finishedAt: row.finished_at,
    ...(response !== undefined ? { response } : {}), ...(error ? { error } : {}) };
}

function resultEffect(result: unknown): WriteEffect {
  if (!result || typeof result !== "object") return "applied";
  const value = result as { effect?: unknown; outcome?: unknown; status?: unknown };
  const explicit = value.effect ?? value.outcome;
  if (["none", "applied", "partial", "unknown"].includes(String(explicit))) return explicit as WriteEffect;
  return value.status === "partial" ? "partial" : value.status === "unknown" ? "unknown" : "applied";
}

export class WriteReceipts {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly stateDir: string) {}

  get(scope: string, requestKey: string): WriteReceipt | null {
    const ledger = new WorkLedger(this.stateDir);
    try {
      const row = ledger.db.prepare("SELECT * FROM console_write_receipts WHERE scope=? AND request_key=?")
        .get(scope, requestKey) as ReceiptRow | undefined;
      return row ? decode(row) : null;
    } finally { ledger.close(); }
  }

  list(scopePrefix: string, limit = 50): WriteReceipt[] {
    const ledger = new WorkLedger(this.stateDir);
    try {
      return (ledger.db.prepare(`SELECT * FROM console_write_receipts WHERE substr(scope,1,?)=?
        ORDER BY created_at DESC,scope,request_key LIMIT ?`).all(scopePrefix.length, scopePrefix, Math.min(200, Math.max(1, limit))) as ReceiptRow[]).map(decode);
    } finally { ledger.close(); }
  }

  async execute<T>(scope: string, requestKey: string, path: string, body: unknown, operation: () => T | Promise<T>): Promise<T> {
    const ledger = new WorkLedger(this.stateDir);
    const identity = JSON.stringify([scope, requestKey]);
    try {
      const inserted = ledger.db.prepare(`INSERT INTO console_write_receipts
        (scope,request_key,method,path,arguments_json,state,created_at) VALUES (?,?,'POST',?,?,'started',?)
        ON CONFLICT(scope,request_key) DO NOTHING`)
        .run(scope, requestKey, path, JSON.stringify(body), new Date().toISOString());
      if (!inserted.changes) {
        const prior = ledger.db.prepare("SELECT * FROM console_write_receipts WHERE scope=? AND request_key=?")
          .get(scope, requestKey) as ReceiptRow;
        if (prior.method !== "POST" || prior.path !== path || !isDeepStrictEqual(JSON.parse(prior.arguments_json), body)) {
          throw new WorkbenchError("相同请求标识对应的操作内容发生变化，请重新确认操作", 409, "request_conflict", "none");
        }
        const pending = this.pending.get(identity);
        if (pending) return await pending as T;
        const receipt = decode(prior);
        if ("response" in receipt) return receipt.response as T;
        if (receipt.error) throw new WorkbenchError(receipt.error.message, receipt.error.status, receipt.error.code, receipt.effect);
        throw new WorkbenchError("原操作的执行结果尚未确认，请查询原请求回执", 409, "write_outcome_unknown", "unknown");
      }
      const work = Promise.resolve().then(operation).then((result) => {
        const effect = resultEffect(result);
        const saved: SavedResult = { kind: "result", value: result ?? null, effect };
        ledger.db.prepare("UPDATE console_write_receipts SET state=?,response_json=?,finished_at=? WHERE scope=? AND request_key=?")
          .run(effect === "partial" || effect === "unknown" ? effect : effect === "none" ? "rejected" : "completed", JSON.stringify(saved), new Date().toISOString(), scope, requestKey);
        return result;
      }, (error: unknown) => {
        const effect = writeEffect(error);
        const known = error instanceof WorkbenchError;
        const failure: ReceiptError = { message: error instanceof Error ? error.message : String(error), status: known ? error.status : 500,
          code: known ? error.code : "write_outcome_unknown", effect };
        const saved: SavedError = { kind: "error", error: failure, effect };
        ledger.db.prepare("UPDATE console_write_receipts SET state=?,response_json=?,finished_at=? WHERE scope=? AND request_key=?")
          .run(effect === "none" ? "rejected" : effect === "partial" ? "partial" : "unknown", JSON.stringify(saved), new Date().toISOString(), scope, requestKey);
        throw new WorkbenchError(failure.message, failure.status, failure.code, effect);
      }).finally(() => this.pending.delete(identity));
      this.pending.set(identity, work);
      return await work;
    } finally { ledger.close(); }
  }

  async reconcile(scope: string, requestKey: string, verify: (original: { path: string; body: unknown; receipt: WriteReceipt }) => Promise<VerifiedReceipt>): Promise<WriteReceipt | null> {
    const pending = this.pending.get(JSON.stringify([scope, requestKey]));
    if (pending) { try { await pending; } catch {} }
    const ledger = new WorkLedger(this.stateDir);
    try {
      const row = ledger.db.prepare("SELECT * FROM console_write_receipts WHERE scope=? AND request_key=?")
        .get(scope, requestKey) as ReceiptRow | undefined;
      if (!row) return null;
      const receipt = decode(row);
      if (receipt.state === "rejected" || receipt.state === "completed" && !receiptResponsePending(receipt.response)) return receipt;
      // 核对函数只读取既有事实，不重新派发原动作。
      const verified = await verify({ path: row.path, body: JSON.parse(row.arguments_json), receipt });
      if (!verified.verified) return receipt;
      const effect = verified.effect ?? (verified.error ? verified.error.effect : "applied");
      const saved: SavedResult | SavedError = verified.error
        ? { kind: "error", error: verified.error, effect }
        : { kind: "result", value: verified.response ?? null, effect };
      const state = effect === "partial" || effect === "unknown" ? effect : verified.error || effect === "none" ? "rejected" : "completed";
      ledger.db.prepare(`UPDATE console_write_receipts SET state=?,response_json=?,finished_at=?
        WHERE scope=? AND request_key=? AND state=? AND response_json IS ?`)
        .run(state, JSON.stringify(saved), new Date().toISOString(), scope, requestKey, row.state, row.response_json);
      const updated = ledger.db.prepare("SELECT * FROM console_write_receipts WHERE scope=? AND request_key=?")
        .get(scope, requestKey) as ReceiptRow;
      return decode(updated);
    } finally { ledger.close(); }
  }
}
