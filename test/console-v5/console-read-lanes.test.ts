import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import Database from "better-sqlite3";
import type {ServerConfig} from "../../src/config.js";
import {databasePath} from "../../src/db/client.js";
import {WorkLedger} from "../../src/work-ledger.js";
import {closeConsoleReaders,readLocalOverview,readLocalOverviewUsage,readLocalSessionTitles,readLocalTaskIndex,
  readLocalUsage,withConsoleReadSignal} from "../../src/console-workbench/isolated-queries.js";

test("native analysis work cannot occupy the interactive reader; an exclusive database lock still affects both lanes",{timeout:20000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"qm-console-read-lanes-"));
  const config={stateDir:join(directory,"state"),configDir:join(directory,"config"),allowedRoots:[join(directory,"workspace")]} as ServerConfig;
  await mkdir(config.configDir);await mkdir(config.allowedRoots[0]);
  const ledger=new WorkLedger(config.stateDir),at=new Date().toISOString();
  const run=ledger.begin({root:config.allowedRoots[0],workspaceId:"lane-test",workItemId:"reader-lanes",runKey:"once",title:"Reader lanes",
    origin:{entryPoint:"qm_cli",evidence:"server_entry"}});
  ledger.db.prepare(`INSERT INTO local_agent_sessions(id,workspace_root,profile_name,provider,control_state,status,created_at,updated_at)
    VALUES('lane-agent',?,'default','codex','terminal','idle',?,?)`).run(config.allowedRoots[0],at,at);
  ledger.db.prepare(`INSERT INTO console_executions(id,run_id,agent_id,provider,status,delta,usage_quality,created_at,finished_at)
    VALUES('lane-execution',?,'lane-agent','codex','completed','{"totalTokens":7}','complete',?,?)`).run(run.id,at,at);
  ledger.db.prepare(`INSERT INTO qm_sessions(id,owner_id,title,created_at,last_activity_at)
    VALUES('lane-session','owner','Reader lanes',?,?)`).run(at,at);
  const columns=(ledger.db.prepare("PRAGMA table_info(console_executions)").all() as Array<{name:string}>).map(({name})=>
    name==="requested_model"?`(WITH RECURSIVE native_work(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM native_work WHERE n<10000000000)
      SELECT sum(n) FROM native_work) AS requested_model`:`"${name}"`);
  // The official usage query selects e.*; interactive indexes do not read this
  // column. This is real native SQLite computation on the same database, with
  // no writer lock preventing a second read process from serving interaction.
  ledger.db.exec(`ALTER TABLE console_executions RENAME TO lane_executions;
    CREATE VIEW console_executions AS SELECT rowid,${columns.join(",")} FROM lane_executions`);
  ledger.close();
  try{
    for(const [name,read] of [
      ["usage",()=>readLocalUsage(config,{days:"1"})],
      ["overview-usage",()=>readLocalOverviewUsage(config)],
      ["overview",()=>readLocalOverview(config)],
    ] as const){
      const controller=new AbortController();
      let settled=false;
      const analysis=withConsoleReadSignal(controller.signal,read).then(
        value=>{settled=true;return {value};},error=>{settled=true;return {error};});
      try{
        await delay(300);
        const [index,titles]=await Promise.all([readLocalTaskIndex(config),readLocalSessionTitles(config)]);
        assert.equal(index.items[0]?.localId,run.id);
        assert.equal(titles.items.length,1);
        assert.equal(settled,false,`${name} must still be computing while interactive reads finish`);
        controller.abort();
        const outcome=await analysis;
        assert.ok("error" in outcome);assert.equal(outcome.error.code,"console_read_aborted");
      }finally{controller.abort();await analysis;}
    }
    const restore=new Database(databasePath(config.stateDir));
    restore.exec("DROP VIEW console_executions; ALTER TABLE lane_executions RENAME TO console_executions");restore.close();
    assert.equal((await readLocalOverviewUsage(config)).todayUsage.records,1,"analysis works again after cancelling its native query");

    // Two bounded readers do not bypass SQLite's database-wide exclusion.
    const lock=new Database(databasePath(config.stateDir));
    lock.pragma("locking_mode = EXCLUSIVE");lock.exec("BEGIN EXCLUSIVE");
    try{
      const outcomes=await Promise.allSettled([readLocalOverviewUsage(config),readLocalTaskIndex(config)]);
      for(const outcome of outcomes){assert.equal(outcome.status,"rejected");
        if(outcome.status==="rejected")assert.equal(outcome.reason.code,"console_read_failed");}
    }finally{lock.exec("ROLLBACK");lock.close();}
    const [usage,index]=await Promise.all([readLocalOverviewUsage(config),readLocalTaskIndex(config)]);
    assert.equal(usage.todayUsage.records,1);assert.equal(index.items[0]?.localId,run.id);
  }finally{closeConsoleReaders();await delay(50);await rm(directory,{recursive:true,force:true});}
});
