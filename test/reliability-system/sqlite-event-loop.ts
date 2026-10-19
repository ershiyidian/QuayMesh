import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase, type DatabaseHandle } from "../../src/db/client.js";
import { SessionStore } from "../../src/session/store.js";

// 使用锁定的 Node.js 24.21.0：node --import tsx test/reliability-system/sqlite-event-loop.ts
// 这是测量脚本，不以机器相关的延迟设定通过阈值，也不修改生产默认的 busy_timeout。
async function measure() {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh-sqlite-event-loop-"));
  let database: DatabaseHandle | undefined;
  let blocker: Database.Database | undefined;
  try {
    database = openDatabase(directory);
    const store = new SessionStore(database.sqlite);
    blocker = new Database(databasePath(directory));
    const session = store.createSession("measurement", "measurement", "SQLite event loop measurement");
    const member = store.addMember(session.id, "local", "measurement-workspace", directory, "checkout", null);
    const event = {
      session_id: session.id,
      member_id: member.id,
      type: "agent_changed" as const,
      source_id: "measurement-event",
      timestamp: new Date().toISOString(),
      payload: {},
    };

    // 同进程的独立连接持有真实写锁；等同步调用返回后才释放，以测量事件循环阻塞。
    blocker.exec("BEGIN IMMEDIATE");
    blocker.prepare("UPDATE qm_sessions SET revision=revision WHERE id=?").run(session.id);
    const scheduledTimerMs = 10;
    const started = performance.now();
    const timer = new Promise<number>(resolve => {
      setTimeout(() => resolve(performance.now() - started), scheduledTimerMs);
    });
    let errorCode: string | null = null;
    try {
      store.appendEvent(event);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "SQLITE_BUSY") throw error;
      errorCode = error.code;
    }
    const appendElapsedMs = performance.now() - started;
    const timerElapsedMs = await timer;
    blocker.exec("ROLLBACK");
    store.appendEvent(event);

    return {
      measurement: "sqlite_event_loop",
      contention: "same_process_separate_connection",
      node: process.version,
      sqlite: (database.sqlite.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version,
      busyTimeoutMs: database.sqlite.pragma("busy_timeout", { simple: true }),
      errorCode,
      appendElapsedMs,
      scheduledTimerMs,
      timerElapsedMs,
      eventLoopDelayMs: timerElapsedMs - scheduledTimerMs,
      eventsAfterRetry: store.eventsForSession(session.id).length,
    };
  } finally {
    try {
      if (blocker?.inTransaction) blocker.exec("ROLLBACK");
    } finally {
      try {
        blocker?.close();
      } finally {
        try {
          database?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
}

console.log(JSON.stringify(await measure()));
