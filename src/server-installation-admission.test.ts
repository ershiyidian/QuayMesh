import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "./config.js";
import { AdmissionPausedError, ExecutionCoordinator } from "./execution-coordinator.js";
import type { AdmissionPrecondition } from "./admission-state.js";
import { installationTransitionPending } from "./installation-transition.js";
import { createServer } from "./server.js";
import { writeTestQuayMeshConfig } from "./test-support/config.test.js";

const token = "installation-admission-test-cluster-token";

async function fixture(t: TestContext, options: {
  phase?: "validating" | "recovery_required";
  previousReason?: string;
  managed?: boolean;
  expectedPaused: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "qm-installation-admission-"));
  const transition = join(root, "installation-transition.json");
  const previousFile = process.env.QUAYMESH_INSTALL_TRANSITION_FILE;
  const previousToken = process.env.QUAYMESH_CLUSTER_TOKEN;
  let running: ReturnType<typeof createServer> | undefined;
  let http: Server | undefined;
  t.after(async () => {
    try {
      if (http) {
        const closed = new Promise<void>((resolve, reject) => {
          http!.close(error => error ? reject(error) : resolve());
        });
        http.closeIdleConnections();
        await closed;
      }
      await running?.close();
    } finally {
      if (previousFile === undefined) delete process.env.QUAYMESH_INSTALL_TRANSITION_FILE;
      else process.env.QUAYMESH_INSTALL_TRANSITION_FILE = previousFile;
      if (previousToken === undefined) delete process.env.QUAYMESH_CLUSTER_TOKEN;
      else process.env.QUAYMESH_CLUSTER_TOKEN = previousToken;
      await rm(root, { recursive: true, force: true });
    }
  });
  if (options.managed === false) delete process.env.QUAYMESH_INSTALL_TRANSITION_FILE;
  else process.env.QUAYMESH_INSTALL_TRANSITION_FILE = transition;
  process.env.QUAYMESH_CLUSTER_TOKEN = token;
  if (options.phase) await writeFile(transition, JSON.stringify({
    id: "reviewed-installation-attempt", phase: options.phase,
    sourceCommit: "a".repeat(40), previousCommit: "b".repeat(40),
  }));
  const config = loadConfig(writeTestQuayMeshConfig(join(root, "config"), {
    storage: { stateDir: join(root, "core") },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
    subagents: { enabled: false, instructions: "on-demand", providers: [] },
  }));
  if (options.previousReason) {
    const previous = new ExecutionCoordinator(config.stateDir);
    try { previous.pause(options.previousReason); }
    finally { previous.close(); }
  }
  running = createServer({ ...config, console: { enabled: false, allowRemote: false, sessionTtlSeconds: 300 } }, { incomingArtifactAdapters: [], registerProject: async roots => ({
    protocol: "fixture", status: "persisted_registration", roots,
    createdDirectories: [], projectId: "fixture-project", uiStatus: "unverified",
  }) });
  // This assertion happens before any HTTP listener is created: a prior
  // shutdown reason must not briefly open direct Core work during validation.
  assert.equal(running.execution.admissionState().accepting, !options.expectedPaused);
  await running.ready;
  http = running.app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const admission = (body: unknown) => fetch(`${base}/internal/quaymesh/admission`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const idle = () => fetch(`${base}/internal/quaymesh/idle`, { headers: { authorization: `Bearer ${token}` } });
  return { running, transition, admission, idle, base, resume: () => admission({ action: "resume" }) };
}

function condition(state: AdmissionPrecondition): AdmissionPrecondition {
  return { instance: state.instance, accepting: state.accepting, reason: state.reason, changedAt: state.changedAt };
}

test("managed Core holds direct admission through installation validation and recovery", async t => {
  for (const current of [
    { phase: "validating" as const },
    { phase: "validating" as const, previousReason: "服务正在退出" },
    { phase: "recovery_required" as const, previousReason: "服务准备停止" },
  ]) {
    await t.test(`${current.phase}: ${current.previousReason ?? "first install"}`, async nested => {
      const context = await fixture(nested, { ...current, expectedPaused: true });
      assert.throws(() => context.running.execution.beginWork({ kind: "tool" }), AdmissionPausedError);
      const blocked = await context.resume();
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error, "INSTALLATION_VALIDATION_PENDING");
      assert.equal(context.running.execution.admissionState().accepting, false);
      const held = condition(await (await context.idle()).json());
      const conditional = await context.admission({ action: "resume", expected: held });
      assert.equal(conditional.status, 409);
      assert.equal((await conditional.json()).error, "INSTALLATION_VALIDATION_PENDING");
      assert.deepEqual(condition(await (await context.idle()).json()), held);
      // Only the owned installation controller removes its transition after
      // acceptance. A subsequent explicit resume can then reopen admission.
      await rm(context.transition);
      const resumed = await context.admission({ action: "resume", expected: held });
      assert.equal(resumed.status, 200);
      assert.equal((await resumed.json()).accepting, true);
      const work = context.running.execution.beginWork({ kind: "tool" });
      await work.releaseAsync();
    });
  }
});

