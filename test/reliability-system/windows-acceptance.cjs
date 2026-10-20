"use strict";

// 用法：node test/reliability-system/windows-acceptance.cjs repoDir nodeExe outputDir [--groups=mcp-http,node] [--timeout-ms=240000]
// outputDir 每次使用新目录；本脚本同时作为 Node 官方测试事件流的 JSON reporter。
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

module.exports = async function* report(source) {
  for await (const event of source) {
    if (!["test:summary", "test:pass", "test:fail"].includes(event.type)) continue;
    yield JSON.stringify(event, (_key, value) => value instanceof Error
      ? { name: value.name, message: value.message, code: value.code, stack: value.stack }
      : value) + "\n";
  }
};

async function main() {
  const [repoArg, nodeArg, outputArg, ...options] = process.argv.slice(2);
  if (!repoArg || !nodeArg || !outputArg) throw new Error("用法：runner.cjs repoDir nodeExe outputDir [--groups=...] [--timeout-ms=240000]");
  if (process.platform !== "win32") throw new Error("此验收入口只在 Windows 执行；其他平台仅做 node --check。");
  const repoDir = fs.realpathSync(repoArg);
  const nodeExe = fs.realpathSync(nodeArg);
  const outputDir = path.resolve(outputArg);
  let timeoutMs = 240_000;
  let selected = null;
  for (const option of options) {
    if (option.startsWith("--groups=")) selected = option.slice(9).split(",");
    else if (/^--timeout-ms=\d+$/.test(option)) timeoutMs = Number(option.slice(13));
    else throw new Error(`未知选项：${option}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new Error("组超时须在 1000–3600000 ms 之间。");
  const files = (directory, suffix) => fs.readdirSync(path.join(repoDir, directory))
    .filter(name => name.endsWith(suffix)).sort().map(name => `${directory}/${name}`);
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
    "session-sqlite": [...files("src/session", ".test.ts"),
      "src/db/migrations.test.ts", "src/db/async-write.test.ts", "src/execution-coordinator.test.ts", "src/execution-coordinator.async.test.ts",
      "src/execution-admission.test.ts", "src/execution-resources.test.ts", "src/process-sessions-contention.test.ts",
      "src/tool-surfaces/subagents.test.ts",
      "src/reliability-followup.test.ts", "src/server-diagnostics.test.ts",
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
    "environment-review": ["src/tool-surfaces/subagents.test.ts", "test/python-workflow.test.ts"],
    diagnostics: ["src/read-diagnostics.test.ts", "test/read-diagnostics.test.ts"],
    "workspace-restore": ["src/workspaces.test.ts", "src/git-worktrees.test.ts", "test/tool-contract/workspace-restore.test.ts"],
    // helpers.mjs 和 worker-process.mjs 是辅助程序，后者会定时常驻，不能当测试入口。
    node: files("node/test", ".test.mjs"),
  };
  if (selected && (selected.length === 0 || selected.some(name => !Object.hasOwn(groups, name)))) throw new Error("未知测试组。");
  const names = Object.keys(groups).filter(name => selected === null || selected.includes(name));
  for (const name of names) for (const file of groups[name]) {
    if (!fs.statSync(path.join(repoDir, file)).isFile()) throw new Error(`测试文件不存在：${file}`);
  }

  // Windows 环境键不区分大小写；只给本轮子进程保留一个 PATH，并优先使用锁定 Node。
  const childEnv = { ...process.env };
  const inheritedPath = Object.entries(childEnv).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === "path" || key === "NODE_TEST_CONTEXT") delete childEnv[key];
  }
  childEnv.PATH = path.dirname(nodeExe) + path.delimiter + inheritedPath;
  const capture = (executable, args) => {
    const result = spawnSync(executable, args, { cwd: repoDir, env: childEnv, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    if (result.error || result.status !== 0) throw new Error(`预检失败 ${executable}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  const runtime = JSON.parse(capture(nodeExe, ["-e", "require('node:fs').writeSync(1,JSON.stringify({version:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch,versions:process.versions}))"]));
  if (runtime.version !== "v24.21.0") throw new Error(`需要 Node v24.21.0，实际 ${runtime.version}`);
  const commit = capture("git.exe", ["rev-parse", "HEAD"]);
  const dirty = capture("git.exe", ["status", "--porcelain"]).length !== 0;
  fs.mkdirSync(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, "summary.json");
  fs.closeSync(fs.openSync(summaryPath, "wx"));
  const summary = { repoDir, nodeExe, runtime, commit, dirty, launcher: process.version,
    started_at: new Date().toISOString(), group_timeout_ms: timeoutMs,
    isolation: "process", selected_groups: names, groups: [], status: "running" };
  const save = () => fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", { flush: true });
  save();
  console.log(JSON.stringify({ status: "ready", commit, runtime: runtime.version, outputDir, groups: names }));
  let activeStop;
  let interruptedBy;
  const interrupt = signal => { interruptedBy = signal; activeStop?.(signal); };
  process.on("SIGINT", () => interrupt("SIGINT"));
  process.on("SIGTERM", () => interrupt("SIGTERM"));
  process.on("SIGBREAK", () => interrupt("SIGBREAK"));

  const runGroup = name => new Promise(resolve => {
    const tapPath = path.join(outputDir, `${name}.tap`);
    const eventsPath = path.join(outputDir, `${name}.events.jsonl`);
    const args = [...(name === "node" ? [] : ["--import", "tsx"]), "--test", "--test-isolation=process",
      ...(name === "environment-review" ? ["--test-name-pattern=只读环境查询|真实 MCP 注解|^PY"] : []),
      "--test-concurrency=1", "--test-timeout=120000", "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${pathToFileURL(__filename).href}`, `--test-reporter-destination=${eventsPath}`, ...groups[name]];
    const item = { group: name, status: "running", command: [nodeExe, ...args], cwd: repoDir,
      started_at: new Date().toISOString(), log: tapPath, events: eventsPath, files: groups[name],
      timed_out: false, exit_code: null, signal: null, termination: null };
    summary.groups.push(item);
    const started = performance.now();
    const descriptor = fs.openSync(tapPath, "wx");
    // 直接继承文件句柄，不依赖父进程转发测试输出；真正的 TCP fixture 原样运行。
    const child = spawn(nodeExe, args, { cwd: repoDir, env: childEnv, windowsHide: true,
      shell: false, stdio: ["ignore", descriptor, descriptor] });
    item.pid = child.pid ?? null;
    save();
    console.log(JSON.stringify({ group: name, status: "running", pid: item.pid, log: tapPath }));
    let finished = false;
    let stopping = false;
    let cleanupDeadline;
    const finish = (code, signal, cleanupIncomplete = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      activeStop = undefined;
      item.exit_code = code;
      item.signal = signal;
      item.cleanup_incomplete = cleanupIncomplete;
      item.duration_ms = Math.round((performance.now() - started) * 1000) / 1000;
      item.finished_at = new Date().toISOString();
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      // 只使用官方事件中的根 summary，不把测试文件数或日志里的 ok 行当用例数。
      try {
        const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        item.test_summary = events.filter(event => event.type === "test:summary" && event.data.file === undefined).at(-1)?.data ?? null;
        item.file_summaries = events.filter(event => event.type === "test:summary" && event.data.file !== undefined).map(event => event.data);
      } catch (error) { item.report_error = error.message; }
      item.status = code === 0 && !item.timed_out && !item.interrupted_by && !cleanupIncomplete
        && item.test_summary?.success === true && item.test_summary?.counts?.tests > 0 ? "passed" : "failed";
      save();
      console.log(JSON.stringify({ group: name, status: item.status, exit_code: code, timed_out: item.timed_out,
        duration_ms: item.duration_ms, counts: item.test_summary?.counts ?? null }));
      resolve(item);
    };
    const stop = reason => {
      if (finished || stopping) return;
      stopping = true;
      if (reason === "timeout") item.timed_out = true;
      else item.interrupted_by = reason;
      // 只处理本次 spawn 的尚存 PID；正常 close 不调用 taskkill，不按映像名扫进程。
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
        const killed = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
          cwd: repoDir, env: childEnv, encoding: "utf8", windowsHide: true, timeout: 10_000,
        });
        item.termination = { command: [taskkill, "/PID", String(child.pid), "/T", "/F"],
          exit_code: killed.status, signal: killed.signal, error: killed.error?.message ?? null,
          stdout: killed.stdout ?? "", stderr: killed.stderr ?? "" };
      }
      save();
      // 组预算到点即停止；清理额外最多 15 秒，未收到 close 则保留未知退出码并停止后续组。
      cleanupDeadline = setTimeout(() => { child.unref(); finish(child.exitCode, child.signalCode, true); }, 5_000);
    };
    activeStop = stop;
    const deadline = setTimeout(() => stop("timeout"), Math.max(0, timeoutMs - (performance.now() - started)));
    child.once("error", error => { item.spawn_error = { code: error.code, message: error.message }; });
    child.once("close", (code, signal) => finish(code, signal));
    if (interruptedBy) stop(interruptedBy);
  });
  for (const name of names) {
    if (interruptedBy) break;
    const item = await runGroup(name);
    if (item.cleanup_incomplete || (item.termination && item.termination.exit_code !== 0)) break;
  }
  summary.finished_at = new Date().toISOString();
  summary.interrupted_by = interruptedBy ?? null;
  summary.status = summary.groups.length === names.length && summary.groups.every(item => item.status === "passed") ? "passed" : "failed";
  save();
  console.log(JSON.stringify({ status: summary.status, summary: summaryPath }));
  process.exitCode = interruptedBy ? 130 : summary.status === "passed" ? 0 : 1;
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: "runner_error", error: error.message }));
  process.exitCode = 1;
});
