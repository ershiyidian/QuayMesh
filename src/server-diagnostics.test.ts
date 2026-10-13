import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { diagnosticError, ServerDiagnostics } from "./server-diagnostics.js";
import type { LoggingConfig } from "./logger.js";

const logging: LoggingConfig = { level: "info", format: "json", requests: true, assets: false, toolCalls: false, shellCommands: false, trustProxy: false };
function fixture(context: test.TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "quaymesh-diagnostics-"));
  context.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const path = join(stateDir, "logs", "server-diagnostics.jsonl");
  const rows = () => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { stateDir, path, rows };
}

test("diagnostics capture completed and aborted requests without headers, bodies or query strings", async (context) => {
  const fixtureData = fixture(context);
  const diagnostics = new ServerDiagnostics({ stateDir: fixtureData.stateDir, logging }, 20);
  const server = createServer((req, res) => {
    if (req.url?.includes("hold")) return;
    res.end("ok");
  });
  diagnostics.attach(server);
  context.after(() => { diagnostics.dispose(); server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/mcp?secret=fixture-secret`, {
    method: "POST", headers: { authorization: "Bearer fixture-secret" }, body: "fixture-secret",
  });
  await response.text();
  const received = once(server, "request");
  const pending = request(`http://127.0.0.1:${port}/mcp?hold=fixture-secret`);
  pending.on("error", () => {});
  pending.end();
  await received;
  await delay(50);
  const disconnected = new Promise<void>((resolve) => pending.once("close", resolve));
  pending.destroy();
  await disconnected;
  for (let attempt = 0; attempt < 50 && !fixtureData.rows().some((row) => row.event === "server_request_aborted"); attempt++) await delay(10);
  const rows = fixtureData.rows();
  assert(rows.some((row) => row.event === "server_request_finished" && row.status === 200));
  assert(rows.some((row) => row.event === "server_request_aborted"));
  assert(rows.some((row) => row.event === "server_heartbeat" && row.pendingRequests === 1));
  assert(!readFileSync(fixtureData.path, "utf8").includes("fixture-secret"));
});

test("rotation bounds disk usage and error summaries omit raw messages", (context) => {
  const fixtureData = fixture(context);
  const diagnostics = new ServerDiagnostics({ stateDir: fixtureData.stateDir, logging });
  context.after(() => diagnostics.dispose());
  const failure = Object.assign(new Error("Bearer fixture-secret"), { code: "EADDRINUSE" });
  assert.throws(() => diagnostics.start(() => { throw failure; }), (error) => error === failure);
  assert.equal(diagnosticError(failure).errorCode, "EADDRINUSE");
  assert(!JSON.stringify(diagnosticError(failure)).includes("fixture-secret"));
  for (let rotation = 0; rotation < 2; rotation++) {
    writeFileSync(fixtureData.path, "x".repeat(8 * 1024 * 1024));
    diagnostics.record("rotation_test");
    const date=new Date().toISOString().slice(0,10);
    assert(existsSync(`${fixtureData.path}.${date}.${rotation}`),"达到日志分段上限后按日期归档");
    assert(readFileSync(fixtureData.path).length < 4096);
  }
});

test("unwritable diagnostics do not mask the original startup failure", (context) => {
  const fixtureData = fixture(context);
  mkdirSync(join(fixtureData.stateDir, "logs"));
  mkdirSync(fixtureData.path);
  const diagnostics = new ServerDiagnostics({ stateDir: fixtureData.stateDir, logging });
  context.after(() => diagnostics.dispose());
  const original = new Error("original");
  assert.throws(() => diagnostics.start(() => { throw original; }), (error) => error === original);
});

test("silent configuration and disposal preserve logging and process-listener boundaries", (context) => {
  const fixtureData = fixture(context);
  const listeners = process.listenerCount("uncaughtExceptionMonitor");
  const diagnostics = new ServerDiagnostics({ stateDir: fixtureData.stateDir, logging: { ...logging, level: "silent" } });
  diagnostics.record("server_startup_failed", diagnosticError(new Error("fixture-secret")), "error");
  assert.equal(existsSync(fixtureData.path), false);
  assert.equal(process.listenerCount("uncaughtExceptionMonitor"), listeners + 1);
  diagnostics.dispose();
  diagnostics.dispose();
  assert.equal(process.listenerCount("uncaughtExceptionMonitor"), listeners);
});

for (const mode of ["normal", "fatal", "rejection", "http-error"] as const) {
  test(`child process retains ${mode} exit semantics and persists lifecycle evidence`, (context) => {
    const fixtureData = fixture(context);
    const moduleUrl = new URL("./server-diagnostics.ts", import.meta.url).href;
    const actions = {
      normal: "process.exitCode = 7;",
      fatal: "setImmediate(() => { throw new Error('fixture-secret'); });",
      rejection: "Promise.reject(new Error('fixture-secret'));",
      "http-error": "const server = createServer(); diagnostics.attach(server); server.emit('error', Object.assign(new Error('fixture-secret'), {code:'EADDRINUSE'}));",
    };
    const script = `import {ServerDiagnostics} from ${JSON.stringify(moduleUrl)};
      import {createServer} from 'node:http';
      const diagnostics = new ServerDiagnostics({stateDir:${JSON.stringify(fixtureData.stateDir)},logging:${JSON.stringify(logging)}});
      ${actions[mode]}`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, mode === "normal" ? 7 : 1, child.stderr);
    const rows = fixtureData.rows();
    assert(rows.some((row) => row.event === "server_exit" && row.exitCode === child.status));
    assert(rows.every((row) => row.pid === child.pid && typeof row.instanceId === "string"));
    if (mode !== "normal") assert(rows.some((row) => row.event === "server_uncaught_exception"));
    if (mode === "rejection") assert(rows.some((row) => row.origin === "unhandledRejection"));
    if (mode === "http-error") assert(rows.some((row) => row.event === "server_http_error" && row.errorCode === "EADDRINUSE"));
    assert(!readFileSync(fixtureData.path, "utf8").includes("fixture-secret"));
  });
}
