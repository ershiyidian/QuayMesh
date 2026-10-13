import { WorkLedger } from "./work-ledger.js";

/**
 * Startup marks in-flight executions/operations reconciliation_required because this process
 * did not start them and must not replay them. The interval only releases dead claims and
 * expires leases. Repeating the startup sweep would interrupt a command that is still running.
 */
export class WorkRunReconciler {
  private timer?: NodeJS.Timeout;
  private ledger?: WorkLedger;

  constructor(private readonly stateDir: string, private readonly intervalMs = 60_000) {}

  start(): void {
    if (this.timer) return;
    this.ledger = new WorkLedger(this.stateDir);
    this.startup();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  startup(): void {
    const ledger = this.ledger ?? new WorkLedger(this.stateDir);
    this.ledger = ledger;
    ledger.reconcileInterruptedExecutions();
    ledger.reconcileOrphanedOperations();
    ledger.reconcileDeadExecutionClaims();
    ledger.reconcileStaleRuns();
  }

  tick(): void {
    const ledger = this.ledger ?? new WorkLedger(this.stateDir);
    this.ledger = ledger;
    ledger.reconcileDeadExecutionClaims();
    ledger.reconcileStaleRuns();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ledger?.close();
    this.ledger = undefined;
  }
}
