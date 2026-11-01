import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyEasyTierCompanions, verifyComponentBinaries } from "../component-binaries.mjs";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "quaymesh-components-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function executable(target, name) {
  const path = join(target, name + (process.platform === "win32" ? ".exe" : ""));
  if (process.platform === "win32") await cp(process.execPath, path);
  else await symlink(process.execPath, path);
  return path;
}

test("Windows EasyTier 导入保留现有的 CLI、DLL 和驱动", async t => {
  const root = await directory(t);
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source); await mkdir(target);
  const names = ["easytier-cli.exe", "libgcc_s_seh-1.dll", "libwinpthread-1.dll", "Packet.dll", "WinDivert64.sys", "wintun.dll"];
  for (const name of [...names, "unrelated.dll"]) await writeFile(join(source, name), "content:" + name);
  await copyEasyTierCompanions(join(source, "easytier-core.exe"), target, "win32");
  assert.deepEqual((await readdir(target)).sort(), [...names].sort());
  for (const name of names) assert.equal(await readFile(join(target, name), "utf8"), "content:" + name);
});

test("静态 EasyTier 来源允许没有配套文件", async t => {
  const root = await directory(t);
  const target = join(root, "target"); await mkdir(target);
  await copyEasyTierCompanions(join(root, "easytier-core.exe"), target, "win32");
  assert.deepEqual(await readdir(target), []);
});

test("从最终组件目录启动必需程序，并检查存在的 CLI", async t => {
  const target = await directory(t);
  for (const name of ["easytier-core", "tunnel-client"]) await executable(target, name);
  assert.deepEqual(await verifyComponentBinaries(target), {
    "easytier-core": process.version, "tunnel-client": process.version,
  });
  await executable(target, "easytier-cli");
  assert.equal((await verifyComponentBinaries(target))["easytier-cli"], process.version);
});

test("缺少必需的可执行文件会拒绝发行包", async t => {
  const target = await directory(t);
  await executable(target, "easytier-core");
  await assert.rejects(verifyComponentBinaries(target), error => error.message.includes("tunnel-client") && error.cause.code === "ENOENT");
});

test("文件存在但系统加载失败时拒绝发行包", { skip: process.platform === "win32" }, async t => {
  const target = await directory(t);
  for (const name of ["easytier-core", "tunnel-client"]) await executable(target, name);
  const cli = join(target, "easytier-cli");
  await writeFile(cli, "#!/quaymesh-test-missing-interpreter\n");
  await chmod(cli, 0o755);
  await assert.rejects(verifyComponentBinaries(target), error => error.message.includes("easytier-cli") && error.cause.code === "ENOENT");
});

test("组件非零退出会拒绝发行包", { skip: process.platform === "win32" }, async t => {
  const target = await directory(t);
  await executable(target, "easytier-core");
  const tunnel = join(target, "tunnel-client");
  await writeFile(tunnel, "#!/bin/sh\nexit 126\n");
  await chmod(tunnel, 0o755);
  await assert.rejects(verifyComponentBinaries(target), error => error.message.includes("tunnel-client") && error.cause.code === 126);
});
