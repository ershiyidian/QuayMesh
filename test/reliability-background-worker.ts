import { WorkLedger } from '../src/work-ledger.js';
import { WorkRunReconciler } from '../src/work-run-reconciler.js';

const [stateDir, operationId] = process.argv.slice(2);
const ledger = new WorkLedger(stateDir);
const reconciler = new WorkRunReconciler(stateDir, 40, error => {
  process.send?.({type: 'reconcile-error', pid: process.pid, code: (error as {code?: string}).code});
});
let observer: NodeJS.Timeout;
const deadline = setTimeout(() => finish(2), 15_000);

function finish(code: number): void {
  clearTimeout(deadline);
  clearInterval(observer);
  reconciler.close();
  ledger.close();
  process.exitCode = code;
  process.disconnect?.();
}

reconciler.start();
observer = setInterval(() => {
  const row = ledger.db.prepare('SELECT status FROM console_operations WHERE id=?').get(operationId) as {status: string} | undefined;
  if (row?.status === 'completed') {
    process.send?.({type: 'reconciled', operationId});
    finish(0);
  }
}, 25);
process.send?.({type: 'ready', pid: process.pid});
