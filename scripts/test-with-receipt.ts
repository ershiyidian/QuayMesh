// Source-checkout runner: pnpm exec tsx scripts/test-with-receipt.ts [src/...test.ts ...]
// Executes a new test run, not a reader for historical or blocked tool output.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestReceiptSummary } from "../src/test-receipt.js";
import { terminateProcessTree } from "../src/process-platform.js";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
const sources = walk(join(root, "src")).sort();
const requested = process.argv.slice(2);
const tests = requested.length ? requested.map((value) => {
  if (isAbsolute(value) || !/^src\/[A-Za-z0-9_./-]+\.test\.ts$/.test(value) || value.split("/").includes("..")) throw new Error("Use explicit source-checkout test paths.");
  const path = realpathSync(resolve(root, value));
  if (!sources.includes(path)) throw new Error("Test must be a regular file in this checkout.");
  return path;
}) : sources.filter((path) => path.endsWith(".test.ts"));
if (!tests.length) throw new Error("No test files selected.");
function fingerprint(): string {
  const hash = createHash("sha256");
  // Re-enumerate at the end as well: added/deleted source files and runner
  // changes invalidate the receipt, not just edits to the initial file list.
  const manifestFiles = [...walk(join(root, "src")), fileURLToPath(import.meta.url),
    ...["package.json", "pnpm-lock.yaml", "tsconfig.json"].map((name) => join(root, name))].sort();
  for (const path of manifestFiles) {
    hash.update(relative(root, path)); hash.update("\0"); hash.update(readFileSync(path)); hash.update("\0");
  }
  return hash.digest("hex");
}
const before = fingerprint();
const directory = join(root, "releases", "test-receipts");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
const testCodexHome = join(directory, `${id}-codex-home`);
mkdirSync(testCodexHome, { recursive: false, mode: 0o700 });
const logPath = join(directory, `${id}.log`), receiptPath = join(directory, `${id}.json`);
const fd = openSync(logPath, "wx", 0o600);
const parser = new TestReceiptSummary();
let savedBytes = 0, truncated = false, timedOut = false, interrupted = false;
const started = new Date().toISOString();
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5_000 }).stdout?.trim();
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=120000", "--test-reporter=tap", ...tests], {
  // Unit/integration fixtures must not discover the operator's real Desktop
  // catalog or authenticated Codex home when exercising automatic creation.
  // Real Desktop acceptance uses the separate explicit verification command.
  cwd: root, env: { ...process.env, NO_COLOR: "1", CODEX_HOME: testCodexHome }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
});
const save = (chunk: Buffer) => {
  const remaining = Math.max(0, 16 * 1024 * 1024 - savedBytes);
  if (remaining < chunk.length) truncated = true;
  if (remaining) { const piece = chunk.subarray(0, remaining); writeSync(fd, piece); savedBytes += piece.length; }
};
child.stdout.on("data", (chunk: Buffer) => { save(chunk); parser.accept(chunk.toString("utf8")); });
child.stderr.on("data", save);
let startupFailed = false;
child.on("error", () => { startupFailed = true; });
const timeout = setTimeout(() => {
  timedOut = true;
  terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
}, 600_000);
const interrupt = () => {
  interrupted = true;
  if (child.exitCode === null && child.signalCode === null) terminateProcessTree(child, "SIGTERM", process.platform !== "win32");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
child.once("close", (exitCode, signal) => {
  clearTimeout(timeout); closeSync(fd);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  let after: string | null = null;
  try { after = fingerprint(); } catch { /* Deleted sources fail verification. */ }
  const receipt = { id, started, finished: new Date().toISOString(), sourceCommit: /^[a-f0-9]{40,64}$/.test(head ?? "") ? head : null,
    sourceSha256: before, afterSourceSha256: after, selectedTestFiles: tests.length,
    runner: { engine: "node:test", loader: "tsx", concurrency: 1, reporter: "tap", perTestTimeoutMs: 120_000, processTimeoutMs: 600_000, isolatedCodexHome: true },
    ...parser.result(exitCode, before === after), startupFailed, timedOut, interrupted, signal,
    rawLogPath: logPath, rawLogTruncated: truncated, rawLogSha256: createHash("sha256").update(readFileSync(logPath)).digest("hex"), receiptPath };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(receipt));
  process.exitCode = receipt.status === "passed" && !startupFailed && !timedOut && !interrupted && !signal ? 0 : 1;
});
