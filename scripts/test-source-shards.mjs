// Complete source test suite with independent bounded receipts per shard.
// Never treat a timed-out or missing shard as a passing test.
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {join,relative,resolve} from "node:path";

const root=resolve(import.meta.dirname,"..");
const tests=walk(join(root,"src")).filter(x=>x.endsWith(".test.ts"))
  .map(x=>relative(root,x).replaceAll("\\","/")).sort();
const shardSize=Number(process.argv.find(x=>x.startsWith("--size="))?.slice(7)??"8");
if(!Number.isSafeInteger(shardSize)||shardSize<1||shardSize>24)throw new Error("INVALID_SHARD_SIZE");
const outDir=resolve(root,"releases","source-shard-receipts");
mkdirSync(outDir,{recursive:true});
const runId=new Date().toISOString().replace(/[:.]/g,"-");
const reportFile=join(outDir,`${runId}-aggregate.json`);
const sourceSha=spawnSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",timeout:5000}).stdout?.trim();
const groups=[];
for(let i=0;i<tests.length;i+=shardSize)groups.push(tests.slice(i,i+shardSize));
const from=Number(process.argv.find(x=>x.startsWith("--from="))?.slice(7)??"1");
const to=Number(process.argv.find(x=>x.startsWith("--to="))?.slice(5)??String(groups.length));
if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<1||to<from||to>groups.length)
  throw new Error("INVALID_SHARD_RANGE");
const chosen=groups.map((files,index)=>({files,index:index+1})).filter(x=>x.index>=from&&x.index<=to);
const aggregate={runId,sourceCommit:sourceSha,totalFiles:tests.length,totalShards:groups.length,
  selectedShards:{from,to},selectedFiles:chosen.reduce((sum,x)=>sum+x.files.length,0),shards:chosen.length,complete:false,
  results:[],started:new Date().toISOString(),ended:null,summary:{passed:0,failed:0,incomplete:0}};
save();
for(const {files:paths,index} of chosen){
  const started=new Date().toISOString();
  const result=spawnSync(process.execPath,["--import","tsx","scripts/test-with-receipt.ts",...paths],{
    cwd:root,encoding:"utf8",timeout:670000,maxBuffer:4*1024*1024,windowsHide:true,
    env:{...process.env,NO_COLOR:"1"},
  });
  let receipt;
  try{receipt=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)??"");}catch{receipt=null;}
  const status=result.status===0&&receipt?.status==="passed"&&!result.error?"passed":receipt?.status??"incomplete";
  const entry={index,started,files:paths,status,receiptPath:receipt?.receiptPath??null,
    count:receipt?.counts??null,exitCode:result.status,error:result.error?.message??null,
    stderrTail:result.stderr?.slice(-900)??"",stdoutTail:receipt?null:result.stdout.slice(-900)};
  aggregate.results.push(entry);
  if(status==="passed")aggregate.summary.passed++;else if(status==="failed")aggregate.summary.failed++;else aggregate.summary.incomplete++;
  console.log(JSON.stringify({index:entry.index,of:groups.length,status,files:paths.length,receiptPath:entry.receiptPath}));
  save();
}
aggregate.ended=new Date().toISOString();
aggregate.complete=aggregate.results.length===chosen.length&&aggregate.results.every(x=>x.status==="passed");
save();
console.log(JSON.stringify({reportFile,complete:aggregate.complete,summary:aggregate.summary,totalFiles:tests.length,sourceSha256:createHash("sha256").update(JSON.stringify(tests)).digest("hex")}));
if(!aggregate.complete)process.exitCode=1;

function save(){writeFileSync(reportFile,JSON.stringify(aggregate,null,2));}
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
  const path=join(dir,e.name);return e.isDirectory()?walk(path):e.isFile()?[path]:[];
});}
