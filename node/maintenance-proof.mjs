import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";
import { readMaintenanceStatus, unresolvedSubjects, recordExecutionQuiescence, reviewableCommandClaims,
  releaseReviewedCommandClaims } from "../dist/maintenance-status.js";
import { processStartIdentity, processOwnerAlive } from "../dist/process-identity.js";

// Run with the candidate release's Node/native dependencies. Inspection never
// calls openDatabase, migrations, reconciliation or an HTTP tool endpoint.
let source = "";
for await (const chunk of process.stdin) {
  source += chunk;
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("Maintenance proof input is too large.");
}
const input = JSON.parse(source);
if (!["inspect", "record"].includes(input.action) || typeof input.stateDir !== "string")
  throw new Error("Invalid maintenance proof request.");
const stateDir = resolve(input.stateDir);
const validDigest=value=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const emit=value=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>2*1024*1024)throw new Error("Maintenance proof output is too large.");process.stdout.write(text+"\n");};
const db = new Database(join(stateDir, "core", "quaymesh.sqlite"), {
  readonly: input.action === "inspect", fileMustExist: true, timeout: 1000,
});
try {
  const databaseVersion = Number(db.prepare("SELECT max(version) FROM qm_schema_migrations").pluck().get());
  if (input.action === "inspect") {
    const result = db.transaction(() => ({ databaseVersion, admission: readMaintenanceStatus(db), subjects: unresolvedSubjects(db),
      claims: reviewableCommandClaims(db) })).deferred();
    result.processes = (input.pids ?? []).map(pid => {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process identity.");
      return { pid, start: processStartIdentity(pid), alive: processOwnerAlive({ owner_pid: pid, process_start: null }) };
    });
    emit(result);
  } else {
    if (databaseVersion < 9) throw new Error("The new Core has not applied the quiescence migration.");
    const transition = JSON.parse(await readFile(join(stateDir, "installation-transition.json"), "utf8"));
    const active = JSON.parse(await readFile(join(stateDir, "core", "active-release.json"), "utf8"));
    const evidence=input.receipt?.evidence,context=evidence?.context,stages=evidence?.stages;
    const verifiedAt=Date.parse(input.receipt?.verifiedAt),createdAt=Date.parse(context?.createdAt);
    if(input.receipt?.id!==input.attemptId||evidence?.version!==1||evidence?.boundary!=="reviewed_installation_stop_domain"||
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
} finally { db.close(); }
