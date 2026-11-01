import { existsSync, realpathSync } from "node:fs";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type Database from "better-sqlite3";
import {
  WAL_CHECKPOINT_GUARD_PAGES, WAL_CHECKPOINT_TARGET_PAGES, WAL_CHECKPOINT_WATCHDOG_MS,
  type WalCheckpointMessage,
} from "./wal-checkpoint-protocol.js";

export interface WalCheckpointDiagnostic {
  phase: "ready" | "passive" | "fallback" | "background" | "closing" | "closed";
  reason?: "startup" | "worker_failed" | "worker_exit" | "worker_unresponsive" | "wal_pressure" | "pragma_failed" | "close_timeout";
  elapsedMs?: number;
  busy?: number;
  log?: number;
  checkpointed?: number;
  pendingPages?: number;
  automaticPages?: number;
}
export interface WalCheckpointOptions {
  report?: (event: WalCheckpointDiagnostic) => void;
  /** Real Worker factory for platform/lifecycle tests. Production uses the packaged worker. */
  createWorker?: (url: URL, options: WorkerOptions) => Worker;
}
export interface WalCheckpointLease {
  /** False means the original automatic-checkpoint policy is still in force. */
  ready: Promise<boolean>;
  close(): Promise<void>;
}
interface Writer { reference: WeakRef<Database.Database>; originalPages?: number; appliedPages?: number }
interface Group { path: string; writers: Set<Writer>; maintenance?: CheckpointMaintenance; owners: number }
const groups = new Map<string, Group>();
const finalized = new FinalizationRegistry<{ group: Group; writer: Writer }>(({ group, writer }) => {
  group.writers.delete(writer);
  prune(group);
});

function prune(group: Group): void {
  for (const writer of group.writers) if (!writer.reference.deref()?.open) {
    group.writers.delete(writer); finalized.unregister(writer);
  }
  if (!group.writers.size && !group.maintenance && !group.owners && groups.get(group.path) === group) groups.delete(group.path);
}
function groupFor(path: string): Group {
  const canonical = realpathSync.native(path);
  const existing = groups.get(canonical);
  if (existing) { prune(existing); groups.set(canonical, existing); return existing; }
  const group: Group = { path: canonical, writers: new Set(), owners: 0 };
  groups.set(canonical, group); return group;
}

/** Track writable handles only. Raw sqlite.close() is supported: every policy
 * application checks .open, and the registry does not keep a database alive. */
export function trackDatabaseWriter(path: string, database: Database.Database): () => void {
  const group = groupFor(path), writer: Writer = { reference: new WeakRef(database) };
  group.writers.add(writer); finalized.register(database, { group, writer }, writer);
  group.maintenance?.apply(writer);
  return () => { group.writers.delete(writer); finalized.unregister(writer); prune(group); };
}

/** Core-owned maintenance; short CLI/migration processes and readonly workers
 * never call this, and retain their original SQLite defaults. */
export function startDatabaseCheckpoints(path: string, options: WalCheckpointOptions = {}): WalCheckpointLease {
  const group = groupFor(path);
  if (group.maintenance?.closing) throw new Error("SQLITE_CHECKPOINT_CLOSING");
  group.owners++;
  group.maintenance ??= new CheckpointMaintenance(group, options);
  const maintenance = group.maintenance;
  let closing: Promise<void> | undefined;
  return { ready: maintenance.ready, close() {
    closing ??= (async () => {
      if (--group.owners > 0) return;
      await maintenance.close();
      if (group.maintenance === maintenance) group.maintenance = undefined;
      // A future owner must capture the then-current original settings.
      for (const writer of group.writers) { writer.originalPages = undefined; writer.appliedPages = undefined; }
      prune(group);
    })();
    return closing;
  } };
}

class CheckpointMaintenance {
  readonly ready: Promise<boolean>;
  closing = false;
  private resolveReady!: (ready: boolean) => void;
  private worker?: Worker;
  private exit: Promise<void> = Promise.resolve();
  private exited = false;
  private healthy = false;
  private failed = false;
  private lastMessageAt = performance.now();
  private pressureSince?: number;
  private watchdog?: NodeJS.Timeout;
  private stopPromise?: Promise<void>;
  private fallbackReason?: WalCheckpointDiagnostic["reason"];

