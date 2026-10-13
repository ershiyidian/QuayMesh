import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {ExecutionCoordinator} from "../src/execution-coordinator.js";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const execute=promisify(execFile);

test("DP01：Windows 安装脚本固定 UTF-8 BOM",async()=>{
  const bytes=await readFile(resolve("node/windows-install.ps1"));
  assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);
});

test("DP01：Windows PowerShell 解析正式安装脚本",{skip:process.platform!=="win32"},async()=>{
  const path=resolve("node/windows-install.ps1").replaceAll("'","''");
  const source=`$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}`;
  const encoded=Buffer.from(source,"utf16le").toString("base64");
  const result=await execute("powershell.exe",["-NoProfile","-EncodedCommand",encoded],{encoding:"utf8",timeout:15000,windowsHide:true});
  assert.equal(result.stderr,"");
});

test("DP05：维护暂停跨进程持久化并可由新协调器正式恢复",async t=>{
  const root=await mkdtemp(join(tmpdir(),"quaymesh-admission-recovery-"));
  const first=new ExecutionCoordinator(root);
  first.pause("deployment");
  assert.equal(first.admissionStatus().accepting,false);
  first.close();
  const second=new ExecutionCoordinator(root);
  t.after(async()=>{second.close();await rm(root,{recursive:true,force:true});});
  assert.equal(second.admissionStatus().accepting,false);
  assert.throws(()=>second.beginWork({kind:"tool"}),/暂不接受/);
  second.resume();
  assert.equal(second.admissionStatus().accepting,true);
  const lease=second.beginWork({kind:"tool"});
  lease.release();
});
