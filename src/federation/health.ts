import { cpus, freemem, totalmem, uptime, loadavg, homedir } from "node:os";
import { execFile } from "node:child_process";
import { statfs, stat } from "node:fs/promises";
import { parse, resolve, sep } from "node:path";
import type { NodeManifest } from "./types.js";
let previousCpu: { idle: number; total: number } | undefined;

function sampleCpu(): number | null {
  const current = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
    total: sum.total + Object.values(cpu.times).reduce((total, value) => total + value, 0) }), { idle: 0, total: 0 });
  const previous = previousCpu;
  previousCpu = current;
  if (!previous || current.total <= previous.total) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (current.idle - previous.idle) / (current.total - previous.total))));
}

const mountCache = new Map<string,{mount:string;observedAt:number}>();
async function linuxMount(path:string):Promise<string> {
  const cached=mountCache.get(path);
  if(cached && Date.now()-cached.observedAt < 60000) return cached.mount;
  const output=await new Promise<string>((done,reject)=>execFile("findmnt",
    ["--json","--target",path,"--output","TARGET"],{timeout:1500,maxBuffer:65536},
    (error,stdout)=>error?reject(error):done(stdout)));
  const response=JSON.parse(output) as {filesystems:Array<{target:string}>};
  const mount=response.filesystems?.[0]?.target;
  if(!mount)throw new Error(`无法取得挂载点：${path}`);
  mountCache.set(path,{mount,observedAt:Date.now()});
  return mount;
}
async function diskCandidates(paths:string[]):Promise<Array<{mount:string;path:string}>> {
  const systemPath=process.platform==="win32" ? parse(process.cwd()).root : "/";
  const result:Array<{mount:string;path:string}>=[];
  const seen=new Set<string>();
  for(const value of [systemPath,...paths]) {
    const path=value.startsWith("~")?resolve(homedir(),value.slice(1).replace(/^[/\\\\]/,"")):resolve(value);
    const exists=await stat(path).then(()=>true,(error:NodeJS.ErrnoException)=>{
      if(error.code==="ENOENT"||error.code==="ENOTDIR")return false;
      throw error;
    });
    if(!exists)continue;
    const mount=process.platform==="linux" ? await linuxMount(path) : parse(path).root;
    const key=process.platform==="win32" ? mount.toLowerCase() : mount;
    if(seen.has(key))continue;
    seen.add(key);result.push({mount,path});
  }
  return result;
}

async function sampleDisks(paths: string[]): Promise<NonNullable<NodeManifest["health"]["disks"]>> {
  const result: NonNullable<NodeManifest["health"]["disks"]> = [];
  for (const candidate of await diskCandidates(paths)) {
    const info = await statfs(candidate.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!info) continue;
    const total = info.blocks * info.bsize;
    const free = info.bavail * info.bsize;
    result.push({ mount: candidate.mount, total, free });
  }
  return result;
}

export async function sampleHealth(activeCalls = 0, diskPaths: string[] = []): Promise<NodeManifest["health"]> {
  const cpu = sampleCpu();
  const gpu = await new Promise<{ gpus: NodeManifest["health"]["gpus"]; sampled: boolean }>((resolve) => execFile("nvidia-smi", [
    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits",
  ], { timeout: 2500, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error) {
      resolve({ gpus: [], sampled: (error as NodeJS.ErrnoException).code === "ENOENT" });
      return;
    }
    resolve({ sampled: true, gpus: stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [name, utilization, used, total, temperature] = line.split(",").map((entry) => entry.trim());
      return { name, utilization: Number(utilization) || 0, memoryUsedMiB: Number(used) || 0, memoryTotalMiB: Number(total) || 0,
        ...(temperature && Number.isFinite(Number(temperature)) ? { temperature: Number(temperature) } : {}) };
    }) });
  }));
  const disks = await sampleDisks(diskPaths);
  const uptimeSec = uptime();
  return { cpuCount: cpus().length, cpu, load: loadavg(), memoryTotal: totalmem(), memoryFree: freemem(), uptime: uptimeSec, uptimeSec,
    disks, gpus: gpu.gpus, gpuSampled: gpu.sampled, activeCalls };
}
