import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

for (const mode of ["locked", "post-commit"] as const) {
  test(`agent polling survives real SQLite contention and restores once: ${mode}`, { timeout: 15_000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), "quaymesh-agent-lock-"));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = fork(fileURLToPath(new URL("../test-support/agent-operation-lock-worker.ts", import.meta.url)), [root, mode], {
      execArgv: ["--import", "tsx", "--unhandled-rejections=strict"], stdio: ["ignore", "pipe", "pipe", "ipc"], env,
    });
    const messages: Array<Record<string, any>> = [];
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.stdout!.resume();
    child.on("message", message => { messages.push(message as Record<string, any>); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), delay(2_000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL"); await once(child, "exit");
        }
      }
      await rm(root, { recursive: true, force: true });
    });
    const receive = async (type: string, timeoutMs = 5_000): Promise<Record<string, any>> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = messages.findIndex(message => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        assert.equal(child.exitCode, null, `worker exited before ${type}: ${stderr}`);
        assert.equal(child.signalCode, null, `worker was signalled before ${type}: ${stderr}`);
        await delay(5);
      }
      assert.fail(`Timed out waiting for ${type}: ${stderr}`);
    };
    const ready = await receive("ready");
    // 正式异步取锁预算为五秒，另留首轮定时器与 IPC 调度余量。
    assert.match((await receive("poll-error", 8_000)).code, /^SQLITE_BUSY/);
    child.send({ type: "ping" });
    assert.equal((await receive("pong")).pid, ready.pid, "the same process must survive the failed timer callback");

    const db = new Database(join(ready.stateDir, "quaymesh.sqlite"), { readonly: true });
    try {
      const before = db.prepare("SELECT state,finished_at FROM qm_invocations WHERE operation_id=?").get(ready.operationId) as any;
      assert.equal(before.state, "running"); assert.equal(before.finished_at, null);
      const count = (kind: string) => (db.prepare("SELECT count(*) n FROM qm_events WHERE session_id=? AND event_type=?")
        .get(ready.sessionId, kind) as { n: number }).n;
      assert.equal(count("agent_changed"), mode === "post-commit" ? 1 : 0);
      assert.equal(count("operation_finished"), 0);

      if (mode === "post-commit") {
        // 写锁尚未释放时重建 tracker，也应从持久身份恢复，不重新启动提供方工作。
        child.send({ type: "stop-tracker" }); await receive("tracker-stopped");
        child.send({ type: "restore-tracker" }); await receive("tracker-restored");
      }
      child.send({ type: "release" }); await receive("released");
      const complete = await receive("completed");
      assert.equal(complete.invocation.state, "succeeded");
      assert.equal(complete.invocation.effect, "completed");
      assert.ok(complete.invocation.finished_at);
      assert.equal(complete.agent.latestResponse, "Durable provider result");
      assert.equal(complete.invocation.result_ref, `agent:${ready.agentId}:${complete.agent.controlRevision}`);
      assert.deepEqual(complete.pending, []);
      assert.equal(count("agent_changed"), 1, "a committed observation must not be duplicated after a retry or restore");
      assert.equal(count("operation_finished"), 1);
      const operation = db.prepare("SELECT status FROM console_operations WHERE id=?").get(ready.operationId) as any;
      assert.equal(operation.status, "completed");
    } finally { db.close(); }
    child.send({ type: "close" });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, stderr);
  });
}
