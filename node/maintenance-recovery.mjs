/** Retry only the idempotent resume action. Never retry a maintenance begin. */
export async function resumeAdmissionWithRetry(resume, {
  attempts = 4, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  let failure;
  for (let index = 0; index < attempts; index++) {
    try { return await resume(); }
    catch (error) {
      failure = error;
      if (index + 1 < attempts) await sleep(Math.min(1000, 200 * (index + 1)));
    }
  }
  throw failure;
}

/**
 * A newly booted authoritative node may inherit the Core's durable
 * node-maintenance admission marker from its predecessor. Do not touch
 * unrelated user/runtime shutdown pauses, or an active maintenance owner.
 */
export async function reconcileAbandonedMaintenance(readAdmission, resume) {
  const admission = await readAdmission();
  if (admission?.accepting !== false || admission?.reason !== "node-maintenance") return false;
  await resumeAdmissionWithRetry(resume);
  return true;
}
