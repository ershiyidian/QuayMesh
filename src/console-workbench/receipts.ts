import { isDeepStrictEqual } from "node:util";
import { WorkLedger } from "../work-ledger.js";
import { WorkbenchError } from "./types.js";

interface ReceiptRow {
  method: string;
  path: string;
  arguments_json: string;
  state: string;
  response_json: string | null;
}

export class WriteReceipts {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly stateDir: string) {}

  async execute(scope: string, requestKey: string, path: string, body: unknown, operation: () => unknown | Promise<unknown>): Promise<unknown> {
    const ledger = new WorkLedger(this.stateDir);
    const identity = JSON.stringify([scope, requestKey]);
    try {
      const prior = ledger.db.prepare("SELECT * FROM console_write_receipts WHERE scope=? AND request_key=?")
        .get(scope, requestKey) as ReceiptRow | undefined;
      if (prior) {
        if (prior.method !== "POST" || prior.path !== path || !isDeepStrictEqual(JSON.parse(prior.arguments_json), body)) {
          throw new WorkbenchError("相同请求标识对应的操作内容发生变化，请重新确认操作", 409, "request_conflict");
        }
        const pending = this.pending.get(identity);
        if (pending) return await pending;
        if (prior.state === "completed") return JSON.parse(prior.response_json!);
        if (prior.response_json) {
          const error = JSON.parse(prior.response_json) as { message: string; status: number; code: string };
          throw new WorkbenchError(error.message, error.status, error.code);
        }
        throw new WorkbenchError("原操作的执行结果尚未确认，请检查当前任务及操作记录", 409, "write_outcome_unknown");
      }
      ledger.db.prepare(`INSERT INTO console_write_receipts
        (scope,request_key,method,path,arguments_json,state,created_at) VALUES (?,?,'POST',?,?,'started',?)`)
        .run(scope, requestKey, path, JSON.stringify(body), new Date().toISOString());
      const work = Promise.resolve().then(operation).then((result) => {
        ledger.db.prepare("UPDATE console_write_receipts SET state='completed',response_json=?,finished_at=? WHERE scope=? AND request_key=?")
          .run(JSON.stringify(result ?? null), new Date().toISOString(), scope, requestKey);
        return result;
      }, (error: unknown) => {
        const known = error instanceof WorkbenchError;
        const saved = { message: error instanceof Error ? error.message : String(error), status: known ? error.status : 500,
          code: known ? error.code : "write_outcome_unknown" };
        ledger.db.prepare("UPDATE console_write_receipts SET state=?,response_json=?,finished_at=? WHERE scope=? AND request_key=?")
          .run(known ? "rejected" : "unknown", JSON.stringify(saved), new Date().toISOString(), scope, requestKey);
        throw new WorkbenchError(saved.message, saved.status, saved.code);
      }).finally(() => this.pending.delete(identity));
      this.pending.set(identity, work);
      return await work;
    } finally { ledger.close(); }
  }
}
