import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WorkLedger } from '../src/work-ledger.js';
import { SessionStore } from '../src/session/store.js';
import { OperationState } from '../src/session/types.js';

test('周期账本核对遇真实 SQLite 写锁后进程存活，并在释放锁后收敛原操作', {timeout: 20_000}, async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'quaymesh-reconcile-busy-'));
  const ledger = new WorkLedger(stateDir);
  const store = new SessionStore(ledger.db);
  const session = store.createSession('owner', 'busy-reconciler', '后台核对');
  const member = store.addMember(session.id, 'local', 'ws', stateDir, 'checkout', null);
  const task = store.createTask(session.id, '后台核对');
  const run = ledger.begin({root: stateDir, workspaceId: 'ws', workItemId: 'busy', runKey: 'busy',
    title: '后台核对', origin: {entryPoint: 'chatgpt_mcp', evidence: 'server_entry'}});
  store.linkRun(session.id, member.id, run.id, task.id);
  const operationId = 'op_reconcile_busy';
  const childEnvironment = {...process.env};
  delete childEnvironment.NODE_TEST_CONTEXT;
  const child = fork(new URL('./reliability-background-worker.ts', import.meta.url), [stateDir, operationId], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: childEnvironment,
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.stdout!.resume();
  const messages: Array<{type: string; operationId?: string; pid?: number; code?: string}> = [];
  child.on('message', message => messages.push(message as typeof messages[number]));
  const exited = new Promise<{code: number | null; signal: string | null}>(resolve => {
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  t.after(async () => {
    if (ledger.db.inTransaction) ledger.db.exec('ROLLBACK');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    ledger.close();
    await rm(stateDir, {recursive: true, force: true});
  });
  const readyBy = Date.now() + 5_000;
  while (!messages.some(message => message.type === 'ready') && Date.now() < readyBy) {
    assert.equal(child.exitCode, null, stderr);
    await delay(10);
  }
  assert.ok(messages.some(message => message.type === 'ready'), stderr);

  // 锁由父进程真实持有；子进程的 SQLite 同步等待不能阻止父进程按时释放。
  ledger.db.exec('BEGIN IMMEDIATE');
  ledger.operation({id: operationId, runId: run.id, requestKey: 'busy-operation', kind: 'command', label: '原操作', status: 'running'});
  store.reserveInvocation({id: 'inv_reconcile_busy', ownerId: 'owner', transportInstanceId: 'transport',
    requestId: 'finished', sessionId: session.id, memberId: member.id, toolName: 'exec_command', argumentsJson: '{}'});
  store.updateInvocation({ownerId: 'owner', transportInstanceId: 'transport', requestId: 'finished',
    operationId, state: OperationState.succeeded, effect: 'completed', result: {exit_code: 0}, finished: true});
  const busyBy = Date.now() + 9_000;
  while (!messages.some(message => message.type === 'reconcile-error') && child.exitCode === null && Date.now() < busyBy) await delay(10);
  const busy = messages.find(message => message.type === 'reconcile-error');
  ledger.db.exec('COMMIT');
  const result = await exited;
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  assert.match(busy?.code ?? '', /^SQLITE_BUSY/);
  assert.equal(busy?.pid, messages.find(message => message.type === 'ready')?.pid);
  assert.deepEqual(messages.filter(message => message.type === 'reconciled'), [{type: 'reconciled', operationId}]);
  assert.equal((ledger.db.prepare('SELECT status FROM console_operations WHERE id=?').get(operationId) as {status: string}).status, 'completed');
});
