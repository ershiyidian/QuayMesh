export const ISOLATED_READ_PREFIX = '/workbench/isolated-v1';
export const READ_UPGRADE_MESSAGE = '此节点需要更新控制台读取服务；已保留上次确认的记录，任务执行状态未因此改变';

/** Fixed Console-only read routes. Receipts reconcile writes and are deliberately
 * outside this protocol. Unknown paths and all POSTs retain their own routing. */
export function isolatedConsoleReadPath(path:string):string {
  const queryAt=path.indexOf('?');
  const pathname=queryAt<0?path:path.slice(0,queryAt),query=queryAt<0?'':path.slice(queryAt);
  if(pathname.startsWith(ISOLATED_READ_PREFIX+'/'))return path;
  const match=/^\/workbench(\/(?:metadata|runs|task-index|session-titles|run-summaries|overview|overview-usage|usage|activity)|\/runs\/[^/]+(?:\/patch|\/(?:files|commands)\/[^/]+)?|\/projects\/[^/]+\/sessions|\/tasks\/[^/]+\/messages-state)$/.exec(pathname);
  return match?ISOLATED_READ_PREFIX+match[1]+query:path;
}

export function isIsolatedConsoleRead(path:string):boolean {
  return path.startsWith(ISOLATED_READ_PREFIX+'/');
}

export function isolatedReadUpgradeRequired(path:string,status:number,body:unknown):boolean {
  if(status!==404||!isIsolatedConsoleRead(path))return false;
  const code=body&&typeof body==='object'?(body as {code?:unknown}).code:undefined;
  // An implemented endpoint may still report a missing domain object. Keep
  // those business failures intact instead of claiming the endpoint is absent.
  return !['run_not_found','task_not_found','session_run_not_found','file_not_found','command_not_found'].includes(String(code));
}
