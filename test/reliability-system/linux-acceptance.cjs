"use strict";

// 用法：node test/reliability-system/linux-acceptance.cjs repoDir nodeExe outputDir
// 五组文件与本轮 Windows 验收相同；输出目录须为新目录。
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
module.exports = require("./windows-acceptance.cjs");

async function main() {
  const [repoArg, nodeArg, outputArg, ...extra] = process.argv.slice(2);
  if (!repoArg || !nodeArg || !outputArg || extra.length) throw new Error("用法：linux-acceptance.cjs repoDir nodeExe outputDir");
  if (process.platform !== "linux") throw new Error("此验收入口只在 Linux 执行。");
  const repoDir = fs.realpathSync(repoArg), nodeExe = fs.realpathSync(nodeArg), outputDir = path.resolve(outputArg);
  const timeoutMs = 300_000, fileTimeoutMs = 120_000;
  const files = directory => fs.readdirSync(path.join(repoDir, directory)).filter(name => name.endsWith(".test.ts"))
    .sort().map(name => `${directory}/${name}`);
  const groups = {
    "mcp-http": [
      "src/mcp-modern-server.test.ts", "src/mcp-sse-response.test.ts",
      "src/mcp-request-diagnostics.test.ts", "src/mcp-sdk-error-contract.test.ts",
      "src/reliability-core.test.ts", "test/tool-contract/admission-retry.test.ts",
      "test/tool-contract/sqlite-contention.test.ts", "test/tool-contract/sqlite-process-exit.test.ts",
      "test/tool-contract/request-body.test.ts",
      "test/tool-contract/error-receipt.test.ts", "test/reliability-liveness.test.ts",
      "test/receipt-wire-contract.test.ts",
    ],
    "session-sqlite": [...files("src/session"),
      "src/db/migrations.test.ts", "src/db/async-write.test.ts", "src/execution-coordinator.test.ts", "src/execution-coordinator.async.test.ts",
      "src/execution-admission.test.ts", "src/execution-resources.test.ts", "src/process-sessions-contention.test.ts",
      "src/tool-surfaces/subagents.test.ts", "src/reliability-followup.test.ts", "src/server-diagnostics.test.ts",
      "test/reliability-background.test.ts"],
    "recovery-federation": [
      "test/federation/core.test.ts", "test/federation/runtime.test.ts", "test/federation/transport-edge.test.ts",
      "test/federation/observation-budget.test.ts", "test/tool-contract/federation-observation-contention.test.ts",
      "test/console-v5/relay.test.ts", "test/console-v5/relay-contention.test.ts",
      "src/federation/copy-task-state.test.ts",
      "test/tool-contract/federation.test.ts", "test/tool-contract/receipts.test.ts",
      "test/tool-contract/output.test.ts", "test/tool-contract/parallel.test.ts",
      "test/reliability-system/invocation-outcome.test.ts",
      "test/reliability-system/card-command-projection.test.ts",
      "test/reliability-system/task-lifecycle.test.ts", "test/reliability-system/process-output-lifecycle.test.ts",
    ],
    diagnostics: ["src/read-diagnostics.test.ts", "test/read-diagnostics.test.ts"],
    "workspace-restore": ["src/workspaces.test.ts", "src/git-worktrees.test.ts", "test/tool-contract/workspace-restore.test.ts"],
  };
  const names = Object.keys(groups);
  for (const name of names) for (const file of groups[name]) {
    if (!fs.statSync(path.join(repoDir, file)).isFile()) throw new Error(`测试文件不存在：${file}`);
  }
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.mkdirSync(outputDir);
  const tmpDir = path.join(outputDir, "tmp");
  fs.mkdirSync(tmpDir);
  // 临时 fixture 不得沿父目录发现环境中的 Git 仓库；不改变任何测试断言。
  const childEnv = { ...process.env, PATH: path.dirname(nodeExe) + path.delimiter + (process.env.PATH ?? ""),
    TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, GIT_CEILING_DIRECTORIES: tmpDir };
  delete childEnv.NODE_TEST_CONTEXT;
  const capture = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: repoDir, env: childEnv, encoding: "utf8", timeout: 15_000 });
    if (result.error || result.status !== 0) throw new Error(`预检失败 ${executable}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  const runtime = JSON.parse(capture(nodeExe, ["-e", "require('node:fs').writeSync(1,JSON.stringify({version:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch,versions:process.versions}))"]));
  if (runtime.platform !== "linux" || runtime.version !== "v24.21.0") throw new Error(`需要 Linux Node v24.21.0，实际 ${runtime.platform} ${runtime.version}`);
  const commit = capture("git", ["rev-parse", "HEAD"]), gitStatus = capture("git", ["status", "--porcelain=v1"]);
  const summaryPath = path.join(outputDir, "summary.json");
  const summary = { repoDir, nodeExe, runtime, commit, dirty: gitStatus.length !== 0, clean: gitStatus.length === 0,
    git_status_porcelain: gitStatus, launcher: { version: process.version, execPath: process.execPath },
    started_at: new Date().toISOString(), group_timeout_ms: timeoutMs, file_timeout_ms: fileTimeoutMs,
    isolation: "process", concurrency: 1, selected_groups: names,
    child_environment: { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, GIT_CEILING_DIRECTORIES: tmpDir, path_prefix: path.dirname(nodeExe) },
    cleanup_scope: "仅本运行器 detached spawn 的进程组；另行 setsid 的进程不在该组内",
    groups: [], status: "running" };
  const save = () => fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", { flush: true });
  save();
  if (!summary.clean) {
    summary.status = "failed";
    summary.preflight_error = "验收必须从干净检出开始。";
    summary.finished_at = new Date().toISOString();
    save();
    throw new Error(summary.preflight_error);
  }
  console.log(JSON.stringify({ status: "ready", commit, clean: summary.clean, runtime: runtime.version, outputDir, groups: names }));
  let activeStop, interruptedBy;
  const interrupt = signal => { interruptedBy = signal; activeStop?.(signal); };
  process.on("SIGINT", () => interrupt("SIGINT"));
  process.on("SIGTERM", () => interrupt("SIGTERM"));

  const runGroup = name => new Promise(resolve => {
    const tapPath = path.join(outputDir, `${name}.tap`), eventsPath = path.join(outputDir, `${name}.events.jsonl`);
    const args = ["--import", "tsx", "--test", "--test-isolation=process", "--test-concurrency=1",
      `--test-timeout=${fileTimeoutMs}`, "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${pathToFileURL(__filename).href}`, `--test-reporter-destination=${eventsPath}`, ...groups[name]];
    const item = { group: name, status: "running", command: [nodeExe, ...args], cwd: repoDir,
      started_at: new Date().toISOString(), log: tapPath, events: eventsPath, files: groups[name],
      timed_out: false, exit_code: null, signal: null, termination: null };
    summary.groups.push(item);
    const started = performance.now(), descriptor = fs.openSync(tapPath, "wx");
    const child = spawn(nodeExe, args, { cwd: repoDir, env: childEnv, detached: true,
      shell: false, stdio: ["ignore", descriptor, descriptor] });
    const pgid = child.pid;
    item.pid = pgid ?? null;
    item.process_group_id = pgid ?? null;
    let finished = false, stopping = false, closed = false, exitCode = null, exitSignal = null;
    let killTimer, cleanupTimer, cleanupPoll;
    const groupAlive = () => {
      if (!pgid) return false;
      try { process.kill(-pgid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; return true; }
    };
    const finish = cleanupIncomplete => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(killTimer); clearTimeout(cleanupTimer); clearInterval(cleanupPoll);
      activeStop = undefined;
      item.exit_code = exitCode; item.signal = exitSignal; item.cleanup_incomplete = cleanupIncomplete;
      item.duration_ms = Math.round((performance.now() - started) * 1000) / 1000;
      item.finished_at = new Date().toISOString();
      try { fs.fsyncSync(descriptor); } catch (error) { item.log_error = error.message; }
      fs.closeSync(descriptor);
      // 只读取官方根 summary；文件数、TAP 的 ok 行均不能充当通过用例数。
      try {
        const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        item.test_summary = events.filter(event => event.type === "test:summary" && event.data.file === undefined).at(-1)?.data ?? null;
        item.file_summaries = events.filter(event => event.type === "test:summary" && event.data.file !== undefined).map(event => event.data);
      } catch (error) { item.report_error = error.message; }
      item.status = exitCode === 0 && !stopping && !cleanupIncomplete && !item.log_error
        && item.test_summary?.success === true && item.test_summary?.counts?.tests > 0 ? "passed" : "failed";
      save();
      console.log(JSON.stringify({ group: name, status: item.status, exit_code: exitCode, timed_out: item.timed_out,
        duration_ms: item.duration_ms, cleanup_incomplete: cleanupIncomplete, counts: item.test_summary?.counts ?? null }));
      resolve(item);
    };
    const checkCleanup = () => { if (closed && !groupAlive()) finish(false); };
    const signalGroup = signal => {
      if (!pgid) return;
      const sent = { signal, at: new Date().toISOString(), error: null };
      try { process.kill(-pgid, signal); }
      catch (error) { sent.error = { code: error.code, message: error.message }; }
      item.termination.signals.push(sent);
      save();
    };
    const stop = reason => {
      if (finished || stopping) return;
      stopping = true;
      if (reason === "timeout") item.timed_out = true;
      else if (reason !== "remaining_process_group") item.interrupted_by = reason;
      item.termination = { reason, process_group_id: pgid ?? null, grace_ms: 5000, kill_wait_ms: 5000, signals: [] };
      // 只信号本次 spawn 创建的进程组；组长先退出也要等待其余组成员退出。
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => { if (groupAlive()) signalGroup("SIGKILL"); checkCleanup(); }, 5000);
      cleanupTimer = setTimeout(() => { child.unref(); finish(!closed || groupAlive()); }, 10_000);
      cleanupPoll = setInterval(checkCleanup, 50);
      checkCleanup();
    };
    activeStop = stop;
    const deadline = setTimeout(() => stop("timeout"), Math.max(0, timeoutMs - (performance.now() - started)));
    child.once("error", error => { item.spawn_error = { code: error.code, message: error.message }; });
    child.once("close", (code, signal) => {
      closed = true; exitCode = code; exitSignal = signal;
      if (stopping) checkCleanup();
      else if (groupAlive()) stop("remaining_process_group");
      else finish(false);
    });
    save();
    console.log(JSON.stringify({ group: name, status: "running", pid: item.pid, log: tapPath }));
    if (interruptedBy) stop(interruptedBy);
  });
  for (const name of names) {
    if (interruptedBy) break;
    const item = await runGroup(name);
    if (item.cleanup_incomplete) break;
  }
  summary.finished_at = new Date().toISOString();
  summary.interrupted_by = interruptedBy ?? null;
  summary.not_run_groups = names.filter(name => !summary.groups.some(item => item.group === name));
  try {
    summary.final_commit = capture("git", ["rev-parse", "HEAD"]);
    summary.final_git_status_porcelain = capture("git", ["status", "--porcelain=v1"]);
    summary.final_clean = summary.final_git_status_porcelain.length === 0;
  } catch (error) { summary.final_git_error = error.message; }
  summary.status = summary.groups.length === names.length && summary.groups.every(item => item.status === "passed")
    && summary.clean && summary.final_clean && !interruptedBy && summary.final_commit === commit ? "passed" : "failed";
  save();
  console.log(JSON.stringify({ status: summary.status, summary: summaryPath }));
  process.exitCode = interruptedBy ? 130 : summary.status === "passed" ? 0 : 1;
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: "runner_error", error: error.message }));
  process.exitCode = 1;
});
