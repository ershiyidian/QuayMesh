import { WorkLedger } from "./work-ledger.js";

// 启动时核对上个进程留下的执行；周期核对只回收已失效状态，避免中断当前工作。
export class WorkRunReconciler {
  private timer?: NodeJS.Timeout;
  private ledger?: WorkLedger;

  constructor(
    private readonly stateDir: string,
    private readonly intervalMs = 60_000,
    private readonly onError: (error: unknown) => void = error => {
      console.error("QuayMesh 执行账本核对失败，将在下一周期重试", error);
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.ledger = new WorkLedger(this.stateDir);
    this.startup();
    this.timer = setInterval(() => {
      try { this.tick(); }
      catch (error) {
        // 待核对状态保留在账本中，下一周期重试；后台写锁冲突不终止正在执行的 Core。
        try { this.onError(error); } catch { /* 诊断失败也保留下一周期的重试。 */ }
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  startup(): void {
    const ledger = this.ledger ?? new WorkLedger(this.stateDir);
    this.ledger = ledger;
    ledger.reconcileTerminalOperations();
    ledger.reconcileInterruptedExecutions();
    ledger.reconcileOrphanedOperations();
    ledger.reconcileDeadExecutionClaims();
    ledger.reconcileStaleRuns();
    ledger.reconcileArchivedTaskRuns();
  }

  tick(): void {
    const ledger = this.ledger ?? new WorkLedger(this.stateDir);
    this.ledger = ledger;
    ledger.reconcileTerminalOperations();
    ledger.reconcileDeadExecutionClaims();
    ledger.reconcileStaleRuns();
    ledger.reconcileArchivedTaskRuns();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ledger?.close();
    this.ledger = undefined;
  }
}
