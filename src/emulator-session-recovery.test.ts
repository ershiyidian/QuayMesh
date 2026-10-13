import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { validateEmulatorIdentity, type EmulatorRecoveryProof } from "./emulator-session-recovery.js";
const proof: EmulatorRecoveryProof={workspaceId:"ws-test",runId:"run-test",claimId:"claim-test",pid:1234,createdAt:"2026-09-06T15:20:43.519Z",serial:"emulator-5554",avd:"medium_phone",sdk:resolve("fixture-sdk")};
const identity={pid:1234,name:"emulator.exe",createdAt:proof.createdAt,executable:resolve(proof.sdk,"emulator/emulator.exe"),matchesAvd:true};
test("only the recorded SDK process and launch boundary can be stopped",()=>{assert.doesNotThrow(()=>validateEmulatorIdentity(proof,identity,"2026-09-06T15:20:42.610Z"));});
test("PID reuse, another AVD and another executable are rejected",()=>{for(const altered of [{...identity,pid:1235},{...identity,createdAt:"2026-09-06T15:21:43Z"},{...identity,matchesAvd:false},{...identity,name:"node.exe"},{...identity,executable:resolve("unrelated.exe")}])assert.throws(()=>validateEmulatorIdentity(proof,altered,"2026-09-06T15:20:42.610Z"));});
test("receipt injection and stale launch ownership are rejected",()=>{assert.throws(()=>validateEmulatorIdentity({...proof,avd:"x;kill"},identity,"2026-09-06T15:20:42.610Z"));assert.throws(()=>validateEmulatorIdentity(proof,identity,"2026-09-06T15:00:00Z"));});
