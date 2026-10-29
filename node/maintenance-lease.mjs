import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { requestJson } from "./network.mjs";
import { writeJson, readOptionalJson } from "./files.mjs";
import { restrictedEnvironment } from "./environment.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const subjectIdentities = rows => rows.map(({domain,id,generation,fingerprint}) => [domain,id,generation,fingerprint])
  .sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
const sameSubjects = (left, right) => JSON.stringify(subjectIdentities(left)) === JSON.stringify(subjectIdentities(right));
const claimIdentities = rows => rows.map(({id,operationId,ownerId,ownerPid,processStart,generation,fingerprint}) =>
  [id,operationId,ownerId,ownerPid,processStart,generation,fingerprint]).sort((a,b)=>a[0].localeCompare(b[0]));
const sameClaims = (left,right) => JSON.stringify(claimIdentities(left)) === JSON.stringify(claimIdentities(right));

export function runMaintenanceProof(manifest, request, timeoutMs = 10000) {
  return new Promise((resolveProof, reject) => {
    const child = spawn(manifest.nodeExecutable, [join(manifest.directory, "node", "maintenance-proof.mjs")], {
      stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, env: restrictedEnvironment(process.env),
    });
    let output = "", stderr = "", failure;
    // A timeout is not completion. Resolve/reject only after the real child
    // exited, so a late backup/proof writer cannot outlive a failed gate.
    let force;
    const timer = setTimeout(() => {
      failure = new Error("Maintenance proof process timed out."); child.kill();
      force=setTimeout(()=>child.kill("SIGKILL"),1000);
    }, timeoutMs);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 2 * 1024 * 1024) { failure = new Error("Maintenance proof output exceeded its bound."); child.kill(); } });
    child.stderr.on("data", chunk => { if (stderr.length < 16000) stderr += chunk; });
    child.stdin.on("error", error => { failure ??= error; });
    child.once("error", error => { failure ??= error; });
    child.once("close", code => {
      clearTimeout(timer);
      clearTimeout(force);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`Maintenance proof failed (${code}): ${stderr}`)); return; }
      try { resolveProof(JSON.parse(output)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function census(value) {
  if (!value || !validDigest(value.digest) || !Number.isFinite(Date.parse(value.observedAt)) ||
      Date.now() - Date.parse(value.observedAt) > 10000 || Date.parse(value.observedAt) - Date.now() > 1000)
    throw new Error("The external physical census is missing or stale.");
  return { digest: value.digest, observedAt: value.observedAt };
}
function subjects(value) {
  if (!Array.isArray(value) || value.some(row => !["operation", "execution"].includes(row.domain) ||
      typeof row.id !== "string" || !row.id || typeof row.generation !== "string" || !row.generation || !validDigest(row.fingerprint)) ||
      new Set(value.map(row => row.domain+":"+row.id)).size !== value.length)
    throw new Error("Invalid physical quiescence subject identities.");
  return value;
}
function reviewedClaims(value=[]) {
  if (!Array.isArray(value) || value.some(row => !row ||
      [row.id,row.operationId,row.ownerId,row.processStart,row.generation].some(value=>typeof value!=="string"||!value) ||
      !Number.isSafeInteger(row.ownerPid) || row.ownerPid<1 || !validDigest(row.fingerprint)) ||
      new Set(value.map(row=>row.id)).size!==value.length)
    throw new Error("Invalid reviewed command claim identities.");
  return value;
}
function activeCounts(status,claims) {
  const names = ["claims","waiting","operations","executions","queuedOperations","queuedExecutions","activeWork","allRuntimeWork","persistedRuntimeWork"];
  if (!status || names.some(name => !Number.isSafeInteger(status[name]) || status[name] < 0))
    throw new Error("Maintenance activity counters are unavailable.");
  return status.claims!==claims.length || names.some(name=>name!=="claims"&&status[name]>0);
}

export async function beginInstallationMaintenance(options) {
  if (options.provider) return acquireInstallationLease(options);
  // The default is deliberately unchanged. A rejected normal drain never
  // selects the external protocol or gets converted into an idle result.
  await requestJson(`http://127.0.0.1:${options.previous.adminPort}/maintenance/begin`, {
    method:"POST",token:options.token,timeoutMs:35000,
  });
  return null;
}

/** An explicit lease is a reviewed protocol, not a force flag or a fallback
 * after a rejected normal maintenance request. Its callbacks close every
 * relevant entry point and prove the complete physical stop domain. */
export async function acquireInstallationLease({ provider, manifest, manifestFile, previous, running, token, corePort,
  proof = runMaintenanceProof }) {
  if (!provider || ["acquire","assertHeld","release"].some(name => typeof provider[name] !== "function"))
    throw new Error("External maintenance requires acquire/assertHeld/release callbacks.");
  if (running.maintenance || running.installationTransition) throw new Error("Another maintenance operation already owns this node.");
  const health = await requestJson(`http://127.0.0.1:${previous.adminPort}/healthz`, { timeoutMs: 2500 });
  const core = running.components?.find(value => value.id === "core");
  if (!Number.isSafeInteger(health.pid) || health.pid < 1 || !core?.pid) throw new Error("Previous service identity is unavailable.");
  const baseline = await proof(manifest, { action: "inspect", stateDir: manifest.stateDir, pids: [health.pid, core.pid] });
  if (baseline.admission.accepting !== true) throw new Error("Core admission is already owned by another pause.");
  const managerIdentity = baseline.processes.find(value => value.pid === health.pid);
  const coreIdentity = baseline.processes.find(value => value.pid === core.pid);
  if (![managerIdentity,coreIdentity].every(value => value?.alive && value.start)) throw new Error("Previous process generations cannot be verified.");
  const attemptId = randomUUID();
  const context = Object.freeze({ version: 1, attemptId, nodeId: manifest.nodeId, stateDir: resolve(manifest.stateDir),
    configFile: manifest.config, manifestFile: resolve(manifestFile), manifestSha256: hash(await readFile(manifestFile)),
    oldCommit: previous.sourceCommit, targetCommit: manifest.sourceCommit, adminPort: previous.adminPort, corePort,
    createdAt: new Date().toISOString(), transitionFile: join(manifest.stateDir,"installation-transition.json"),
    receiptFile: join(dirname(resolve(manifestFile)),`maintenance-${attemptId}.json`),
    manager: {pid:managerIdentity.pid,start:managerIdentity.start}, core:{pid:coreIdentity.pid,start:coreIdentity.start},
    components: running.components.map(({id,pid,startedAt,restarts})=>({id,pid,startedAt,restarts})),
  });
  const receipt = { version: 1, context, phase: "acquiring", stages: [] };
  await writeJson(context.receiptFile, receipt);
  let lease;
  try {
    lease = await provider.acquire(context);
    if (lease?.version !== 1 || lease.attemptId !== attemptId || lease.pause?.reason !== `release-preflight:${attemptId}` ||
        !Number.isFinite(Date.parse(lease.pause?.changedAt))) throw new Error("External maintenance ownership does not match this attempt.");
    census(lease.census); subjects(lease.subjects); reviewedClaims(lease.claims);
    if (!sameSubjects(lease.subjects, baseline.subjects)) throw new Error("The reviewed historical subjects changed during acquisition.");
    if (baseline.admission.claims!==(lease.claims??[]).length || !sameClaims(lease.claims??[],reviewedClaims(baseline.claims)) ||
        (lease.claims??[]).some(claim=>!lease.subjects.some(subject=>subject.domain==="operation"&&subject.id===claim.operationId&&subject.generation===claim.generation)))
      throw new Error("The complete command claim set was not reviewed or changed during acquisition.");
    receipt.lease = lease; receipt.phase = "acquired";
    await writeJson(context.receiptFile, receipt);
  } catch (error) {
    // acquire owns its uncertain-result compensation. Never resume a pause
    // based merely on a thrown error or an unconfirmed lease object.
    receipt.phase = "acquisition_unconfirmed"; receipt.error = String(error);
    if (lease?.attemptId===attemptId && lease.pause?.reason===`release-preflight:${attemptId}`) {
      try {
        await provider.release(lease,{outcome:"aborted-before-stop",transition:null,activeStatus:running},context);
        if(await readOptionalJson(context.transitionFile))throw new Error("Installation transition remains after acquisition release.");
        const admission=await requestJson(`http://127.0.0.1:${corePort}/internal/quaymesh/idle`,{token,timeoutMs:3000});
        if(admission.accepting!==true)throw new Error("Acquisition release has not restored admission.");
        receipt.phase="acquisition_released";
      } catch (recovery) { receipt.releaseError=String(recovery); }
    }
    await writeJson(context.receiptFile, receipt);
    throw new Error(`External maintenance acquisition is unconfirmed; inspect ${context.receiptFile}.`, { cause: error });
  }
  const assertHeld = async stage => {
    const check = await provider.assertHeld(lease, stage, context);
    const observed = census(check?.census);
    const snapshot = await proof(manifest, { action: "inspect", stateDir: manifest.stateDir,
      pids: [context.manager.pid,context.core.pid] });
    if (activeCounts(snapshot.admission,lease.claims??[]) || snapshot.admission.accepting ||
        !sameSubjects(lease.subjects, snapshot.subjects) || !sameClaims(lease.claims??[],reviewedClaims(snapshot.claims)))
      throw new Error(`Maintenance state changed at ${stage}.`);
    if (stage === "after_stop") {
      for (const expected of [context.manager,context.core]) {
        const actual = snapshot.processes.find(value=>value.pid===expected.pid);
        if (actual?.alive && (actual.start === expected.start || !actual.start)) throw new Error("Previous process generation is still present or unknown.");
      }
    } else {
      if (snapshot.admission.reason !== lease.pause.reason || snapshot.admission.changedAt !== lease.pause.changedAt)
        throw new Error("External maintenance pause ownership changed.");
      for (const expected of [context.manager,context.core]) {
        const actual = snapshot.processes.find(value=>value.pid===expected.pid);
        if (!actual?.alive || actual.start !== expected.start) throw new Error("Previous process generation changed while draining.");
      }
      const status = await requestJson(`http://127.0.0.1:${context.adminPort}/status`, { timeoutMs:2500 });
      if (status.nodeId !== context.nodeId || status.release !== context.oldCommit ||
          JSON.stringify(status.components.map(({id,pid,startedAt,restarts})=>({id,pid,startedAt,restarts}))) !== JSON.stringify(context.components))
        throw new Error("Manager/Core component identity changed while draining.");
    }
    receipt.stages.push({stage,at:new Date().toISOString(),census:observed}); receipt.phase=stage;
    await writeJson(context.receiptFile,receipt);
    return observed;
  };
  const release = async reason => {
    receipt.phase = "releasing"; receipt.release = {outcome:reason.outcome,at:new Date().toISOString()};
    await writeJson(context.receiptFile,receipt);
    try {
      await provider.release(lease,reason,context);
      if (await readOptionalJson(context.transitionFile)) throw new Error("Owned installation transition has not been released.");
      const admission = await requestJson(`http://127.0.0.1:${corePort}/internal/quaymesh/idle`, {token,timeoutMs:3000});
      if (admission.accepting !== true) throw new Error("Admission release has not been confirmed.");
      receipt.phase = "released"; await writeJson(context.receiptFile,receipt);
    } catch (error) {
      receipt.phase="release_unconfirmed";receipt.error=String(error);await writeJson(context.receiptFile,receipt);
      throw new Error(`Maintenance release remains unconfirmed; inspect ${context.receiptFile}.`, {cause:error});
    }
  };
  return {context,lease,assertHeld,release,receipt};
}
