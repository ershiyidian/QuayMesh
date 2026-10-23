import type Database from "better-sqlite3";

export interface AdmissionState {
  accepting: boolean;
  reason: string | null;
  changedAt: string;
}

export interface CoreAdmissionInstance {
  pid: number;
  processStart: string | null;
  token: string;
}

export interface AdmissionPrecondition extends AdmissionState {
  instance: CoreAdmissionInstance;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A present but malformed condition must never fall back to the legacy API. */
export function isAdmissionPrecondition(value: unknown): value is AdmissionPrecondition {
  if (!object(value) || !object(value.instance)) return false;
  const instance = value.instance;
  return typeof value.accepting === "boolean"
    && (value.reason === null || typeof value.reason === "string")
    && typeof value.changedAt === "string" && value.changedAt.length > 0
    && Number.isSafeInteger(instance.pid) && (instance.pid as number) > 0
    && (instance.processStart === null || (typeof instance.processStart === "string" && instance.processStart.length > 0))
    && typeof instance.token === "string" && instance.token.length > 0;
}

export function sameAdmissionInstance(left: CoreAdmissionInstance, right: CoreAdmissionInstance): boolean {
  return left.pid === right.pid && left.processStart === right.processStart && left.token === right.token;
}

export function readAdmissionState(db: Database.Database): AdmissionState {
  const row = db.prepare("SELECT accepting,reason,changed_at FROM qm_runtime_admission WHERE id=1")
    .get() as { accepting: number; reason: string | null; changed_at: string } | undefined;
  if (!row || ![0, 1].includes(row.accepting) || typeof row.changed_at !== "string"
      || (row.reason !== null && typeof row.reason !== "string")) {
    throw new Error("Runtime admission state is missing or invalid.");
  }
  return { accepting: row.accepting === 1, reason: row.reason, changedAt: row.changed_at };
}

export type AdmissionChange = { changed: boolean; state: AdmissionState };

/** Compare and update under one write lock, including callers in an outer transaction. */
export function changeAdmission(
  db: Database.Database,
  next: Pick<AdmissionState, "accepting" | "reason">,
  expected?: AdmissionState,
): AdmissionChange {
  return db.transaction(() => {
    const current = readAdmissionState(db);
    if (expected && (current.accepting !== expected.accepting || current.reason !== expected.reason
        || current.changedAt !== expected.changedAt)) return { changed: false, state: current };
    const previous = Date.parse(current.changedAt);
    // All writers, including the legacy API, advance this ownership version.
    // Repeated equal pauses and a backwards clock must not create an ABA match.
    const changedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    const state: AdmissionState = { accepting: next.accepting, reason: next.accepting ? null : next.reason, changedAt };
    db.prepare("UPDATE qm_runtime_admission SET accepting=?,reason=?,changed_at=? WHERE id=1")
      .run(state.accepting ? 1 : 0, state.reason, state.changedAt);
    return { changed: true, state };
  }).immediate();
}
