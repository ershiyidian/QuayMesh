import ts from "typescript";
import { readdir,readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve,dirname,extname,relative } from "node:path";
import { SourceTextModule,Script } from "node:vm";
import { fileURLToPath } from "node:url";

const root=fileURLToPath(new URL("..",import.meta.url));
const errors=[];
let parsed=0;
async function walk(directory){
  const result=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=resolve(directory,entry.name);
    if(entry.isDirectory())result.push(...await walk(path));
    else result.push(path);
  }
  return result;
}
const files=(await Promise.all(["src","node","scripts"].map(name=>walk(resolve(root,name))))).flat();
for(const file of files){
  if(!/\.(ts|tsx|mjs|cjs|js)$/.test(file)||file.endsWith(".d.ts")||file.endsWith(".d.mts"))continue;
  const source=await readFile(file,"utf8");
  let output=source;
  if(/\.tsx?$/.test(file)){
    const result=ts.transpileModule(source,{fileName:file,reportDiagnostics:true,
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});
    for(const diagnostic of result.diagnostics||[])if(diagnostic.category===ts.DiagnosticCategory.Error)
      errors.push(`${relative(root,file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,"\n")}`);
    output=result.outputText;
  }
  try {
    if(file.endsWith(".cjs"))new Script(output,{filename:file});
    else new SourceTextModule(output,{identifier:file});
  }catch(error){errors.push(`${relative(root,file)}: ${error.message}`);}
  if(!file.endsWith(".test.ts")&&!file.includes("/test/")){
    const info=ts.preProcessFile(source,true,true);
    for(const item of info.importedFiles){
      if(!item.fileName.startsWith("."))continue;
      const target=resolve(dirname(file),item.fileName);
      const candidates=[target,target.replace(/\.js$/,".ts"),target.replace(/\.js$/,".tsx"),target.replace(/\.mjs$/,".mts"),
        resolve(target,"index.ts")];
      if(target.includes("/dist/"))continue;
      if(!candidates.some(existsSync))errors.push(`${relative(root,file)}: 无法定位 ${item.fileName}`);
    }
  }
  parsed++;
}
console.log(JSON.stringify({parsed,errors},null,2));
if(errors.length)process.exitCode=1;
