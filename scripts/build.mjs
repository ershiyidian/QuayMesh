import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL("..",import.meta.url));
async function run(entry,args) {
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,...args],{cwd:root,stdio:"inherit",shell:false});
    child.once("error",reject);
    child.once("close",code=>code===0?resolve():reject(new Error(`${entry} 退出码 ${code}`)));
  });
}
await rm(join(root,"dist"),{recursive:true,force:true});
const vite=join(dirname(require.resolve("vite/package.json")),"bin","vite.js");
await run(vite,["build"]);
await run(vite,["build","--config","vite.card.config.ts"]);
await run(join(root,"scripts","copy-fleet-assets.mjs"),[]);
await run(require.resolve("typescript/bin/tsc"),["-p","tsconfig.build.json"]);