test("HTTP admission rejects malformed conditions and retired Core instances without changing state", async t => {
  const context = await fixture(t, { managed: false, expectedPaused: false });
  const initial = condition(await (await context.idle()).json());
  assert.equal(initial.instance.pid, process.pid);
  assert.ok(initial.instance.token);
  assert.ok(initial.instance.processStart === null || typeof initial.instance.processStart === "string");
  for (const instance of [
    { ...initial.instance, pid: initial.instance.pid + 1 },
    { ...initial.instance, processStart: "retired-process-start" },
    { ...initial.instance, token: "retired-core-token" },
  ]) {
    const response = await context.admission({ action: "pause", reason: "must-not-pause", expected: { ...initial, instance } });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "ADMISSION_PRECONDITION_FAILED");
    assert.equal(body.conflict, "instance");
    assert.deepEqual(condition(await (await context.idle()).json()), initial);
  }
  for (const expected of [null, {}, { ...initial, accepting: "true" }, { ...initial, instance: undefined }]) {
    const response = await context.admission({ action: "pause", reason: "must-not-pause", expected });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "INVALID_ADMISSION_PRECONDITION");
    assert.deepEqual(condition(await (await context.idle()).json()), initial);
  }
  const unauthenticated = await fetch(`${context.base}/internal/quaymesh/admission`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "pause", reason: "must-not-pause", expected: initial }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(condition(await (await context.idle()).json()), initial);
});

test("concurrent HTTP fences have one winner and stale release cannot clear another owner", async t => {
  const context = await fixture(t, { managed: false, expectedPaused: false });
  const expected = condition(await (await context.idle()).json());
  const alreadyAccepted = context.running.execution.beginWork({ kind: "tool" });
  try {
    const responses = await Promise.all(["first", "second"].map(owner => context.admission({
      action: "pause", reason: `release-preflight:${owner}`, expected,
    })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = responses.find(response => response.status === 200)!;
    const loser = responses.find(response => response.status === 409)!;
    const owned = condition(await winner.json());
    assert.equal((await loser.json()).conflict, "state");
    assert.deepEqual(condition(await (await context.idle()).json()), owned);
    assert.throws(() => context.running.execution.beginWork({ kind: "tool" }), AdmissionPausedError);
    // Closing new admission preserves work accepted before the fence.
    assert.equal(context.running.execution.admissionStatus().activeWork, 1);
    await alreadyAccepted.releaseAsync();
    assert.equal(context.running.execution.admissionStatus().activeWork, 0);

    context.running.execution.pause("release-preflight:another-owner");
    const replacement = condition(await (await context.idle()).json());
    const staleRelease = await context.admission({ action: "resume", expected: owned });
    assert.equal(staleRelease.status, 409);
    assert.equal((await staleRelease.json()).conflict, "state");
    assert.deepEqual(condition(await (await context.idle()).json()), replacement);
    const released = await context.admission({ action: "resume", expected: replacement });
    assert.equal(released.status, 200);
    assert.equal((await released.json()).accepting, true);
    const staleAcquire = await context.admission({ action: "pause", reason: "stale-before-ABA", expected });
    assert.equal(staleAcquire.status, 409);
    assert.equal((await staleAcquire.json()).conflict, "state");

    // Existing managers can still use the legacy API without a condition.
    assert.equal((await context.admission({ action: "pause", reason: "legacy-manager" })).status, 200);
    assert.equal(context.running.execution.admissionState().reason, "legacy-manager");
    assert.equal((await context.resume()).status, 200);
    assert.equal(context.running.execution.admissionState().accepting, true);
  } finally { await alreadyAccepted.releaseAsync(); }
});

test("ordinary Core restart preserves existing admission recovery semantics", async t => {
  for (const current of [
    { managed: false, previousReason: "服务正在退出", expectedPaused: false },
    { managed: true, previousReason: "服务准备停止", expectedPaused: false },
    { managed: false, previousReason: "operator-owned-pause", expectedPaused: true },
  ]) {
    await t.test(`${current.managed ? "managed without transition" : "standalone"}: ${current.previousReason}`, async nested => {
      const context = await fixture(nested, current);
      assert.equal(context.running.execution.admissionState().accepting, !current.expectedPaused);
      if (current.expectedPaused) assert.equal(context.running.execution.admissionState().reason, current.previousReason);
    });
  }
});

test("a dangling transition marker is pending, not proof of completed installation", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qm-transition-marker-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const marker = join(root, "installation-transition.json");
  assert.equal(installationTransitionPending(undefined), false);
  assert.equal(installationTransitionPending(marker), false);
  await symlink(join(root, "missing-target"), marker);
  assert.equal(installationTransitionPending(marker), true);
});
