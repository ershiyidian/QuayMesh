import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { environmentValue, mergeEnvironment, resolveExecutableCommand, spawnCommandSync } from "./local-agent-command.js";

test("Windows 环境变量合并只保留一个名称，显式覆盖优先", () => {
  const merged = mergeEnvironment("win32", { Path: "first", PATHEXT: ".EXE" }, { path: "second", PathExt: ".EXE;.CMD" });
  assert.deepEqual(merged, { PATH: "second", PATHEXT: ".EXE;.CMD" });
  assert.equal(environmentValue({ Path: "actual" }, "PATH", "win32"), "actual");
  assert.deepEqual(mergeEnvironment("linux", { Path: "first", PATH: "second" }), { Path: "first", PATH: "second" });
});

test("普通环境对象中的 Path 可以解析并启动实际 Node 可执行文件", () => {
  const env = mergeEnvironment(process.platform, process.env, process.platform === "win32"
    ? { Path: dirname(process.execPath) } : { PATH: dirname(process.execPath) });
  const executable = resolveExecutableCommand(basename(process.execPath), env);
  assert.equal(executable?.toLowerCase(), process.execPath.toLowerCase());
  const result = spawnCommandSync(executable!, ["--version"], { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
});

test("包含空格的明确程序路径与命令包装文件按真实平台启动", async t => {
  const directory = await mkdtemp(join(tmpdir(), "quaymesh command "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = join(directory, basename(process.execPath));
  await copyFile(process.execPath, native);
  await chmod(native, 0o755);
  const env = mergeEnvironment(process.platform, process.env, { PATH: directory });
  assert.equal(resolveExecutableCommand(native, env), native);
  const result = spawnCommandSync(native, ["--version"], { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
  if (process.platform === "win32") {
    const wrapper = join(directory, "version reader.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" --version\r\n`, "utf8");
    const resolved = resolveExecutableCommand("version reader", env);
    assert.equal(resolved?.toLowerCase(), wrapper.toLowerCase());
    const cmdResult = spawnCommandSync(resolved!, [], { env, encoding: "utf8", windowsHide: true });
    assert.equal(cmdResult.status, 0, cmdResult.stderr);
    assert.equal(cmdResult.stdout.trim(), process.version);
  }
  assert.equal(resolveExecutableCommand("quaymesh-missing-executable", env), undefined);
});
