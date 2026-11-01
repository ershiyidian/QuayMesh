import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import { readMaintenanceStatus, unresolvedSubjects, recordExecutionQuiescence, reviewableCommandClaims,
  releaseReviewedCommandClaims, retainableCommandClaims } from "../dist/maintenance-status.js";
import { processStartIdentity, processOwnerAlive } from "../dist/process-identity.js";
import { installationHistoryPolicy, assertRetainedHistory } from "./maintenance-history.mjs";

// Run with the candidate release's Node/native dependencies. Inspection never
// calls openDatabase, migrations, reconciliation or an HTTP tool endpoint.
let source = "";
for await (const chunk of process.stdin) {
  source += chunk;
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("Maintenance proof input is too large.");
}
const input = JSON.parse(source);
if (!["inspect", "record", "verify-retained"].includes(input.action) || typeof input.stateDir !== "string")
  throw new Error("Invalid maintenance proof request.");
const stateDir = resolve(input.stateDir);
const historyPolicy = installationHistoryPolicy(input.historyPolicy);
const preserving = historyPolicy === "preserve";
if (input.action === "record" && preserving || input.action === "verify-retained" && !preserving)
  throw new Error("Physical proof and preserved history are separate installation policies.");
const validDigest=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const emit=value=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>2*1024*1024)throw new Error("Maintenance proof output is too large.");process.stdout.write(text+"\n");};
const db = new Database(join(stateDir, "core", "quaymesh.sqlite"), {
  readonly: input.action !== "record", fileMustExist: true, timeout: 1000,
});
try {
  if (input.action !== "record") db.pragma("query_only = ON");
  const databaseVersion = Number(db.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get());
  const snapshot = () => ({ databaseVersion, admission: readMaintenanceStatus(db), subjects: unresolvedSubjects(db),
    claims: preserving ? retainableCommandClaims(db) : reviewableCommandClaims(db),
    ...(preserving ? {historyPolicy,protocolVersion:2,claimFingerprintVersion:2} : {}) });
  if (input.action === "inspect") {
    const result = db.transaction(snapshot).deferred();
    result.processes = (input.pids ?? []).map(pid => {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process identity.");
      return { pid, start: processStartIdentity(pid), alive: processOwnerAlive({ owner_pid: pid, process_start: null }) };
    });
    emit(result);
  } else {
    if (databaseVersion < 9) throw new Error("The new Core has not applied the quiescence migration.");
    const transition = JSON.parse(await readFile(join(stateDir, "installation-transition.json"), "utf8"));
    const active = JSON.parse(await readFile(join(stateDir, "core", "active-release.json"), "utf8"));
    const review=preserving?input.review:input.receipt;
    const evidence=review?.evidence,context=evidence?.context,stages=evidence?.stages;
    const verifiedAt=Date.parse(review?.verifiedAt),createdAt=Date.parse(context?.createdAt);
    if (installationHistoryPolicy(context?.historyPolicy) !== historyPolicy ||
        installationHistoryPolicy(transition.maintenanceLease?.historyPolicy) !== historyPolicy ||
        preserving && (context?.version !== 2 || transition.maintenanceLease?.version !== 2))
      throw new Error("Installation history policy is not bound to this transition.");
    if(review?.id!==input.attemptId||evidence?.version!==(preserving?2:1)||
        evidence?.boundary!==(preserving?"reviewed_installation_service_stop_domain":"reviewed_installation_stop_domain")||
        context?.attemptId!==input.attemptId||context?.stateDir!==stateDir||context?.targetCommit!==input.targetCommit||
        context?.oldCommit!==transition.previousCommit||context?.transitionFile!==join(stateDir,"installation-transition.json")||
        !validDigest(context?.manifestSha256)||context.manifestSha256!==transition.maintenanceLease?.manifestSha256||
        !Number.isFinite(createdAt)||!Number.isFinite(verifiedAt)||Date.now()-verifiedAt>10000||verifiedAt-Date.now()>1000||
        !Array.isArray(stages)||stages.map(value=>value.stage).join(",")!=="before_backup,after_backup,before_stop,after_stop")
      throw new Error("Physical receipt is missing its installation identity or complete drain protocol.");
    let previousAt=createdAt;
    for(const stage of stages){
      const at=Date.parse(stage.at),observedAt=Date.parse(stage.census?.observedAt);
      if(!Number.isFinite(at)||at<previousAt||at>verifiedAt||!validDigest(stage.census?.digest)||
          !Number.isFinite(observedAt)||at-observedAt>10000||observedAt-at>1000)
        throw new Error("Physical receipt stages are out of order or have stale census evidence.");
      previousAt=at;
    }
    if(createHash("sha256").update(await readFile(context.manifestFile)).digest("hex")!==context.manifestSha256)
      throw new Error("Prepared installation identity changed after physical review.");
    if (!input.attemptId || transition.id !== input.attemptId || transition.maintenanceLease?.attemptId !== input.attemptId ||
        transition.sourceCommit !== input.targetCommit || active.commit !== input.targetCommit || active.pid !== input.core?.pid ||
        !input.core?.start || processStartIdentity(input.core.pid) !== input.core.start)
      throw new Error("Physical receipt does not belong to this paused installation generation.");
    if (!Array.isArray(input.previousProcesses) || input.previousProcesses.length !== 2 ||
        input.previousProcesses.some((value,index) => {
          const expected=index===0?context.manager:context.core;
          return !Number.isSafeInteger(value.pid)||value.pid<1||!value.start||value.pid!==expected?.pid||value.start!==expected?.start||
            processOwnerAlive({ owner_pid: value.pid, process_start: value.start });
        }))
      throw new Error("A previous manager or Core generation has not been proven stopped.");
    const claims=input.claims??[];
    if(!Array.isArray(claims))throw new Error("Invalid reviewed command claim identities.");
    if (preserving) {
      // Read-only across migration and restart: retain every original attempt,
      // owner, claim and uncertainty counter. This writes no physical receipt.
      const retained=db.transaction(() => {
        const observed=snapshot();
        assertRetainedHistory(observed,context.retainedHistory);
        assertRetainedHistory(observed,transition.maintenanceLease.retainedHistory);
        // The caller must also carry the exact complete input identities.
        assertRetainedHistory({...observed,subjects:input.subjects,claims},context.retainedHistory);
        return observed;
      }).deferred();
      emit({verifiedRetained:true,recorded:0,released:0,retainedSubjects:retained.subjects.length,
        retainedClaims:retained.claims.length,databaseVersion,admission:retained.admission});
    } else {
    const released=db.transaction(() => {
      const status = readMaintenanceStatus(db);
      if (status.accepting || status.waiting + status.operations + status.executions +
          status.queuedOperations + status.queuedExecutions + status.activeWork > 0 ||
          db.prepare("SELECT 1 FROM qm_runtime_work LIMIT 1").get())
        throw new Error("New Core is not paused and physically drained for the receipt transaction.");
      recordExecutionQuiescence(db, input.subjects, input.receipt);
      return releaseReviewedCommandClaims(db,claims,input.receipt.id);
    }).immediate();
    emit({ recorded: input.subjects.length, ...released, databaseVersion,admission: readMaintenanceStatus(db) });
    }
  }
} finally { db.close(); }
