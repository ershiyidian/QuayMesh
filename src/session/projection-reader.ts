import { existsSync } from 'node:fs';
import { ConsoleReadProcessPool, type ConsoleReadDiagnostic } from '../console-workbench/read-process.js';
import { parseProjectionReadRequest, type ProjectionReadRequest, type ProjectionReadResult, type ProjectionCaptureSource } from './projection-read-protocol.js';

export interface ProjectionReadOptions {
  capture?:ProjectionCaptureSource;
  report?:(event:ConsoleReadDiagnostic)=>void;
}

/** Independent capacity: background projections cannot consume Console or MCP
 * status readers. It uses the same bounded process lifecycle and frame limits. */
export class SessionProjectionReader {
  private readonly pool:ConsoleReadProcessPool;
  constructor(report:(event:ConsoleReadDiagnostic)=>void = event => console.info(JSON.stringify(event))) {
    const sourceWorker = new URL('./projection-read-worker.js',import.meta.url);
    const worker = !existsSync(sourceWorker) && import.meta.url.endsWith('.ts')
      ? new URL('../../dist/session/projection-read-worker.js',import.meta.url) : sourceWorker;
    this.pool = new ConsoleReadProcessPool(worker,5_000,event => report({...event,route:'session.projection'}));
  }
  read(request:ProjectionReadRequest,signal:AbortSignal):Promise<ProjectionReadResult> {
    return this.pool.read<ProjectionReadResult>(parseProjectionReadRequest(request),signal).catch((error:unknown) => {
      const code = (error as {code?:string})?.code;
      throw Object.assign(new Error('Session projection was not confirmed; the previous saved snapshot is unchanged.'), {
        code:code === 'revision_conflict' || code === 'project_scope' ? 'PROJECTION_CHANGED'
          : code === 'console_read_aborted' ? 'REQUEST_CANCELLED'
          : code === 'console_read_timeout' ? 'REQUEST_TIMEOUT'
          : code === 'console_read_busy' ? 'PROJECTION_BUSY' : 'PROJECTION_READ_FAILED',
        effect:'not_started',
      });
    });
  }
  close():void {this.pool.close();}
}
