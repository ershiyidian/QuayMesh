import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

// 独立线程真实持锁；自动释放不依赖被测线程的事件循环。
export async function holdSqliteWriteLock(filename: string, durationMs: number) {
  const worker = new Worker(`
    const {parentPort, workerData} = require('node:worker_threads');
    const Database = require(workerData.modulePath);
    const db = new Database(workerData.filename);
    db.exec('BEGIN IMMEDIATE');
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      db.exec('ROLLBACK');
      db.close();
      parentPort.close();
    };
    const timer = setTimeout(release, workerData.durationMs);
    parentPort.once('message', release);
    parentPort.postMessage('locked');
  `, { eval: true, workerData: { filename, durationMs,
    modulePath: createRequire(import.meta.url).resolve("better-sqlite3") } });
  const done = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`SQLite lock worker exited ${code}`)));
  });
  void done.catch(() => {});
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  return { done, async release() { worker.postMessage("release"); await done; } };
}
