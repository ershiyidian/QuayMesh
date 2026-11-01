import { randomUUID } from "node:crypto";

/** Internal, parent-created evidence. It is never accepted from an HTTP caller. */
export interface CaptureReadFence { generation: string; sequence: number }
export interface CaptureReadScope { sessionId: string; memberId: string; taskId: string | null }
export interface CaptureReadObservation {
  scope: CaptureReadScope;
  generation: string;
  sequence: number;
  unchanged: boolean;
  state: "idle" | "pending" | "failed";
  error: string | null;
}

/** Tracks publication transitions, including idle -> pending -> idle between two reads. */
export class CaptureReadClock {
  private readonly generation = randomUUID();
  private sequence = 0;
  private readonly changed = new Map<string, number>();

  fence(): CaptureReadFence { return { generation: this.generation, sequence: this.sequence }; }

  touch(memberId: string, taskId?: string): void {
    if (!Number.isSafeInteger(this.sequence + 1)) throw new Error("CAPTURE_SEQUENCE_EXHAUSTED");
    this.changed.set(JSON.stringify([memberId, taskId ?? null]), ++this.sequence);
  }

  observe(scope: CaptureReadScope, before: CaptureReadFence,
    state: Pick<CaptureReadObservation, "state" | "error">): CaptureReadObservation {
    const valid = before.generation === this.generation && Number.isSafeInteger(before.sequence)
      && before.sequence >= 0 && before.sequence <= this.sequence;
    return {
      scope: { ...scope }, generation: this.generation, sequence: this.sequence,
      unchanged: valid && (this.changed.get(JSON.stringify([scope.memberId, scope.taskId])) ?? 0) <= before.sequence,
      state: state.state, error: state.error,
    };
  }
}
