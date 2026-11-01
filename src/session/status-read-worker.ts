import { useReadonlyDatabases } from '../db/client.js';
import { CONSOLE_READ_REQUEST_BYTES, CONSOLE_READ_RESULT_BYTES } from '../console-workbench/read-process.js';
import { parseStatusReadRequest } from './status-read-protocol.js';

useReadonlyDatabases();
const output = process.stdout.write.bind(process.stdout);
console.log = console.info = console.warn = console.error = console.debug = () => {};

async function execute(frame: Buffer): Promise<{text:string; once:boolean}> {
  let id: number | undefined;
  let once = true;
  let response: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(frame.toString('utf8'));
    let input = parsed;
    // The shared engine's original one-shot and warm-reader releases have
    // distinct framing. Neither branch accepts an operation other than status.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'request')) {
      const envelope = parsed as {id?:unknown;request?:unknown};
      if (Object.keys(envelope).some(key => !['id','request'].includes(key))
        || !Number.isSafeInteger(envelope.id) || Number(envelope.id) <= 0) throw new Error('invalid_status_frame');
      id = envelope.id as number; once = false; input = envelope.request;
    }
    const request = parseStatusReadRequest(input);
    const {readWorkspaceStatus} = await import('./status-read-query.js');
    response = {ok:true,value:readWorkspaceStatus(request)};
  } catch (error) {
    response = {ok:false,code:(error as {code?:unknown})?.code === 'project_scope' ? 'project_scope' : 'console_read_failed'};
  }
  if (id !== undefined) response = {id,...response};
  let text = JSON.stringify(response);
  if (Buffer.byteLength(text) > CONSOLE_READ_RESULT_BYTES)
    text = JSON.stringify({...(id === undefined ? {} : {id}),ok:false,code:'console_read_too_large'});
  return {text,once};
}

async function main(): Promise<void> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffered = Buffer.concat([buffered,Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (buffered.length > CONSOLE_READ_REQUEST_BYTES) throw new Error('status_frame_too_large');
    const newline = buffered.indexOf(10);
    if (newline < 0) continue;
    if (newline !== buffered.length - 1) throw new Error('unexpected_status_frame');
    const result = await execute(buffered.subarray(0,newline));
    buffered = Buffer.alloc(0);
    await new Promise<void>((resolve,reject) => output(result.text+'\n',error => error ? reject(error) : resolve()));
    if (result.once) return;
  }
  if (buffered.length) throw new Error('unfinished_status_frame');
}
await main().catch(() => {process.exitCode = 1;});
