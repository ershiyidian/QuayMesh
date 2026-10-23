import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteReceipts } from "./receipts.js";
import { ConsoleAudit } from "./audit.js";
import { WorkbenchError } from "./types.js";
import { WorkLedger } from "../work-ledger.js";
import { receiptResponsePending } from "../console-receipt-state.js";

test("durable write receipts preserve effect and reconcile an unknown result without replay", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-receipt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipts = new WriteReceipts(directory);
  let applied = 0;
  const original = () => receipts.execute("console:control", "request", "/control", { id: "run" }, () => {
    applied++;
    throw new WorkbenchError("response lost", 503, "peer_unavailable");
  });
  await assert.rejects(original(), /response lost/);
  assert.equal(receipts.get("console:control", "request")?.state, "unknown");
  assert.equal(receipts.get("console:control", "request")?.effect, "unknown");
  await assert.rejects(original(), /response lost/);
  assert.equal(applied, 1);
  const reconciled = await new WriteReceipts(directory).reconcile("console:control", "request", async ({ path, body }) => {
    assert.equal(path, "/control"); assert.deepEqual(body, { id: "run" });
    return { verified: applied === 1, effect: "applied", response: { status: "completed" } };
  });
  assert.equal(reconciled?.state, "completed");
  assert.deepEqual(await original(), { status: "completed" });
  assert.equal(applied, 1);
  await assert.rejects(receipts.execute("console:control", "request", "/control", { id: "another" }, () => null), /操作内容发生变化/);
});

test("precondition rejection is distinct from partial success and surviving started receipts", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-outcomes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipts = new WriteReceipts(directory);
  await assert.rejects(receipts.execute("console:control", "none", "/control", {}, () => {
    throw new WorkbenchError("revision changed", 409, "revision_conflict", "none");
  }));
  assert.equal(receipts.get("console:control", "none")?.state, "rejected");
  await receipts.execute("console:control", "partial", "/control", {}, () => ({ status: "partial", effect: "partial", targets: [{ id: "a", status: "completed" }, { id: "b", status: "unknown" }] }));
  const partial = receipts.get("console:control", "partial");
  assert.equal(partial?.state, "partial"); assert.equal(partial?.effect, "partial");
  const ledger = new WorkLedger(directory);
  ledger.db.prepare("INSERT INTO console_write_receipts(scope,request_key,method,path,arguments_json,state,created_at) VALUES(?,?,'POST',?,'{}','started',?)")
    .run("console:control", "interrupted", "/control", new Date().toISOString());
  ledger.close();
  assert.equal(receipts.get("console:control", "interrupted")?.effect, "unknown");
  const unresolved = await receipts.reconcile("console:control", "interrupted", async () => ({ verified: false }));
  assert.equal(unresolved?.state, "started");
  assert.equal(receipts.list("console:").length, 3);
});

test("accepted and nested pending responses remain queryable until their exact execution is terminal", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-accepted-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipts = new WriteReceipts(directory);
  const pairs = [
    [{ status: "accepted", effect: "applied" }, { status: "completed", effect: "applied" }],
    [{ status: "completed", results: [{ receipt: { targets: [{ status: "accepted" }] } }] },
      { status: "completed", results: [{ receipt: { targets: [{ status: "completed" }] } }] }],
    [{ saved: true, pending: true }, { saved: true, pending: false }],
  ];
  for (const [index, [accepted, terminal]] of pairs.entries()) {
    const key = `request-${index}`;
    let dispatched = 0, verified = 0;
    const original = () => receipts.execute("console:control", key, "/control", { index }, () => { dispatched++; return accepted; });
    await original();
    assert.equal(receipts.get("console:control", key)?.state, "completed", "the request itself has been answered");
    assert.equal(receiptResponsePending(receipts.get("console:control", key)?.response), true);
    const pending = await receipts.reconcile("console:control", key, async () => ({ verified: false }));
    assert.deepEqual(pending?.response, accepted);
    const reconciled = await new WriteReceipts(directory).reconcile("console:control", key, async ({ body }) => {
      verified++; assert.deepEqual(body, { index });
      return { verified: true, effect: "applied", response: terminal };
    });
    assert.equal(reconciled?.state, "completed");
    assert.deepEqual(reconciled?.response, terminal);
    assert.equal(receiptResponsePending(reconciled?.response), false);
    assert.deepEqual(await original(), terminal);
    await receipts.reconcile("console:control", key, async () => { verified++; throw new Error("terminal receipts must remain unchanged"); });
    assert.equal(verified, 1); assert.equal(dispatched, 1);
  }
  assert.equal(receiptResponsePending({ status: "completed", settings: { status: "pending" }, note: "accepted" }), false);
});

test("concurrent receipt queries cannot replace a confirmed terminal result with an older pending observation", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-reconcile-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const receipts = new WriteReceipts(directory);
  await receipts.execute("console:control", "same", "/control", {}, () => ({ status: "accepted" }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const older = receipts.reconcile("console:control", "same", async () => {
    await gate;
    return { verified: true, effect: "applied", response: { status: "accepted" } };
  });
  const terminal = await new WriteReceipts(directory).reconcile("console:control", "same", async () => ({
    verified: true, effect: "applied", response: { status: "completed" },
  }));
  release();
  assert.deepEqual((await older)?.response, terminal?.response);
  assert.deepEqual(receipts.get("console:control", "same")?.response, { status: "completed" });
});

test("audit imports existing entries once and retains more than 250 later actions", t => {
  const directory = mkdtempSync(join(tmpdir(), "qm-console-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "console-workbench-audit.json"), JSON.stringify([{ id: "old", time: 1, nodeId: "local",
    action: "run.review", target: "run", actor: "owner", before: null, after: { verdict: "accept" }, requestKey: "old" }]));
  const audit = new ConsoleAudit(directory, "local");
  for (let index = 0; index < 260; index++) audit.record("run.interrupt", "run", null, { index }, `request-${index}`);
  const entries = new ConsoleAudit(directory, "local").entries();
  assert.equal(entries.length, 261);
  assert.equal(entries.filter(entry => entry.id === "old").length, 1);
  assert.ok(audit.find("run.interrupt", "run", "request-0"));
});
