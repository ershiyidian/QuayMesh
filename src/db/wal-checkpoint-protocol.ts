/** Only maintenance metadata crosses the worker boundary; no SQL or row data. */
export interface WalCheckpointSnapshot {
  busy: number;
  log: number;
  checkpointed: number;
}

export type WalCheckpointMessage =
  | { type: "ready"; snapshot: WalCheckpointSnapshot }
  | { type: "sample"; snapshot: WalCheckpointSnapshot; checkpoint: boolean; elapsedMs: number }
  | { type: "failed"; code: string }
  | { type: "closed" };

export const WAL_CHECKPOINT_POLL_MS = 250;
export const WAL_CHECKPOINT_MAX_DELAY_MS = 1_000;
export const WAL_CHECKPOINT_TARGET_PAGES = 1_000;
export const WAL_CHECKPOINT_GUARD_PAGES = 4_096;
export const WAL_CHECKPOINT_WATCHDOG_MS = 5_000;
