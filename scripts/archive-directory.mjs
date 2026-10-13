import { spawn } from "node:child_process";
import { resolve,dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL("..",import.meta.url));
const source=resolve(process.argv[2]);
const command=process.platform==="win32"?"python":"python3";
const child=spawn(command,[resolve(root,"scripts","package-source.py"),"--directory",source,"--output",source+".zip"],{stdio:"inherit"});
child.once("error",error=>{console.error(error);process.exitCode=1;});
child.once("close",code=>{process.exitCode=code||0;});
