import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

// A bounded control operation for a legacy launcher whose root exited while
// its emulator still owns stdout. This never deletes/steals execution claims.
export interface EmulatorRecoveryProof {
  workspaceId: string; runId: string; claimId: string;
  pid: number; createdAt: string; serial: string; avd: string; sdk: string;
}
interface Identity { pid: number; name: string; createdAt: string; executable: string; matchesAvd: boolean }
export function validateEmulatorIdentity(proof: EmulatorRecoveryProof, identity: Identity, acquiredAt: string): void {
  if (!Number.isInteger(proof.pid) || proof.pid < 1 || !/^emulator-\d{4,5}$/.test(proof.serial) || !/^[A-Za-z0-9_.-]+$/.test(proof.avd)) throw new Error("Invalid recovery identity");
  const acquired = Date.parse(acquiredAt), expected = Date.parse(proof.createdAt), observed = Date.parse(identity.createdAt);
  if (![acquired, expected, observed].every(Number.isFinite) || expected !== observed || expected < acquired || expected - acquired > 5000) throw new Error("Process creation does not match the original launch receipt");
  if (identity.pid !== proof.pid || identity.name.toLowerCase() !== "emulator.exe" || !identity.matchesAvd) throw new Error("Not the recorded emulator process");
  if (resolve(identity.executable).toLowerCase() !== resolve(proof.sdk, "emulator/emulator.exe").toLowerCase()) throw new Error("SDK executable identity mismatch");
}
function inspect(proof: EmulatorRecoveryProof): Identity | null {
  // PID and AVD are validated before interpolation; no credentials/argv output.
  if (!Number.isInteger(proof.pid) || proof.pid < 1 || !/^[A-Za-z0-9_.-]+$/.test(proof.avd)) throw new Error("Invalid identity");
  const code = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${proof.pid}'; if($p){$args=$p.CommandLine -split '\\s+'; [pscustomobject]@{pid=$p.ProcessId;name=$p.Name;createdAt=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;matchesAvd=($args -contains '@${proof.avd}' -or $args -contains '${proof.avd}')}|ConvertTo-Json -Compress}`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
  return output ? JSON.parse(output) as Identity : null;
}
function scopedClaim(stateDir: string, proof: EmulatorRecoveryProof) {
  const db = new Database(join(stateDir, "quaymesh.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare("select r.workspace_id,r.status,p.root from console_work_runs r join console_projects p on p.id=r.project_id where r.id=?").get(proof.runId) as {workspace_id:string;status:string;root:string}|undefined;
    const claim = db.prepare("select checkout_root,kind,resources,acquired_at,owner_pid from execution_claims where id=?").get(proof.claimId) as {checkout_root:string;kind:string;resources:string;acquired_at:string;owner_pid:number}|undefined;
    if (!run || run.workspace_id !== proof.workspaceId || run.status !== "running" || !claim || claim.kind !== "command" || claim.checkout_root !== run.root) throw new Error("Run/workspace/command claim mismatch");
    if (!JSON.parse(claim.resources).includes("android-emulator-voice-memory")) throw new Error("Not an emulator resource lease");
    const operations = db.prepare("select created_at from console_operations where run_id=? and kind='command' and status='running'").all(proof.runId) as {created_at:string}[];
    if (operations.length !== 1 || Math.abs(Date.parse(operations[0]!.created_at) - Date.parse(claim.acquired_at)) > 1000) throw new Error("Ambiguous command ownership");
    process.kill(claim.owner_pid, 0); // The live manager, not this recovery CLI, releases its claim.
    return claim;
  } finally { db.close(); }
}
export async function recoverEmulator(stateDir: string, proof: EmulatorRecoveryProof, apply: boolean) {
  if (process.platform !== "win32") throw new Error("This compatibility recovery targets Windows launchers only");
  const claim = scopedClaim(stateDir, proof);
  const before = inspect(proof);
  if (!before) throw new Error("Recorded process is absent; do not infer safe claim release");
  validateEmulatorIdentity(proof, before, claim.acquired_at);
  const adb = resolve(proof.sdk, "platform-tools/adb.exe");
  const avd = execFileSync(adb, ["-s", proof.serial, "emu", "avd", "name"], {encoding:"utf8",windowsHide:true,timeout:10000}).split(/[\r\n]+/).map(line=>line.trim()).find(Boolean);
  if (avd !== proof.avd) throw new Error("ADB device does not match recorded AVD");
  const evidence: Record<string, unknown> = { workspaceId:proof.workspaceId,runId:proof.runId,claimId:proof.claimId,serial:proof.serial,avd:proof.avd,pid:proof.pid,createdAt:before.createdAt,action:apply?"stop-owned-emulator":"dry-run",claimManuallyReleased:false };
  if (apply) {
    const recheck = inspect(proof);
    if (!recheck) throw new Error("Process changed before control");
    validateEmulatorIdentity(proof, recheck, scopedClaim(stateDir,proof).acquired_at);
    execFileSync(adb, ["-s",proof.serial,"emu","kill"], {encoding:"utf8",windowsHide:true,timeout:15000});
    for (let i=0;i<20 && inspect(proof);i++) await new Promise(r=>setTimeout(r,500));
    evidence.processExited = inspect(proof) === null;
    if (!evidence.processExited) throw new Error("Emulator stop requested; exit not verified, original claim retained");
  }
  const directory=join(stateDir,"process-recovery"); mkdirSync(directory,{recursive:true,mode:0o700});
  const receiptPath=join(directory,`${randomUUID()}.json`);
  writeFileSync(receiptPath,JSON.stringify(evidence,null,2),{encoding:"utf8",flag:"wx",mode:0o600});
  return {...evidence,receiptPath};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [raw, flag] = process.argv.slice(2);
  if (!raw || (flag && flag !== "--apply")) throw new Error("Usage: emulator-session-recovery <JSON proof> [--apply]");
  const stateDir=process.env.QUAYMESH_STATE_DIR ?? join(homedir(),".local/share/quaymesh");
  recoverEmulator(stateDir,JSON.parse(raw) as EmulatorRecoveryProof,flag==="--apply").then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e instanceof Error?e.message:"Recovery failed");process.exitCode=1;});
}
