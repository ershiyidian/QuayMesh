import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexActivity, decodeAgentProgress } from "./agent-progress.js";
import { LocalAgentStore } from "./local-agent-store.js";
import { decodeAgentRecord } from "./local-agent-daemon-protocol.js";
import { agentControlState } from "./local-agent-presentation.js";

const commandFixtures = [
  ["adb install artifacts/test-checkin-0802.apk", "command"],
  ["adb pull /sdcard/build/output artifacts/test-checkin", "command"],
  ["echo test build pytest tsc", "command"],
  ["cat artifacts/build/result.txt", "command"],
  ["git diff -- test/build", "command"],
  ["node scripts/test.js", "command"],
  ["bash -lc 'npm test'", "command"],
  ["echo ok && npm test", "command"],
  ["npm --prefix test build", "command"],
  ["go run ./test/build", "command"],
  ["gradle -Pname=assemble tasks", "command"],
  ["unknown test build", "command"],
  ["go test ./...", "test"],
  ["npm test -- --runInBand", "test"],
  ["pnpm run test", "test"],
  ["pytest -q test/unit", "test"],
  ["python3 -m pytest -q", "test"],
  ["./node_modules/.bin/vitest run", "test"],
  ['"C:\\Program Files\\tools\\pytest.exe" -q', "test"],
  ["gradle assemble", "build"],
  ["./gradlew assembleRelease", "build"],
  ["gradlew.bat :app:assembleDebug", "build"],
  ["tsc --noEmit", "build"],
  ["pnpm build", "build"],
  ["npm run build", "build"],
  ["go build ./...", "build"],
] as const;
for (const [command, category] of commandFixtures) test(`command fixture: ${command}`, () => {
  const result = codexActivity("item/started", { item: { type: "commandExecution", command, args: "private-args" } });
  assert.deepEqual(result, { phase: "tool", toolCategory: category });
  assert(!JSON.stringify(result).includes("private-args"));
});

test("trace fixture comparison with the previous whole-command heuristic", () => {
  const legacy = (command: string) => /\b(?:test|vitest|pytest)\b/i.test(command) ? "test"
    : /\b(?:build|assemble\w*|tsc)\b/i.test(command) ? "build" : "command";
  assert.equal(commandFixtures.filter(([command, expected]) => legacy(command) !== expected).length, 12);
  assert.equal(commandFixtures.filter(([command, expected]) => codexActivity("item/started", {
    item: { type: "commandExecution", command },
  })?.toolCategory !== expected).length, 0);
});

test("provider progress drops secrets, ignores usage and bounds persisted/daemon-decoded state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "quaymesh-progress-"));
  let store = new LocalAgentStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const record = store.create({ workspaceId: "ws", workspaceRoot: root, profileName: "codex", provider: "codex" });
  store.update(record.id, { status: "queued" });
  assert.equal(agentControlState(store.getById(record.id)!, "ws").progress.waitingReason, "execution_admission");
  store.update(record.id, { status: "running" });
  const secret = "synthetic-secret-".repeat(10000);
  const activity = codexActivity("item/started", { item: { type: "commandExecution", command: `pnpm build ${secret}`, stdout: secret, reasoning: secret } });
  assert.deepEqual(activity, { phase: "tool", toolCategory: "build" });
  assert.equal(codexActivity("thread/tokenUsage/updated", { item: { type: "reasoning", text: secret } }), undefined);
  assert(activity); store.recordActivityResult(record.id, { ...activity, secret } as typeof activity);
  const before = store.getById(record.id)!;
  for (let i = 0; i < 200; i++) store.recordActivityResult(record.id, activity);
  assert.equal(store.getById(record.id)!.progress!.lastActivityAt, before.progress!.lastActivityAt);
  store.close(); store = new LocalAgentStore(root);
  const restored = decodeAgentRecord({ ...store.getById(record.id), progress: { ...before.progress, stdout: secret } });
  assert.deepEqual(restored.progress, before.progress);
  assert(!JSON.stringify(restored.progress).includes("synthetic-secret"));
  assert(JSON.stringify(restored.progress).length < 512);
  assert.equal(decodeAgentProgress({ ...before.progress, phase: secret }), undefined);
  assert.equal(decodeAgentProgress({ ...before.progress, lastActivityAt: secret }), undefined);
  store.reconcileActiveRuns();
  const reconciled = store.getById(record.id)!;
  assert.equal(reconciled.errorCode, "DAEMON_UNAVAILABLE");
  assert.equal(agentControlState(reconciled, "ws").progress.phase, "finished");
  assert.equal(reconciled.progress!.lastActivityAt, before.progress!.lastActivityAt, "Restart preserves evidence, not a claim that work resumed");
  store.update(record.id, { status: "idle", latestResponse: "durable result" });
  store.close(); store = new LocalAgentStore(root);
  assert.equal(decodeAgentRecord(store.getById(record.id)).latestResponse, "durable result");
});

test("tool categories and completion are hints and cannot include command output or thought text", () => {
  assert.deepEqual(codexActivity("item/started", { item: { type: "commandExecution", command: "pnpm test" } }), { phase: "tool", toolCategory: "test" });
  assert.deepEqual(codexActivity("item/started", { item: { type: "commandExecution", command: "sleep 1" } }), { phase: "tool", toolCategory: "command" });
  assert.deepEqual(codexActivity("item/started", { item: { type: "reasoning", text: "synthetic secret" } }), { phase: "provider" });
  assert.deepEqual(codexActivity("item/completed", { item: { type: "commandExecution", aggregatedOutput: "synthetic secret" } }), { phase: "provider" });
});
