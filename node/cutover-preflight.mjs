// Executed outside the QuayMesh worker, before replacing the Windows service.
// Never stop an active agent, command, or admitted tool invocation.
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../package.json", import.meta.url));
const Database = require("better-sqlite3");

export function checkCutoverIdle(stateDir) {
  const db = new Database(join(resolve(stateDir), "core", "quaymesh.sqlite"),
    { readonly: true, fileMustExist: true, timeout: 3000 });
  try {
    const count = sql => Number(db.prepare(sql).get().count);
    const claims = count("SELECT count(*) AS count FROM execution_claims");
    const activeWork = count("SELECT count(*) AS count FROM qm_runtime_work WHERE blocking=1");
    const commands = count("SELECT count(*) AS count FROM console_operations WHERE status IN ('running','starting')");
    const agents = count("SELECT count(*) AS count FROM console_executions WHERE status IN ('running','starting')");
    return { idle: claims + activeWork + commands + agents === 0,
      claims, activeWork, commands, agents };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const status = checkCutoverIdle(process.argv[2]);
  console.log(JSON.stringify(status));
  if (!status.idle) process.exitCode = 2;
}
