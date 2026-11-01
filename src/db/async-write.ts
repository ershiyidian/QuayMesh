import { setTimeout as delay } from "node:timers/promises";
import type Database from "better-sqlite3";
import { SqliteWriteObservation, type SqliteWriteDiagnostic, type SqliteWriteDiagnosticSource,
  type SqliteWriteErrorStage, type SqliteWriteReporter } from "./write-diagnostics.js";

export interface SqliteWriteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  diagnostics?: SqliteWriteReporter;
  diagnosticSource?: SqliteWriteDiagnosticSource;
}

function failure(code:string,message:string):Error {
  return Object.assign(new Error(`${code}: ${message}`),{code});
}

function busy(error:unknown):boolean {
  const code=error && typeof error==="object" ? (error as {code?:unknown}).code : undefined;
  return typeof code==="string" && (code==="SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"));
}

function cleanupFailure(primary:unknown,errors:unknown[]):Error {
  const error=new AggregateError([primary,...errors],"SQLite 写入失败，清理连接时也发生错误。",{cause:primary});
  const code=primary && typeof primary==="object" ? (primary as {code?:unknown}).code : undefined;
  if(typeof code==="string")Object.assign(error,{code});
  return error;
}

/** 只异步等待写锁；回调必须同步、只操作数据库，不能包含外部副作用或提交后通知。 */
export async function runSqliteWrite<T>(db:Database.Database,write:()=>T,options:SqliteWriteOptions={}):Promise<T> {
  const observation=options.diagnostics ? new SqliteWriteObservation(options.diagnostics,options.diagnosticSource??"session_store") : undefined;
  let outcome:SqliteWriteDiagnostic["outcome"]="failed",errorStage:SqliteWriteErrorStage="validation",finalError:unknown;
  let cleanupFailed=false,attempts=0;
  try {
    const timeoutMs=options.timeoutMs??5000;
    if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw new RangeError("timeoutMs 必须是非负有限数值。");
    if(Object.prototype.toString.call(write)==="[object AsyncFunction]")
      throw failure("SQLITE_WRITE_ASYNC_CALLBACK","SQLite 写入回调必须同步完成。");
    const deadline=performance.now()+timeoutMs;
    let retryError:unknown,backoffMs=10;
    for(;;) {
      errorStage="validation";
      options.signal?.throwIfAborted();
      if(attempts && performance.now()>=deadline){errorStage="begin";throw retryError;}
      if(db.inTransaction)throw failure("SQLITE_WRITE_OUTER_TRANSACTION","不能在已有事务中等待写锁。");
      attempts++;
      errorStage="setup";observation?.startPhase("setup");
      const previousTimeout=db.pragma("busy_timeout",{simple:true}) as number;
      let beginAttempted=false,entered=false,failed=false,error:unknown,result!:T;
      const cleanupErrors:unknown[]=[];
      try {
        db.pragma("busy_timeout = 0");
        beginAttempted=true;
        errorStage="begin";observation?.startPhase("begin");
        db.exec("BEGIN IMMEDIATE");
        entered=true;
        errorStage="body";observation?.startPhase("body");
        result=write();
        if(result && typeof (result as {then?:unknown}).then==="function") {
          // 观察被拒绝的 Promise，避免错误的异步回调另行造成未处理拒绝。
          void Promise.resolve(result).catch(()=>{});
          throw failure("SQLITE_WRITE_ASYNC_CALLBACK","SQLite 写入回调不能返回 Promise。");
        }
        errorStage="commit";observation?.startPhase("commit");
        db.exec("COMMIT");observation?.endPhase();
      } catch(caught) {
        observation?.endPhase();
        failed=true;error=caught;
        try {if(db.inTransaction){observation?.startPhase("rollback");db.exec("ROLLBACK");}}
        catch(rollbackError) {cleanupErrors.push(rollbackError);}
        finally {observation?.endPhase();}
      } finally {
        // 每次同步尝试结束就恢复设置，等待期间不持有事务或临时连接配置。
        observation?.startPhase("restore");
        try {db.pragma(`busy_timeout = ${previousTimeout}`);} catch(restoreError) {cleanupErrors.push(restoreError);if(!failed)errorStage="restore";}
        finally {observation?.endPhase();}
      }
      if(cleanupErrors.length){cleanupFailed=true;throw cleanupFailure(failed?error:cleanupErrors[0],failed?cleanupErrors:cleanupErrors.slice(1));}
      if(!failed){outcome="committed";return result;}
      // 事务体及 COMMIT 的错误不能重放，即使错误码恰好也是 SQLITE_BUSY。
      if(!beginAttempted || entered || !busy(error))throw error;
      retryError=error;
      const remainingMs=deadline-performance.now();
      if(remainingMs<=0)throw error;
      const waitMs=Math.min(backoffMs,remainingMs);
      errorStage="retry";observation?.startRetry(waitMs);
      try {await delay(waitMs,undefined,{signal:options.signal});}
      catch(waitError) {options.signal?.throwIfAborted();throw waitError;}
      finally {observation?.endRetry();}
      backoffMs=Math.min(backoffMs*2,100);
    }
  } catch(error) {
    finalError=error;
    if(options.signal?.aborted && error===options.signal.reason)outcome="cancelled";
    throw error;
  } finally {
    // Never run a reporter inside a live transaction, including one owned by another caller.
    // The normal path has already restored busy_timeout; cleanup failures remain explicit.
    if(observation && !db.inTransaction)observation.finish(outcome,attempts,cleanupFailed,errorStage,finalError);
  }
}
