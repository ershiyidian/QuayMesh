import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import {
  WAL_CHECKPOINT_MAX_DELAY_MS, WAL_CHECKPOINT_POLL_MS, WAL_CHECKPOINT_TARGET_PAGES,
  type WalCheckpointMessage, type WalCheckpointSnapshot,
} from "./wal-checkpoint-protocol.js";

if (!parentPort || typeof workerData?.path !== "string") throw new Error("SQLITE_CHECKPOINT_WORKER_INPUT");
const port = parentPort;
let database: Database.Database | undefined;
let timer: NodeJS.Timeout | undefined;
let pendingSince: number | undefined;
let closed = false;
const send = (message: WalCheckpointMessage) => port.postMessage(message);

function snapshot(mode: "NOOP" | "PASSIVE"): WalCheckpointSnapshot {
  const rows = database!.pragma(`wal_checkpoint(${mode})`) as WalCheckpointSnapshot[];
  const row = rows[0];
  if (rows.length !== 1 || !row || ![row.busy, row.log, row.checkpointed].every(Number.isInteger)
    || row.busy < 0 || row.busy > 1 || row.log < -1 || row.checkpointed < -1)
    throw new Error("SQLITE_CHECKPOINT_RESULT");
  return { busy: row.busy, log: row.log, checkpointed: row.checkpointed };
}

function failureCode(error: unknown): string {
  // Native errors may contain database paths. Retain only their primary family.
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^SQLITE_[A-Z]+(?:_[A-Z0-9_]+)?$/.test(code)
    ? code.split("_").slice(0, 2).join("_") : "SQLITE_CHECKPOINT_FAILED";
}

function close(): void {
  if (closed) return;
  closed = true;
  clearTimeout(timer);
  try {
    // The Core closes its writers first. Any last-connection checkpoint and
    // WAL cleanup therefore occur on this thread, not on the request loop.
    database?.close();
    send({ type: "closed" });
  } catch (error) { send({ type: "failed", code: failureCode(error) }); }
  finally { database = undefined; port.close(); }
}

function tick(): void {
  if (closed) return;
  try {
    let current = snapshot("NOOP");
    const pending = Math.max(0, current.log - current.checkpointed);
    if (pending > 0) pendingSince ??= performance.now();
    else if (!current.busy) pendingSince = undefined;
    const checkpoint = pending > 0 && (pending >= WAL_CHECKPOINT_TARGET_PAGES
      || performance.now() - pendingSince! >= WAL_CHECKPOINT_MAX_DELAY_MS);
    const start = performance.now();
    if (checkpoint) current = snapshot("PASSIVE");
    const elapsedMs = Math.round((performance.now() - start) * 1000) / 1000;
    if (!current.busy && current.log === current.checkpointed) pendingSince = undefined;
    send({ type: "sample", snapshot: current, checkpoint, elapsedMs });
    timer = setTimeout(tick, WAL_CHECKPOINT_POLL_MS);
  } catch (error) {
    send({ type: "failed", code: failureCode(error) });
    close();
  }
}

port.on("message", message => { if (message === "close") close(); });
try {
  database = new Database(workerData.path, { fileMustExist: true });
  if (database.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("SQLITE_CHECKPOINT_NOT_WAL");
  database.pragma("synchronous = NORMAL");
  // Unknown pragma arguments can silently mean PASSIVE in old SQLite. The
  // pinned native build is newer; refuse maintenance on a pre-NOOP build.
  const version = String(database.prepare("SELECT sqlite_version()").pluck().get()).split(".").map(Number);
  if (version[0] < 3 || (version[0] === 3 && version[1] < 51)) throw new Error("SQLITE_CHECKPOINT_VERSION");
  send({ type: "ready", snapshot: snapshot("NOOP") });
  timer = setTimeout(tick, WAL_CHECKPOINT_POLL_MS);
} catch (error) {
  send({ type: "failed", code: failureCode(error) });
  close();
}
