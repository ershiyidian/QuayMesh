import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_SEGMENT_BYTES=8*1024*1024;
const MAX_ARCHIVES=32;
const RETENTION_MS=7*86400_000;

// 保持当前日志路径稳定，历史分段按时间和容量清理。
export function rotateDiagnosticLog(path: string, now=Date.now()): void {
  if(!existsSync(path))return;
  const info=statSync(path);
  if(info.size<MAX_SEGMENT_BYTES && new Date(info.mtimeMs).toISOString().slice(0,10)===new Date(now).toISOString().slice(0,10))return;
  let index=0;
  const prefix=`${path}.${new Date(info.mtimeMs).toISOString().slice(0,10)}`;
  while(existsSync(`${prefix}.${index}`))index++;
  renameSync(path,`${prefix}.${index}`);
  const directory=dirname(path),name=basename(path);
  const archives=readdirSync(directory).filter(file=>file.startsWith(`${name}.`))
    .map(file=>({path:join(directory,file),time:statSync(join(directory,file)).mtimeMs}))
    .sort((a,b)=>b.time-a.time);
  for(const [position,file] of archives.entries())if(position>=MAX_ARCHIVES||now-file.time>RETENTION_MS)unlinkSync(file.path);
}
