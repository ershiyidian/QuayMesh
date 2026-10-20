import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { databasePath } from "../../src/db/client.js";
import { holdSqliteWriteLock } from "../../src/test-support/sqlite-lock.js";
import { fixture, until } from "./fixture.js";

test("真实OAuth MCP在SQLite写锁和排队命令期间仍可读取历史输出、诊断与Console", {timeout: 30_000}, async t => {
  const f = await fixture(t, {git: false, configure: async config => ({...config, dangerouslySkipCommandReview: true})});
  const original = await f.execute("console.log('durable output before lock')");
  await until(async () => (await f.call("read_output", {...f.scope, operation_id: original.operation_id, wait_ms: 0})).process_done === true);
  const script = join(f.project, "append-once.mjs"), effectFile = join(f.project, "once.txt");
  await writeFile(script, "import {appendFileSync} from 'node:fs'; appendFileSync(new URL('./once.txt',import.meta.url),'once\\n'); console.log('saved once');\n");
  const input = {...f.scope, cmd: `"${process.execPath}" "${script}"`, operation_key: "sqlite-contention-once", yield_time_ms: 100};
  const lock = await holdSqliteWriteLock(databasePath(f.config.stateDir), 3000);
  let released = false;
  void lock.done.then(() => {released = true;});
  let ticks = 0, maxGap = 0, previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++;
  }, 20);
  const command = f.call("exec_command", input);
  void command.catch(() => {});
  try {
    await delay(50);
    const latencies: number[] = [];
    for (let index = 0; index < 3; index++) {
      const start = performance.now();
      const [output, diagnostics, consoleResponse] = await Promise.all([
        f.call("read_output", {...f.scope, operation_id: original.operation_id, wait_ms: 0}),
        f.call("read_diagnostics", {task_id: f.task.task_id, since: new Date(Date.now() - 60_000).toISOString()}),
        fetch(f.baseUrl + "/console/"),
      ]);
      await consoleResponse.text();
      latencies.push(performance.now() - start);
      assert.match(String(output.result), /durable output before lock/);
      assert.equal(diagnostics.task.id, f.task.task_id);
      assert.equal(consoleResponse.status, 200);
      assert.equal(released, false, "observation must complete while the independent writer still holds its lock");
      await delay(25);
    }
    assert.ok(Math.max(...latencies) < 1200, JSON.stringify(latencies));
    const started = await command;
    await until(async () => (await f.call("read_output", {...f.scope, operation_id: started.operation_id, wait_ms: 0})).process_done === true);
    const replay = await f.call("exec_command", input);
    assert.equal(replay.operation_id, started.operation_id);
    assert.equal(await readFile(effectFile, "utf8"), "once\n");
    assert.ok(ticks >= 40, `ticks: ${ticks}`);
    assert.ok(maxGap < 700, `max event loop gap: ${maxGap}`);
    t.diagnostic(JSON.stringify({writer_lock_ms: 3000, authenticated_observation_ms: latencies,
      ticks, max_gap_ms: maxGap, command_effects: 1, original_operation_id: started.operation_id}));
  } finally {
    clearInterval(timer);
    await lock.release();
    await Promise.allSettled([command]);
  }
});
