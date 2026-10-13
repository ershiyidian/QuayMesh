import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { listDescendantPids, stdioDrainDisposition } from "./process-platform.js";

assert.equal(stdioDrainDisposition(null), "reconciliation_required");
assert.equal(stdioDrainDisposition([]), "incomplete_output");
assert.equal(stdioDrainDisposition([12]), "waiting_for_descendants");

const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore", windowsHide: true });
await new Promise((resolve) => child.once("spawn", resolve));
const listed = listDescendantPids(process.pid);
if (!child.pid) throw new Error("child pid missing");
assert.ok(listed, "process table was not readable");
assert.ok(listed.includes(child.pid), `child ${child.pid} missing from ${listed?.slice(0, 20).join(",")}`);
child.kill();
