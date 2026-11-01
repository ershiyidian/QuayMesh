import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {existsSync} from 'node:fs';
import { CONSOLE_READ_OPERATIONS,CONSOLE_READ_BUSINESS_ERRORS } from './read-protocol.js';

export const CONSOLE_READ_TIMEOUT_MS = 5_000;
export const CONSOLE_READ_REQUEST_BYTES = 64 * 1024;
export const CONSOLE_READ_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED = 8;
const IDLE_READER_MS = 30_000;

export class ConsoleReadError extends Error {
  readonly status:number;
  readonly effect = 'none';
  constructor(readonly code: string) {
    const known=Object.hasOwn(CONSOLE_READ_BUSINESS_ERRORS,code)
      ? CONSOLE_READ_BUSINESS_ERRORS[code as keyof typeof CONSOLE_READ_BUSINESS_ERRORS] : undefined;
    super(known?.message??(code === 'console_read_timeout' ? '控制台读取超时，已终止该只读查询，请稍后重试'
      : code === 'console_read_busy' ? '控制台读取队列繁忙，请稍后重试'
      : code === 'console_read_too_large' ? '控制台读取结果超过大小限制，请缩小范围'
      : code === 'console_read_aborted' ? '控制台读取已取消' : '控制台读取失败，请稍后重试'));
    this.status=known?.status??503;
    this.name = 'ConsoleReadError';
  }
}

interface ReadJob {
  id: number;
  input: string;
  resolve: (value: unknown) => void;
  reject: (error: ConsoleReadError) => void;
  deadline: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
  child?: ChildProcessWithoutNullStreams;
  done: boolean;
  route: string;
  createdAt: number;
  result: string;
  finishReported: boolean;
}
interface Reader {
  child: ChildProcessWithoutNullStreams;
  closing: boolean;
  chunks: Buffer[];
  bytes: number;
  idle?: ReturnType<typeof setTimeout>;
}

export interface ConsoleReadDiagnostic {
  event: 'console_read'; phase: 'start'|'finish'|'timeout'; route: string;
  childPid: number|null; elapsedMs: number; result: string;
}

/** One owned, sequential reader with bounded waiting capacity. Reusing its
 * module cache avoids a cold SQLite/schema import for each healthy read. Native
 * work is still stopped by terminating this process, never by Promise.race. */
export class ConsoleReadProcessPool {
  private readonly queue: ReadJob[] = [];
  private active: ReadJob | null = null;
  private reader?: Reader;
  private closed = false;
  private sequence = 0;
  constructor(private readonly worker = new URL('./read-worker.js', import.meta.url),
    private readonly timeoutMs = CONSOLE_READ_TIMEOUT_MS,
    private readonly report:(event:ConsoleReadDiagnostic)=>void = event=>console.info(JSON.stringify(event))) {}

