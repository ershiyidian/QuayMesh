import { snapshotSchema } from "../../session/schema.js";
import {
  ExecutionState,
  HostState,
  ReviewState,
  type Snapshot,
} from "../../session/types.js";

const readerSchema = snapshotSchema.strip();

export function snapshotFromSchema(value: unknown): Snapshot {
  const parsed = readerSchema.parse(value);
  return {
    ...parsed,
    execution_status: executionState(parsed.execution_status),
    review_status: reviewState(parsed.review_status),
    host_status: hostState(parsed.host_status),
  };
}

function executionState(value: "active" | "idle" | "interrupted" | "failed"): ExecutionState {
  switch (value) {
    case "active": return ExecutionState.active;
    case "idle": return ExecutionState.idle;
    case "interrupted": return ExecutionState.interrupted;
    case "failed": return ExecutionState.failed;
  }
}

function reviewState(value: "unknown" | "needs_review" | "passed" | "failed" | "not_applicable"): ReviewState {
  switch (value) {
    case "unknown": return ReviewState.unknown;
    case "needs_review": return ReviewState.needs_review;
    case "passed": return ReviewState.passed;
    case "failed": return ReviewState.failed;
    case "not_applicable": return ReviewState.not_applicable;
  }
}

function hostState(value: "connected" | "disconnected" | "unknown"): HostState {
  switch (value) {
    case "connected": return HostState.connected;
    case "disconnected": return HostState.disconnected;
    case "unknown": return HostState.unknown;
  }
}
