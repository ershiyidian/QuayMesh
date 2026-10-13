import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { restrictedEnvironment } from "../node/environment.mjs";

const root=resolve(process.cwd()),directory=join(root,".quaymesh-dev");
const marker=JSON.parse(await readFile(join(directory,"development.json"),"utf8"));
if(marker.scope!=="quaymesh-development"||marker.checkout!==root)throw new Error("请在当前检出目录运行 pnpm dev:seed");
const child=spawn(process.execPath,["--import","tsx","--watch","src/cli.ts","serve"],{
  cwd:root,stdio:"inherit",shell:false,env:{...restrictedEnvironment(process.env),
    QUAYMESH_CONFIG_DIR:join(directory,"config"),CODEX_HOME:join(directory,"providers","codex")},
});
child.once("error",error=>{console.error(error);process.exitCode=1;});
child.once("close",code=>{process.exitCode=code??1;});
process.once("SIGINT",()=>child.kill("SIGINT"));
process.once("SIGTERM",()=>child.kill("SIGTERM"));
