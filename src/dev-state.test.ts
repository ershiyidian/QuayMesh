import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = await mkdtemp(join(tmpdir(), "quaymesh-dev-state-test-"));
const checkoutRoot = join(root, "checkout");
const sourceConfigDir = join(root, "config");
const sourceStateDir = join(root, "state");
const scriptPath = fileURLToPath(new URL("../scripts/dev-state.ts", import.meta.url));
const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));

try {
  await mkdir(checkoutRoot, { recursive: true });
  await mkdir(join(sourceConfigDir, "skills", "example"), { recursive: true });
  await mkdir(sourceStateDir, { recursive: true });
  await writeFile(join(sourceConfigDir, "config.jsonc"), JSON.stringify({
    configVersion: 1,
    storage: { stateDir: sourceStateDir },
  }));
  await writeFile(join(sourceConfigDir, "auth.json"), JSON.stringify({
    ownerToken: "test-owner-token-that-is-long-enough",
  }));
  await writeFile(join(sourceConfigDir, "skills", "example", "SKILL.md"), "example skill\n");

  const sourceDatabase = new Database(join(sourceStateDir, "quaymesh.sqlite"));
  sourceDatabase.exec("create table marker (value text); insert into marker values ('source')");
  sourceDatabase.close();

  await runDevState("seed");

  const devRoot = join(checkoutRoot, ".quaymesh-dev");
  const localConfig = JSON.parse(
    await readFile(join(devRoot, "config", "config.jsonc"), "utf8"),
  ) as { storage: { stateDir: string } };
  assert.equal(
    await realpath(localConfig.storage.stateDir),
    await realpath(join(devRoot, "state")),
  );
  assert.equal(existsSync(join(devRoot, "config", "auth.json")), true);
  assert.equal(existsSync(join(devRoot, "config", "skills", "example", "SKILL.md")), false,
    "开发状态必须与真实用户的技能目录隔离");
  const firstAuth=JSON.parse(await readFile(join(devRoot,"config","auth.json"),"utf8"));
  assert.notEqual(firstAuth.ownerToken,"test-owner-token-that-is-long-enough");
  assert.equal(localConfig.storage.stateDir,join(devRoot,"state"));

  const localDatabasePath = join(devRoot, "state", "quaymesh.sqlite");
  const localDatabase = new Database(localDatabasePath);
  assert.equal(localDatabase.prepare("select name from sqlite_master where name='marker'").get(),undefined,
    "开发数据库不应包含生产样本表");
  localDatabase.exec("create table marker (value text); insert into marker values ('local-only')");
  localDatabase.close();

  await assert.rejects(runDevState("seed"), /开发目录已经存在/);

  await rm(join(sourceConfigDir, "auth.json"));
  // Reset is scoped to the development checkout and does not depend on a
  // missing or damaged operator auth.json.
  await runDevState("reset");

  const resetDatabase = new Database(localDatabasePath, { readonly: true });
  assert.equal(resetDatabase.prepare("select name from sqlite_master where name='marker'").get(),undefined);
  resetDatabase.close();
  const secondAuth=JSON.parse(await readFile(join(devRoot,"config","auth.json"),"utf8"));
  assert.notEqual(secondAuth.ownerToken,firstAuth.ownerToken);
  const preservedSource=new Database(join(sourceStateDir,"quaymesh.sqlite"),{readonly:true});
  assert.deepEqual(preservedSource.prepare("select value from marker").pluck().all(),["source"]);
  preservedSource.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("dev state tests passed");

async function runDevState(command: "seed" | "reset"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCliPath, scriptPath, command],
      {
        cwd: checkoutRoot,
        env: {
          ...process.env,
          QUAYMESH_CONFIG_DIR: sourceConfigDir,
          QUAYMESH_OAUTH_OWNER_TOKEN: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `dev-state exited with ${code}`));
    });
  });
}
