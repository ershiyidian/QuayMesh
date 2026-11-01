import { ConsoleReadProcessPool, type ConsoleReadDiagnostic } from '../console-workbench/read-process.js';
import { existsSync } from 'node:fs';
import { parseStatusReadRequest, type StatusReadRequest, type StatusReadResult } from './status-read-protocol.js';

/** Separate capacity from Console reads. One owner per SessionRuntime. */
export class SessionStatusReader {
  private readonly pool: ConsoleReadProcessPool;
  constructor(private readonly stateDir: string, private readonly nodeId: string,
    report: (event:ConsoleReadDiagnostic) => void = event => console.info(JSON.stringify(event))) {
    const sourceWorker = new URL('./status-read-worker.js',import.meta.url);
    const worker = !existsSync(sourceWorker) && import.meta.url.endsWith('.ts')
      ? new URL('../../dist/session/status-read-worker.js',import.meta.url) : sourceWorker;
    this.pool = new ConsoleReadProcessPool(worker,5_000,
      event => report({...event,route:'mcp.workspace-status'}));
  }
  read(input:Omit<StatusReadRequest,'operation'|'stateDir'|'nodeId'>,signal?:AbortSignal):Promise<StatusReadResult> {
    return this.pool.read<StatusReadResult>(parseStatusReadRequest({operation:'workspace-status',
      ...input,stateDir:this.stateDir,nodeId:this.nodeId}),signal).catch((error:unknown) => {
      const code = (error as {code?:string})?.code;
      throw Object.assign(new Error(code === 'project_scope' ? 'Workspace status identity changed; re-open the workspace.'
        : 'Workspace status could not be read within its observation budget; retry by operation_id.'), {
        code:code === 'project_scope' ? 'WORKSPACE_SESSION_MISMATCH'
          : code === 'console_read_aborted' ? 'REQUEST_CANCELLED'
          : code === 'console_read_timeout' ? 'REQUEST_TIMEOUT'
          : code === 'console_read_busy' ? 'OBSERVATION_BUSY' : 'OBSERVATION_READ_FAILED',
        effect:'not_started',
      });
    });
  }
  close():void {this.pool.close();}
}