  constructor(private readonly group: Group, private readonly options: WalCheckpointOptions) {
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.report({ phase: "fallback", reason: "startup", automaticPages: WAL_CHECKPOINT_TARGET_PAGES });
    try {
      const packaged = new URL("./wal-checkpoint-worker.js", import.meta.url);
      const url = !existsSync(packaged) && import.meta.url.endsWith(".ts")
        ? new URL("../../dist/db/wal-checkpoint-worker.js", import.meta.url) : packaged;
      const worker = (options.createWorker ?? ((entry, settings) => new Worker(entry, settings)))(url, {
        workerData: { path: group.path }, execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 }, name: "sqlite-checkpoint",
      });
      this.worker = worker;
      worker.stdout?.resume(); worker.stderr?.resume();
      this.exit = new Promise(resolve => worker.once("exit", () => {
        this.exited = true; clearInterval(this.watchdog);
        if (!this.closing) this.fallback("worker_exit");
        this.resolveReady(false); resolve();
      }));
      worker.on("error", () => { this.failed = true; this.fallback("worker_failed"); this.resolveReady(false); });
      worker.on("message", (message: WalCheckpointMessage) => this.receive(message));
      worker.unref();
      this.watchdog = setInterval(() => {
        if (performance.now() - this.lastMessageAt >= WAL_CHECKPOINT_WATCHDOG_MS) {
          this.fallback("worker_unresponsive"); this.resolveReady(false);
        }
      }, 1_000);
      this.watchdog.unref();
    } catch { this.failed = true; this.fallback("worker_failed"); this.resolveReady(false); }
  }

  apply(writer: Writer): boolean {
    const db = writer.reference.deref();
    if (!db?.open) return true;
    try {
      writer.originalPages ??= db.pragma("wal_autocheckpoint", { simple: true }) as number;
      // Preserve deliberately customized connections. openDatabase's normal
      // connections use SQLite's default 1000-page automatic checkpoint.
      const pages = this.healthy && writer.originalPages === WAL_CHECKPOINT_TARGET_PAGES
        ? WAL_CHECKPOINT_GUARD_PAGES : writer.originalPages;
      if (writer.appliedPages !== pages) {
        db.pragma(`wal_autocheckpoint = ${pages}`); writer.appliedPages = pages;
      }
      return true;
    } catch { return false; }
  }

  private policy(): boolean {
    prune(this.group);
    let applied = true;
    for (const writer of this.group.writers) if (!this.apply(writer)) applied = false;
    return applied;
  }
  private fallback(reason: NonNullable<WalCheckpointDiagnostic["reason"]>): void {
    const changed = this.healthy || this.fallbackReason !== reason;
    this.healthy = false; this.fallbackReason = reason;
    const applied = this.policy();
    if (changed || !applied) this.report({ phase: "fallback", reason: applied ? reason : "pragma_failed",
      ...(applied ? { automaticPages: WAL_CHECKPOINT_TARGET_PAGES } : {}) });
  }

  private receive(message: WalCheckpointMessage): void {
    this.lastMessageAt = performance.now();
    if (message.type === "failed") { this.failed = true; this.fallback("worker_failed"); this.resolveReady(false); return; }
    if (this.closing || this.failed || this.exited) return;
    if (message.type !== "ready" && message.type !== "sample") return;
    const current = message.snapshot, pendingPages = Math.max(0, current.log - current.checkpointed);
    if (pendingPages >= WAL_CHECKPOINT_TARGET_PAGES || current.busy) this.pressureSince ??= performance.now();
    else this.pressureSince = undefined;
    const pressured = pendingPages >= WAL_CHECKPOINT_GUARD_PAGES || current.busy > 0
      || (this.pressureSince !== undefined && performance.now() - this.pressureSince >= WAL_CHECKPOINT_WATCHDOG_MS);
    if (pressured) this.fallback("wal_pressure");
    else if (!this.healthy) {
      this.healthy = true; this.fallbackReason = undefined;
      if (!this.policy()) this.fallback("pragma_failed");
      else this.report({ phase: message.type === "ready" ? "ready" : "background", automaticPages: WAL_CHECKPOINT_GUARD_PAGES });
    }
    if (message.type === "ready") this.resolveReady(true);
    else if (message.checkpoint) this.report({ phase: "passive", elapsedMs: message.elapsedMs,
      ...current, pendingPages });
  }

  close(): Promise<void> {
    this.stopPromise ??= (async () => {
      this.closing = true; clearInterval(this.watchdog); this.healthy = false; this.policy();
      this.resolveReady(false); this.report({ phase: "closing" });
      if (this.worker && !this.exited) {
        // A watchdog lapse never asserts that a native checkpoint stopped.
        // Only exit completes shutdown; no replacement worker races this one.
        this.worker.ref();
        this.worker.postMessage("close");
        const deadline = setTimeout(() => {
          this.report({ phase: "closing", reason: "close_timeout" });
          void this.worker!.terminate().catch(() => {});
        }, WAL_CHECKPOINT_WATCHDOG_MS);
        deadline.unref();
        try { await this.exit; } finally { clearTimeout(deadline); }
      }
      this.report({ phase: "closed" });
    })();
    return this.stopPromise;
  }

  private report(event: WalCheckpointDiagnostic): void { try { this.options.report?.(event); } catch {} }
}