  read<T>(request: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new ConsoleReadError('console_read_aborted'));
    if (this.queue.length >= MAX_QUEUED) return Promise.reject(new ConsoleReadError('console_read_busy'));
    if(!Number.isSafeInteger(this.sequence+1))return Promise.reject(new ConsoleReadError('console_read_failed'));
    const id=++this.sequence;
    let input: string;
    try { input = JSON.stringify({id,request}); }
    catch { return Promise.reject(new ConsoleReadError('console_read_invalid')); }
    if (typeof input !== 'string' || Buffer.byteLength(input) > CONSOLE_READ_REQUEST_BYTES)
      return Promise.reject(new ConsoleReadError('console_read_too_large'));
    return new Promise<T>((resolve, reject) => {
      const operation=(request as {operation?:unknown}|null)?.operation;
      const route=CONSOLE_READ_OPERATIONS.includes(operation as typeof CONSOLE_READ_OPERATIONS[number])?String(operation):'unknown';
      const job: ReadJob = { id,input, resolve: value => resolve(value as T), reject, done: false,
        route,createdAt:performance.now(),result:'pending',finishReported:false,
        deadline: setTimeout(() => this.fail(job, 'console_read_timeout'), this.timeoutMs), signal };
      job.abort = () => this.fail(job, 'console_read_aborted');
      signal?.addEventListener('abort', job.abort, {once: true});
      this.queue.push(job); this.drain();
    });
  }

  close(): void {
    this.closed = true;
    for (const job of [...this.queue]) this.fail(job, 'console_read_aborted');
    if(this.active)this.fail(this.active,'console_read_aborted');
    if(this.reader)this.stopReader(this.reader);
  }

  private settle(job: ReadJob, error?: string, value?: unknown): void {
    if (job.done) return;
    job.done = true; job.result=error??'completed'; clearTimeout(job.deadline);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
    const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1);
    if (error) job.reject(new ConsoleReadError(error)); else job.resolve(value);
    if(!job.child)this.diagnostic(job,'finish');
  }

  private diagnostic(job:ReadJob,phase:ConsoleReadDiagnostic['phase']):void {
    if(phase==='finish'){if(job.finishReported)return;job.finishReported=true;}
    try{this.report({event:'console_read',phase,route:job.route,childPid:job.child?.pid??null,
      elapsedMs:Math.round(performance.now()-job.createdAt),result:job.result});}catch{/* Logging cannot change query lifecycle. */}
  }

  private fail(job: ReadJob, code: string): void {
    if(job.done)return;
    if(code==='console_read_timeout'){job.result=code;this.diagnostic(job,'timeout');}
    this.settle(job, code);
    if(this.active===job&&this.reader)this.stopReader(this.reader);
    // A killed native query retains its capacity slot until OS close. Never
    // start replacements just because its public Promise has already rejected.
    this.drain();
  }

  private stopReader(reader:Reader):void {
    if(reader.closing)return;
    reader.closing=true;clearTimeout(reader.idle);
    if(reader.child.exitCode===null&&reader.child.signalCode===null)reader.child.kill('SIGKILL');
  }

  private reference(reader:Reader,active:boolean):void {
    if(active)reader.child.ref();else reader.child.unref();
    // Spawned pipe streams expose public ref/unref on supported Node platforms.
    // Idle readers must not keep a CLI/test process alive after its work ends.
    for(const stream of [reader.child.stdin,reader.child.stdout,reader.child.stderr]) {
      const handle=stream as typeof stream & {ref?:()=>void;unref?:()=>void};
      if(active)handle.ref?.();else handle.unref?.();
    }
  }

  private drain(): void {
    if(this.closed||this.active||this.reader?.closing)return;
    const job=this.queue.shift();
    if(!job){
      if(this.reader&&!this.reader.idle){
        const reader=this.reader;this.reference(reader,false);
        reader.idle=setTimeout(()=>this.stopReader(reader),IDLE_READER_MS);reader.idle.unref();
      }
      return;
    }
    if(job.done){this.drain();return;}
    this.active=job;
    let reader:Reader;
    try{reader=this.reader??this.spawnReader();}
    catch{this.active=null;this.settle(job,'console_read_failed');this.drain();return;}
    clearTimeout(reader.idle);reader.idle=undefined;this.reference(reader,true);
    job.child=reader.child;this.diagnostic(job,'start');
    reader.child.stdin.write(job.input+'\n',error=>{if(error&&this.active===job)this.fail(job,'console_read_failed');});
  }

  private spawnReader():Reader {
    const env: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(process.env)) if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|TZ)$/i.test(key))
      env[key] = process.env[key];
    const worker=!existsSync(this.worker)&&import.meta.url.endsWith('.ts')&&this.worker.href===new URL('./read-worker.js',import.meta.url).href
      ? new URL('../../dist/console-workbench/read-worker.js',import.meta.url) : this.worker;
    const child=spawn(process.execPath,['--max-old-space-size=192',fileURLToPath(worker)],
      {env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const reader:Reader={child,closing:false,chunks:[],bytes:0};this.reader=reader;
    child.stdout.on('data',(chunk:Buffer)=>this.receive(reader,chunk));
    (child.stderr as Readable).resume();
    const failed=()=>{
      if(this.reader!==reader)return;
      if(this.active)this.fail(this.active,'console_read_failed');
      else this.stopReader(reader);
    };
    child.stdin.on('error',failed);child.on('error',failed);
    child.on('close',()=>{
      clearTimeout(reader.idle);
      if(this.reader!==reader)return;
      const job=this.active;
      if(job){this.settle(job,'console_read_failed');this.diagnostic(job,'finish');}
      this.active=null;this.reader=undefined;this.drain();
    });
    return reader;
  }

  private receive(reader:Reader,chunk:Buffer):void {
    if(this.reader!==reader||reader.closing)return;
    const job=this.active;
    if(!job){this.stopReader(reader);return;}
    const newline=chunk.indexOf(10);
    // There is exactly one in-flight request. A second/unsolicited frame cannot
    // belong to the next job, which has not been sent yet.
    if(newline>=0&&newline!==chunk.length-1){this.fail(job,'console_read_failed');return;}
    const part=newline<0?chunk:chunk.subarray(0,newline);
    reader.bytes+=part.length;
    if(reader.bytes>CONSOLE_READ_RESULT_BYTES){this.fail(job,'console_read_too_large');return;}
    reader.chunks.push(part);
    if(newline<0)return;
    try{
      const response=JSON.parse(Buffer.concat(reader.chunks).toString('utf8')) as {id?:unknown;ok?:boolean;value?:unknown;code?:string};
      if(response.id!==job.id)throw new Error('unexpected_frame');
      reader.chunks=[];reader.bytes=0;
      if(response.ok===true&&Object.hasOwn(response,'value'))this.settle(job,undefined,response.value);
      else if(response.ok===false)this.settle(job,
        response.code==='console_read_too_large'||typeof response.code==='string'&&Object.hasOwn(CONSOLE_READ_BUSINESS_ERRORS,response.code)
          ?response.code:'console_read_failed');
      else throw new Error('invalid_frame');
      this.diagnostic(job,'finish');this.active=null;this.drain();
    }catch{this.fail(job,'console_read_failed');}
  }
}
