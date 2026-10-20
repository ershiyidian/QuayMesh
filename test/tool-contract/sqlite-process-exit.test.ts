import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { databasePath } from "../../src/db/client.js";
import { pidAlive } from "../../src/process-liveness.js";
import { holdSqliteWriteLock } from "../../src/test-support/sqlite-lock.js";
import { fixture, until } from "./fixture.js";

test("真实子进程在SQLite持写锁时退出，MCP观察与心跳继续响应，解锁后原操作只收尾一次", {timeout: 30_000}, async t => {
  const f = await fixture(t, {git: false, configure: async config => ({...config, dangerouslySkipCommandReview: true})});
  const script = join(f.project, "exit-on-release.mjs"), marker = join(f.project, "once.txt"), gate = join(f.root, "release");
  await writeFile(script, `import {appendFileSync, existsSync} from 'node:fs';
appendFileSync(new URL('./once.txt', import.meta.url), 'once\\n');
console.log('ready:' + process.pid);
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(gate)})) { clearInterval(timer); console.log('released'); }
}, 20);
`);
  const input = {...f.scope, cmd: `"${process.execPath}" "${script}"`, operation_key: "sqlite-process-exit-once", yield_time_ms: 100};
  let operationId: string | undefined, reader: Database.Database | undefined;
  let lock: Awaited<ReturnType<typeof holdSqliteWriteLock>> | undefined, timer: NodeJS.Timeout | undefined;
  try {
    const started = await f.call("exec_command", input);
    assert.equal(typeof started.operation_id, "string");
    operationId = started.operation_id;
    const output = () => f.call("read_output", {...f.scope, operation_id: operationId, cursor: 0, wait_ms: 0});
    let pid = 0;
    await until(async () => {
      const ready = await output();
      pid = Number(/ready:(\d+)/u.exec(String(ready.result))?.[1]);
      return Number.isInteger(pid) && pid > 0;
    });
    assert.equal(pidAlive(pid), true);
    reader = new Database(databasePath(f.config.stateDir), {readonly: true, fileMustExist: true});
    const invocation = () => reader!.prepare("SELECT task_id,state,result_json FROM qm_invocations WHERE operation_id=? ORDER BY rowid DESC LIMIT 1")
      .get(operationId) as {task_id: string; state: string; result_json: string | null};
    await until(() => typeof invocation().result_json === "string");
    const originalReceipt = JSON.parse(invocation().result_json!).value.structuredContent;
    assert.equal(invocation().task_id, f.task.task_id);
    lock = await holdSqliteWriteLock(databasePath(f.config.stateDir), 3000);
    let released = false;
    void lock.done.then(() => {released = true;}, () => {released = true;});
    let ticks = 0, maxGapMs = 0, previous = performance.now();
    timer = setInterval(() => {
      const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; ticks++;
    }, 20);
    await writeFile(gate, "release");
    // OS 进程确已退出，数据库锁仍由另一个 Worker 持有。
    await until(() => !pidAlive(pid), 1500);
    assert.equal(released, false, "进程退出的收尾不能同步阻塞到写锁释放");
    const latencies: number[] = [];
    for (let index = 0; index < 3; index++) {
      const start = performance.now();
      const [page, diagnostics, consoleResponse] = await Promise.all([
        output(),
        f.call("read_diagnostics", {task_id: f.task.task_id, since: new Date(Date.now() - 60_000).toISOString()}),
        fetch(f.baseUrl + "/console/"),
        f.client.ping(),
      ]);
      await consoleResponse.text();
      latencies.push(performance.now() - start);
      assert.equal(page.operation_id, operationId);
      assert.equal(page.task_id, f.task.task_id);
      assert.match(String(page.result), /ready:/);
      assert.equal(diagnostics.task.id, f.task.task_id);
      assert.equal(consoleResponse.status, 200);
      assert.equal(released, false, "输出、诊断、Console 与 MCP ping 必须在锁仍持有时返回");
      await delay(25);
    }
    assert.ok(Math.max(...latencies) < 1200, JSON.stringify(latencies));
    await lock.done;
    await until(async () => {
      const page = await output();
      const status = await f.call("workspace_context", {...f.scope, action: "status", operation_id: operationId});
      // 输出接口公开进程账本 completed；任务调用回执公开 succeeded。
      return page.process_done === true && page.operation_state === "completed" && status.operation_state === "succeeded";
    });
    clearInterval(timer); timer = undefined;
    const finished = await output();
    assert.equal(finished.exit_code, 0);
    assert.match(String(finished.result), /released/);
    assert.equal(invocation().state, "succeeded");
    assert.equal(invocation().task_id, f.task.task_id);
    const events = reader.prepare("SELECT task_id,data_json FROM qm_events WHERE event_type='operation_finished' AND json_extract(data_json,'$.operation_id')=?")
      .all(operationId) as Array<{task_id: string; data_json: string}>;
    assert.equal(events.length, 1);
    assert.equal(events[0].task_id, f.task.task_id);
    assert.equal(JSON.parse(events[0].data_json).status, "succeeded");
    const replay = await f.call("exec_command", input);
    assert.deepEqual(replay, originalReceipt);
    assert.equal(replay.operation_id, operationId);
    assert.equal(await readFile(marker, "utf8"), "once\n");
    assert.ok(ticks >= 40, `ticks: ${ticks}`);
    assert.ok(maxGapMs < 700, `max event loop gap: ${maxGapMs}`);
    t.diagnostic(JSON.stringify({writer_lock_ms: 3000, child_exited_while_locked: true, observation_ms: latencies,
      ticks, max_gap_ms: maxGapMs, finish_events: events.length, command_effects: 1, original_operation_id: operationId}));
  } finally {
    if (timer) clearInterval(timer);
    // 先释放锁与进程门闩，再让 fixture 关闭 HTTP、命令管理器和数据库。
    try { await lock?.release(); }
    finally {
      try {
        await writeFile(gate, "cleanup");
        if (operationId) await f.raw("cancel_command", {...f.scope, operation_id: operationId}).catch(() => {});
      } finally { reader?.close(); }
    }
  }
});
