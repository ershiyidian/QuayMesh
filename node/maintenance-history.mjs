import { createHash } from "node:crypto";

export function installationHistoryPolicy(value = "prove") {
  if (value !== "prove" && value !== "preserve") throw new Error("Invalid installation history policy.");
  return value;
}

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const subjectIdentities = rows => rows.map(({domain,id,generation,fingerprint}) => [domain,id,generation,fingerprint])
  .sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
export const claimIdentities = rows => rows.map(({id,operationId,ownerId,ownerPid,processStart,generation,fingerprint}) =>
  [id,operationId,ownerId,ownerPid,processStart,generation,fingerprint]).sort((a,b) => a[0].localeCompare(b[0]));
export const sameSubjects = (left,right) => JSON.stringify(subjectIdentities(left)) === JSON.stringify(subjectIdentities(right));
export const sameClaims = (left,right) => JSON.stringify(claimIdentities(left)) === JSON.stringify(claimIdentities(right));

const historyCounters = ["unresolvedOperations","unresolvedExecutions","physicalUnknown","reconciledPhysicalBoundaries"];
const workCounters = ["waiting","operations","executions","queuedOperations","queuedExecutions","activeWork","allRuntimeWork","persistedRuntimeWork"];

/** The installer pins the complete historical identity set before acquiring a
 * pause. This is an integrity commitment, never evidence that work has stopped. */
export function retainedHistoryIdentity(snapshot) {
  if (snapshot?.historyPolicy !== "preserve" || snapshot.protocolVersion !== 2 || snapshot.claimFingerprintVersion !== 2 ||
      !Array.isArray(snapshot.subjects) || !Array.isArray(snapshot.claims) ||
      historyCounters.some(name => !Number.isSafeInteger(snapshot.admission?.[name]) || snapshot.admission[name] < 0))
    throw new Error("Preserved history requires the explicit version 2 inspection contract.");
  return Object.freeze({subjectDigest:digest(subjectIdentities(snapshot.subjects)),claimDigest:digest(claimIdentities(snapshot.claims)),
    counters:Object.freeze(Object.fromEntries(historyCounters.map(name => [name,snapshot.admission[name]])))});
}

export function assertRetainedHistory(snapshot, expected) {
  const observed = retainedHistoryIdentity(snapshot);
  if (!expected || observed.subjectDigest !== expected.subjectDigest || observed.claimDigest !== expected.claimDigest ||
      historyCounters.some(name => observed.counters[name] !== expected.counters?.[name]))
    throw new Error("Preserved historical identities or physical uncertainty changed during installation.");
  const status = snapshot.admission;
  if (status.accepting !== false || !Number.isSafeInteger(status.claims) || status.claims !== snapshot.claims.length ||
      workCounters.some(name => !Number.isSafeInteger(status[name]) || status[name] !== 0))
    throw new Error("Preserved history requires paused admission and no current service work.");
  return observed;
}
